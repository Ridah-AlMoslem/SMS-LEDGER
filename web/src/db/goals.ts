/**
 * Goal writes — SPEC §11.2.
 *
 * The one rule this file exists to enforce: **the sum of the buckets over an
 * account may not exceed that account's balance.** §11.2 asks for it directly
 * ("Reject or warn on over-allocation"), and the reason it has to be enforced on
 * the write rather than only drawn on the screen is that the alternative is a
 * page that displays a negative unallocated remainder and calls it savings.
 *
 * The check reads `accounts.current_balance`, which is derived from the posted
 * legs and rewritten on every parser tick (§3.3) — so it is the real balance,
 * not a figure this feature maintains. That is also why over-allocation can
 * still *occur* after the fact, without anyone editing a goal: a withdrawal
 * drops the balance below what the goals claim. That case is a warning rather
 * than an error, it is computed by `bucketsFor` in `lib/goals.ts`, and every
 * goal's progress falls in proportion the moment it happens.
 *
 * Takes the db as an argument and imports nothing from `next/*`.
 */

import { eq, sql } from "drizzle-orm";

import { parseAmount } from "../lib/account-edit.ts";
import { type Goal, overAllocationBy } from "../lib/goals.ts";
import type { CivilDate } from "../lib/periods.ts";
import { money } from "../lib/accounts.ts";
import type { Db, Result } from "./ledger-mutations.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- see ledger-mutations.ts. */

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

function normalise(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type GoalInput = {
  /** Absent creates; present updates. */
  id?: string;
  name: string;
  targetAmount: string | number;
  targetDate: CivilDate | null;
  accountId: string;
  allocation: string | number;
};

/**
 * Create or update one goal.
 *
 * Refuses three things, each with a sentence rather than a constraint
 * violation:
 *
 *   - A goal over a **liability**. On a credit card the stored figure is
 *     available credit, not money you have (§3.3a) — a "savings goal" reading
 *     that as progress would fill up as the card was spent.
 *   - An **over-allocation**, with the excess named.
 *   - A target of zero or less, which has no progress to make.
 */
export async function saveGoal(
  db: Db,
  input: GoalInput,
): Promise<Result<{ id: string; allocation: string }>> {
  const name = input.name.trim();
  if (!name) return fail("A goal needs a name.");

  const targetHalalas = parseAmount(input.targetAmount);
  if (targetHalalas === null) return fail("A target must be an amount, like 20000.");
  if (targetHalalas <= 0) return fail("A target must be more than zero.");

  const allocationHalalas = parseAmount(input.allocation);
  if (allocationHalalas === null) return fail("An allocation must be an amount, like 5000.");
  if (allocationHalalas < 0) return fail("An allocation cannot be negative.");

  if (input.targetDate !== null && !ISO.test(input.targetDate)) {
    return fail("A target date must be a real date.");
  }

  const targetAmount = (targetHalalas / 100).toFixed(2);
  const allocation = (allocationHalalas / 100).toFixed(2);

  return db.transaction(async (tx: any) => {
    const [account] = normalise(
      await tx
        .select({
          id: schema.accounts.id,
          name: schema.accounts.name,
          balance: schema.accounts.currentBalance,
          isLiability: schema.accounts.isLiability,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.accountId)),
    );

    if (!account) return fail("That account no longer exists.");
    if (account.isLiability) {
      return fail(
        `${account.name} is a liability — its balance is what you owe or can still borrow, ` +
          "not money set aside. Link the goal to the account actually holding the savings.",
      );
    }

    // Every goal already on this account, so the sum can be checked. Read
    // inside the transaction: two saves racing would otherwise each see the
    // other's absence and both fit.
    const siblings: Goal[] = normalise(
      await tx
        .select({
          id: schema.goals.id,
          name: schema.goals.name,
          targetAmount: schema.goals.targetAmount,
          targetDate: schema.goals.targetDate,
          accountId: schema.goals.linkedAccountId,
          allocation: schema.goals.allocation,
        })
        .from(schema.goals)
        .where(eq(schema.goals.linkedAccountId, input.accountId)),
    ).map((g: any) => ({
      id: String(g.id),
      name: String(g.name),
      targetAmount: Number(g.targetAmount),
      targetDate: g.targetDate === null ? null : String(g.targetDate),
      accountId: g.accountId === null ? null : String(g.accountId),
      allocation: Number(g.allocation),
    }));

    const balance = Number(account.balance);
    const excess = overAllocationBy(siblings, {
      accountId: input.accountId,
      allocation: allocationHalalas / 100,
      balance,
      goalId: input.id,
    });

    if (excess !== null) {
      return fail(
        `That would allocate ${money(excess)} more than ${account.name} holds. ` +
          `The account has ${money(balance)}; reduce the allocation or move money in first.`,
      );
    }

    const values = {
      name,
      targetAmount,
      targetDate: input.targetDate,
      linkedAccountId: input.accountId,
      allocation,
    };

    if (input.id) {
      const updated = normalise(
        await tx
          .update(schema.goals)
          .set(values)
          .where(eq(schema.goals.id, input.id))
          .returning({ id: schema.goals.id }),
      );
      if (updated.length === 0) return fail("That goal no longer exists.");
      return ok({ id: input.id, allocation });
    }

    const [created] = normalise(
      await tx.insert(schema.goals).values(values).returning({ id: schema.goals.id }),
    );

    return ok({ id: String(created.id), allocation });
  });
}

export async function deleteGoal(db: Db, input: { id: string }): Promise<Result<{ id: string }>> {
  return db.transaction(async (tx: any) => {
    const removed = normalise(
      await tx
        .delete(schema.goals)
        .where(eq(schema.goals.id, input.id))
        .returning({ id: schema.goals.id }),
    );

    if (removed.length === 0) return fail("That goal no longer exists.");
    return ok({ id: input.id });
  });
}

/**
 * The balances every goal is measured against, read as one statement.
 *
 * Exists so the verification script can assert the thing §11.2 actually
 * promises — that goal progress follows the account — against the same column
 * the page reads, after running the parser's own recompute over an edited
 * ledger.
 */
export async function goalBalances(db: Db): Promise<Map<string, number>> {
  return db.transaction(async (tx: any) => {
    const rows = normalise(
      await tx.execute(sql`
        SELECT a.id, a.current_balance
          FROM accounts a
         WHERE EXISTS (SELECT 1 FROM goals g WHERE g.linked_account_id = a.id)
      `),
    );

    return new Map<string, number>(
      rows.map((r: any) => [String(r.id), Number(r.current_balance)]),
    );
  });
}
