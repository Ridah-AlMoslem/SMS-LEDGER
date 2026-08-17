/**
 * Every write Plan's budget rows can make, plus the cycle close behind them.
 * SPEC §11.2.
 *
 * Kept out of the server actions so `npm run test:budgets` can run them against
 * real Postgres, for the same reason `db/ledger-mutations.ts` is: the guarantee
 * that matters here is not one a unit test can reach.
 *
 *   §11.2 — "Carry is stored per cycle when the cycle closes, not recomputed
 *   from the beginning of time, so a single corrected old transaction can't
 *   cascade through years of budgets."
 *
 * That sentence is the whole design of this file. `closeCycle` runs once per
 * cycle boundary, computes `carry(c+1) = effective_budget(c) − spent(c)` with
 * `carryForward` from `lib/pace.ts`, writes it to `budgets.carry_in`, and stamps
 * `carry_closed_at`. Every later run — a second tick the same night, a replay, a
 * correction landing three cycles late — sees the stamp and leaves the figure
 * alone. There is deliberately no code path that recomputes a settled carry:
 * "reset carry" sets it to zero (§11.2's escape hatch for a carry that has
 * drifted so far negative it stops being informative), and that is the only way
 * it ever moves again.
 *
 * The arithmetic itself lives in `lib/pace.ts`, not in SQL. A `CASE WHEN
 * rollover THEN ...` in this file's INSERT would be a second definition of the
 * rollover rule, and the two would disagree the first time either was touched.
 *
 * Takes the db as an argument and imports nothing from `next/*`, so the tested
 * path and the shipped path are the same function.
 */

import { and, eq, sql } from "drizzle-orm";

import { parseAmount } from "../lib/account-edit.ts";
import { type CycleBudget, carryForward } from "../lib/pace.ts";
import { type CivilDate, addMonths, diffDays, periodEnd, periodStart } from "../lib/periods.ts";
import type { Db, Result } from "./ledger-mutations.ts";
import { IS_EXPENSE_SQL } from "./predicates.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- see ledger-mutations.ts:
 * the transaction handle is structural so the tested path and the shipped path
 * are the same code across two drivers. */

/**
 * §6's expense rule, as the app runs it.
 *
 * Taken from `db/predicates.ts` rather than retyped, and wrapped here rather
 * than imported from `db/aggregates.ts` because that module reaches for
 * `getDb()` — which would drag a live postgres client into a test that supplies
 * its own database. Same text, same clauses, no client.
 */
const IS_EXPENSE = sql.raw(IS_EXPENSE_SQL);

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

