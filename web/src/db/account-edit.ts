/**
 * Applying a hand edit to an account, as one database transaction.
 *
 * Kept out of the server action so it can be run against a real Postgres by
 * `npm run test:account-edit` — the invariant that matters here is one no unit
 * test can reach: after the edit, the parser's own
 * `opening_balance + Σ(posted legs)` must still produce the balance that was
 * typed. If it does not, the next tick silently reverts the edit, and the only
 * symptom is a number that goes back to being wrong overnight.
 *
 * Takes the db as an argument rather than calling `getDb()` for the same
 * reason. Nothing here imports from `next/*`.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  type AccountDraft,
  type AccountState,
  type Change,
  adjustmentFor,
  diff,
  isLiabilityFor,
  normalise,
  parseAmount,
  validate,
} from "../lib/account-edit.ts";
import type { getDb } from "./index.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- the transaction handle
 * is deliberately structural. The app runs on postgres-js and the test runs the
 * same function on PGlite, and drizzle gives those two different (very large)
 * database types; naming either one here would mean the tested path and the
 * shipped path are not the same function. Every query below is still typed by
 * the schema it names. */

/** Structurally what `drizzle()` returns, for either driver. */
type Db = { transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };

/** The app's own client, for the read that only ever runs there. */
type AppDb = ReturnType<typeof getDb>;

export type EditInput = {
  accountId: string;
  draft: AccountDraft;
  /** The balance as the person typed it, or null to leave it alone. */
  targetBalance: string | null;
  note: string | null;
  /** Injectable so a test can post at a known instant. */
  at?: Date;
};

export type EditOutcome = {
  changed: Record<string, Change>;
  adjustment: { id: string; direction: "credit" | "debit"; amount: string } | null;
};

export type EditResult = { ok: true; outcome: EditOutcome } | { ok: false; error: string };