/** postgres-js returns rows directly; PGlite returns `{rows}`. One shape out. */
function normalise(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/** NUMERIC(14,2) as the database will hold it, so `"120"` and `"120.00"` stop
 *  registering as a change to a budget nobody touched. */
function stored(input: string | number): string | null {
  const halalas = parseAmount(input);
  return halalas === null ? null : (halalas / 100).toFixed(2);
}

/**
 * §4 — `cycle_start` is always the 25th that opens the cycle, never a calendar
 * month. The database has a check constraint for it; this turns the resulting
 * error into a sentence, and normalises an anchor that is merely inside the
 * cycle rather than at its start.
 */
function anchor(cycleStart: CivilDate): CivilDate {
  return periodStart(cycleStart);
}

/* ------------------------------------------------------------ the base amount */

export type SetBudgetInput = {
  categoryId: string;
  cycleStart: CivilDate;
  /** null removes the budget for this category and cycle. A category with no
   *  budget is a real state — it paces against nothing and says so — and is
   *  different from a budget of zero, which is a decision to spend nothing. */
  amount: string | number | null;
};

export async function setBudget(
  db: Db,
  input: SetBudgetInput,
): Promise<Result<{ categoryId: string; cycleStart: CivilDate; amount: string | null }>> {
  const cycleStart = anchor(input.cycleStart);

  return db.transaction(async (tx: any) => {
    if (input.amount === null) {
      await tx
        .delete(schema.budgets)
        .where(
          and(
            eq(schema.budgets.categoryId, input.categoryId),
            eq(schema.budgets.cycleStart, cycleStart),
          ),
        );
      return ok({ categoryId: input.categoryId, cycleStart, amount: null });
    }

    const amount = stored(input.amount);
    if (amount === null) return fail("A budget must be an amount, like 1500 or 1500.00.");
    if (Number(amount) < 0) return fail("A budget cannot be negative.");

    // The carry is untouched on purpose. Editing this cycle's base does not
    // re-open what last cycle concluded — that is what `carry_closed_at` means,
    // and re-deriving it here would reintroduce the cascade from the other end.
    await tx
      .insert(schema.budgets)
      .values({ categoryId: input.categoryId, cycleStart, amount })
      .onConflictDoUpdate({
        target: [schema.budgets.categoryId, schema.budgets.cycleStart],
        set: { amount },
      });

    return ok({ categoryId: input.categoryId, cycleStart, amount });
  });
}

/* ---------------------------------------------------------------- rollover */

export async function setRollover(
  db: Db,
  input: { categoryId: string; cycleStart: CivilDate; rollover: boolean },
): Promise<Result<{ rollover: boolean }>> {
  const cycleStart = anchor(input.cycleStart);

  return db.transaction(async (tx: any) => {
    const updated = await tx
      .update(schema.budgets)
      .set({ rollover: input.rollover })
      .where(
        and(
          eq(schema.budgets.categoryId, input.categoryId),
          eq(schema.budgets.cycleStart, cycleStart),
        ),
      )
      .returning({ id: schema.budgets.id });

    if (normalise(updated).length === 0) {
      return fail("Set a budget for this category before turning rollover on.");
    }

    return ok({ rollover: input.rollover });
  });
}

/* ------------------------------------------------------------- reset carry */

/**
 * §11.2 — "offer a one-click **reset carry** for when a category has drifted so
 * far negative it's no longer informative."
 *
 * Stamps `carry_closed_at` as well as zeroing the figure, so the close job
 * treats the reset as settled and does not helpfully put the drift back on the
 * next boundary.
 */
export async function resetCarry(
  db: Db,
  input: { categoryId: string; cycleStart: CivilDate },
): Promise<Result<{ carryIn: number }>> {
  const cycleStart = anchor(input.cycleStart);

  return db.transaction(async (tx: any) => {
    const updated = await tx
      .update(schema.budgets)
      .set({ carryIn: "0", carryClosedAt: new Date() })
      .where(
        and(
          eq(schema.budgets.categoryId, input.categoryId),
          eq(schema.budgets.cycleStart, cycleStart),
        ),
      )
      .returning({ id: schema.budgets.id });

    if (normalise(updated).length === 0) return fail("There is no budget here to reset.");
    return ok({ carryIn: 0 });
  });
}

/* -------------------------------------------------------- closing a cycle */

export type CloseOutcome = {
  /** The cycle that closed. */
  cycle: CivilDate;
  /** The cycle its carry was written into. */
  into: CivilDate;
  /** Rows whose carry was written. */
  carried: number;
  /** Rows skipped because their carry was already settled. */
  settled: number;
};

/**
 * Fold one closed cycle's outcome into the next cycle's allowance (§11.2).
 *
 * Runs from the nightly tick (`app/api/plan-tick/route.ts`). Three properties,
 * each of which is a test in `verify-budgets.mjs`:
 *
 *   - **Overspend produces a negative carry.** `carryForward` is signed;
 *     nothing clamps it. Underspending raises next cycle's allowance and
 *     overspending lowers it, which is the honest version and is what makes
 *     saving across cycles work without a separate feature.
 *   - **It is idempotent.** `carry_closed_at` is stamped on write and checked on
 *     every subsequent run, so a tick that fires twice in one night, or a
 *     re-deploy that replays it, changes nothing.
 *   - **A late correction does not cascade.** Correcting a transaction two
 *     cycles back changes `spent(c−2)`, but `carry(c−1)` was settled when c−2
 *     closed and `carry(c)` when c−1 closed. Neither is recomputed, so the
 *     budget on screen today does not move.
 *
 * Refuses to close a cycle that has not ended: the carry would be computed from
 * partial spending and then settled against being fixed, which is worse than
 * not having run at all.
 */
export async function closeCycle(
  db: Db,
  input: { cycle: CivilDate; now: CivilDate },
): Promise<Result<CloseOutcome>> {
  const cycle = anchor(input.cycle);
  const into = addMonths(cycle, 1);

  if (diffDays(periodEnd(cycle), input.now) <= 0) {
    return fail(`The cycle opening ${cycle} has not ended yet — nothing to close.`);
  }

  return db.transaction(async (tx: any) => {
    const budgets = normalise(
      await tx
        .select({
          categoryId: schema.budgets.categoryId,
          amount: schema.budgets.amount,
          rollover: schema.budgets.rollover,
          carryIn: schema.budgets.carryIn,
        })
        .from(schema.budgets)
        .where(eq(schema.budgets.cycleStart, cycle)),
    );

    if (budgets.length === 0) {
      return ok({ cycle, into, carried: 0, settled: 0 });
    }

    // Spend for the closing cycle, through the view and the shared §6 predicate
    // — the same numbers the screen showed while the cycle was open. A
    // hand-written expense filter here would let the carry disagree with the
    // pace bar it came from.
    const spendRows = normalise(
      await tx.execute(sql`
        SELECT category_id, sum(amount) AS total
          FROM v_categorized_amounts
         WHERE cycle_start = ${cycle}::date
           AND ${IS_EXPENSE}
           AND category_id IS NOT NULL
         GROUP BY 1
      `),
    );

    const spent = new Map<string, number>(
      spendRows.map((r: any) => [String(r.category_id), Number(r.total)]),
    );

    let carried = 0;
    let settled = 0;

    for (const b of budgets) {
      const closing: CycleBudget = {
        cycleStart: cycle,
        base: Number(b.amount),
        carryIn: Number(b.carryIn),
        rollover: Boolean(b.rollover),
        spent: spent.get(String(b.categoryId)) ?? 0,
      };

      const carry = carryForward(closing).toFixed(2);

      // The base is carried forward too, so a budget survives the cycle
      // boundary. A budget that silently vanished every 25th would make
      // rollover the only way to keep one, which inverts the SPEC's "optional".
      //
      // Sequential, not a Promise.all: these run on one pooled connection
      // inside one transaction, and a fan-out there is the stall the whole
      // codebase is arranged around (see `db/index.ts`).
      const written = normalise(
        await tx
          .insert(schema.budgets)
          .values({
            categoryId: b.categoryId,
            cycleStart: into,
            amount: b.amount,
            rollover: b.rollover,
            carryIn: carry,
            carryClosedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [schema.budgets.categoryId, schema.budgets.cycleStart],
            set: { carryIn: carry, carryClosedAt: new Date() },
            // What makes the whole thing write-once. An already-settled carry
            // is not a figure to be improved; it is last cycle's conclusion.
            setWhere: sql`${schema.budgets.carryClosedAt} IS NULL`,
          })
          .returning({ id: schema.budgets.id }),
      );

      if (written.length > 0) carried++;
      else settled++;
    }

    return ok({ cycle, into, carried, settled });
  });
}

/**
 * Every cycle that has ended but whose successor never received its carry.
 *
 * The tick calls this rather than assuming it runs every night: a project that
 * was asleep for two cycles — Supabase pauses free projects after 7 days idle —
 * must not skip a boundary, because the skipped carry would never be written by
 * anything. Bounded by `limit` so a database that has been quiet for a year
 * catches up over a few nights instead of in one enormous transaction.
 */
export async function unclosedCycles(
  db: Db,
  input: { now: CivilDate; limit?: number },
): Promise<CivilDate[]> {
  const limit = input.limit ?? 6;

  return db.transaction(async (tx: any) => {
    const rows = normalise(
      await tx.execute(sql`
        SELECT DISTINCT cycle_start::text AS cycle_start
          FROM budgets
         WHERE cycle_start < period_start(${input.now}::date)
         ORDER BY 1
      `),
    );

    const open: CivilDate[] = [];

    for (const r of rows) {
      const cycle: CivilDate = String(r.cycle_start);
      const next = addMonths(cycle, 1);

      const closed = normalise(
        await tx.execute(sql`
          SELECT 1
            FROM budgets
           WHERE cycle_start = ${next}::date
             AND carry_closed_at IS NOT NULL
           LIMIT 1
        `),
      );

      if (closed.length === 0) open.push(cycle);
      if (open.length >= limit) break;
    }

    return open;
  });
}