export async function applyAccountEdit(db: Db, input: EditInput): Promise<EditResult> {
  const draft = normalise(input.draft);
  const target = input.targetBalance === null ? null : input.targetBalance.trim() || null;

  const invalid = validate(draft, target);
  if (invalid) return { ok: false, error: invalid };

  return db.transaction(async (tx: any): Promise<EditResult> => {
    // FOR UPDATE, because the delta is computed from the balance read one
    // statement earlier. Two saves racing without the lock both subtract from
    // the same stale figure and book one correction twice.
    const [before] = (await tx
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        type: schema.accounts.type,
        isLiability: schema.accounts.isLiability,
        balanceSemantics: schema.accounts.balanceSemantics,
        reconcilable: schema.accounts.reconcilable,
        currentBalance: schema.accounts.currentBalance,
        creditLimit: schema.accounts.creditLimit,
        statementDay: schema.accounts.statementDay,
        dueDay: schema.accounts.dueDay,
        isProfitBearing: schema.accounts.isProfitBearing,
        profitPayoutDay: schema.accounts.profitPayoutDay,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.accountId))
      .for("update")) as (AccountState & { id: string })[];

    if (!before) return { ok: false, error: "That account no longer exists." };

    const at = input.at ?? new Date();

    // §4 — derived from the type, never typed in alongside it.
    const isLiability = isLiabilityFor(draft.type);

    // Stored at the column's own scale, so `"14000"` and `"14000.00"` are the
    // same limit and the diff below stops reporting a change that isn't one.
    const creditLimit =
      draft.creditLimit === null ? null : formatStored(draft.creditLimit);

    const adjustment =
      target === null ? null : adjustmentFor(before.currentBalance, target, draft.balanceSemantics);

    const after: AccountState = {
      ...draft,
      creditLimit,
      isLiability,
      currentBalance: adjustment === null ? before.currentBalance : formatStored(target!),
    };

    const changed = diff(before, after);
    const nothingChanged = Object.keys(changed).length === 0 && adjustment === null;
    if (nothingChanged) return { ok: true, outcome: { changed, adjustment: null } };

    let adjustmentId: string | null = null;

    if (adjustment) {
      const [leg] = (await tx
        .insert(schema.transactions)
        .values({
          accountId: before.id,
          postedAt: at,
          amount: adjustment.amount,
          direction: adjustment.direction,
          type: "adjustment",
          state: "posted",
          description: adjustment.description,
          notes: input.note,
          // §9.4 — replay must never touch this leg. It is the only record of
          // the difference, and re-deriving it from messages is impossible by
          // definition: it exists because the messages did not add up.
          origin: "manual",
          // A correction is neither spending nor income. Booking it as either
          // inflates one side of the savings rate (§6) with money that never
          // moved.
          excludedFromAnalytics: true,
          isReviewed: true,
        })
        .returning({ id: schema.transactions.id })) as { id: string }[];

      adjustmentId = leg.id;

      // §3.3b compensating control 3 — the manual balance entry, so an account
      // whose bank never states a balance has a verified point to reconcile
      // forward from. Source 'manual' keeps it out of `reconcile()`, which
      // compares against what the BANK said; treating our own figure as the
      // bank's would let a typo close a real drift alert.
      await tx.insert(schema.balanceSnapshots).values({
        accountId: before.id,
        balance: after.currentBalance,
        source: "manual",
        asOf: at,
      });
    }

    await tx
      .update(schema.accounts)
      .set({
        name: after.name,
        type: after.type as typeof schema.accounts.$inferInsert.type,
        isLiability,
        balanceSemantics:
          after.balanceSemantics as typeof schema.accounts.$inferInsert.balanceSemantics,
        reconcilable: after.reconcilable,
        creditLimit,
        statementDay: after.statementDay,
        dueDay: after.dueDay,
        isProfitBearing: after.isProfitBearing,
        profitPayoutDay: after.profitPayoutDay,
        // Set here as well as booked, so the screen is right immediately rather
        // than at the next tick. The figure is not a second opinion: it is
        // exactly what recompute_balances arrives at, because the leg above is
        // part of the sum it computes.
        ...(adjustment ? { currentBalance: after.currentBalance, balanceAsOf: at } : {}),
      })
      .where(eq(schema.accounts.id, before.id));

    await tx.insert(schema.accountEdits).values({
      accountId: before.id,
      changed,
      note: input.note,
      adjustmentTransactionId: adjustmentId,
    });

    // A hand-entered balance is a claim that the account is now correct, so a
    // drift alert raised against the old figure has been answered — by this
    // edit rather than by a late message. Left open it would keep accusing an
    // account that is no longer wrong.
    if (adjustment) {
      await tx
        .update(schema.reconciliationAlerts)
        .set({ resolvedAt: at, resolutionNote: "balance corrected by hand" })
        .where(
          and(
            eq(schema.reconciliationAlerts.accountId, before.id),
            isNull(schema.reconciliationAlerts.resolvedAt),
          ),
        );
    }

    return {
      ok: true,
      outcome: {
        changed,
        adjustment: adjustmentId
          ? { id: adjustmentId, direction: adjustment!.direction, amount: adjustment!.amount }
          : null,
      },
    };
  });
}

/** NUMERIC(14,2) as the database will hold it. */
function formatStored(amount: string): string {
  const halalas = parseAmount(amount);
  return halalas === null ? amount : (halalas / 100).toFixed(2);
}

/** The last few edits per account, for the sheet's history list. */
export async function recentEdits(db: AppDb, perAccount = 5) {
  return db.execute<{
    id: string;
    account_id: string;
    changed: Record<string, Change>;
    note: string | null;
    adjustment_transaction_id: string | null;
    created_at: string;
  }>(sql`
    SELECT id, account_id, changed, note, adjustment_transaction_id,
           to_char(created_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM (
        SELECT *, row_number() OVER (PARTITION BY account_id
                                     ORDER BY created_at DESC, id) AS rank
          FROM account_edits
      ) ranked
     WHERE rank <= ${perAccount}
     ORDER BY created_at DESC
  `);
}
