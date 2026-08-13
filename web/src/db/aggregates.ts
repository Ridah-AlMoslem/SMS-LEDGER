/**
 * Period aggregates, read through `v_categorized_amounts` (SPEC §6, §9.6).
 *
 * §9.6 forbids aggregating over `transactions` directly: a query that forgets
 * `transaction_splits` either double-counts split transactions or drops them,
 * and both produce a number that looks entirely reasonable. Everything here
 * goes through the view, which emits one row per (transaction, category,
 * amount) and carries its own cycle and week columns.
 *
 * Filtering is by bucket equality (`cycle_start = $1`), never by a date range
 * over `posted_at`. The view already did the timezone and anchor work; a
 * BETWEEN here would re-derive it in UTC and quietly disagree with the index.
 */

import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import type { CivilDate, Grain } from "@/lib/periods";

export type PeriodTotals = {
  /** §6 — debits that are genuinely money leaving. */
  expense: number;
  /** §6 — earned plus passive. Profit is not optional; see below. */
  income: number;
  earned: number;
  passive: number;
  /** §11.2 — a first-class category. Hiding it makes everything else wrong. */
  uncategorized: number;
  uncategorizedCount: number;
  transactions: number;
};

const ZERO: PeriodTotals = {
  expense: 0,
  income: 0,
  earned: 0,
  passive: 0,
  uncategorized: 0,
  uncategorizedCount: 0,
  transactions: 0,
};

export async function periodTotals(grain: Grain, period: CivilDate): Promise<PeriodTotals> {
  // Column name, not a value — the two grains are separate columns on the view
  // and `grain` is a closed union, so there is nothing user-supplied here.
  const bucket = grain === "cycle" ? sql`cycle_start` : sql`week_start`;

  const rows = await getDb().execute<{
    expense: string;
    earned: string;
    passive: string;
    uncategorized: string;
    uncategorized_count: number;
    transactions: number;
  }>(sql`
    SELECT
      -- §6: excludes internal transfers (moving your own money is not an
      -- expense), card payments (the purchase was already counted, and
      -- counting both inflates spending up to 2x) and loan payments (only the
      -- interest portion is expense; the principal moves net worth).
      COALESCE(sum(amount) FILTER (
        WHERE direction = 'debit'
          AND NOT is_internal_transfer
          AND type NOT IN ('card_payment', 'loan_payment')
          AND NOT excluded_from_analytics
          AND state <> 'declined'), 0) AS expense,

      COALESCE(sum(amount) FILTER (
        WHERE direction = 'credit' AND type = 'income'
          AND NOT is_internal_transfer AND NOT excluded_from_analytics), 0) AS earned,

      -- Profit is stored as type='profit' by the writer, but §6 is explicit
      -- that it counts as income: "Exclude it and the master invariant below
      -- breaks, because net worth rose by money that never appeared in your
      -- income figure." Cashback accrual lands here too.
      COALESCE(sum(amount) FILTER (
        WHERE direction = 'credit' AND type = 'profit'
          AND NOT is_internal_transfer AND NOT excluded_from_analytics), 0) AS passive,

      COALESCE(sum(amount) FILTER (
        WHERE category_id IS NULL AND direction = 'debit'
          AND NOT is_internal_transfer
          AND type NOT IN ('card_payment', 'loan_payment')
          AND NOT excluded_from_analytics), 0) AS uncategorized,

      count(*) FILTER (WHERE category_id IS NULL AND direction = 'debit'
                         AND NOT is_internal_transfer)::int AS uncategorized_count,

      count(DISTINCT transaction_id)::int AS transactions
    FROM v_categorized_amounts
    WHERE ${bucket} = ${period}::date
  `);

  const r = rows[0];
  if (!r) return ZERO;

  // Everything is coerced explicitly. `db.execute()` runs raw SQL and does not
  // apply Drizzle's column mappers, so what comes back is whatever the driver
  // decided: postgres-js parses NUMERIC to string and int4 to number, but that
  // is a driver contract, not ours. A count that arrives as "2" compares
  // `"2" > 0` correctly and `"2" + 1` catastrophically.
  const earned = Number(r.earned);
  const passive = Number(r.passive);

  return {
    expense: Number(r.expense),
    income: earned + passive,
    earned,
    passive,
    uncategorized: Number(r.uncategorized),
    uncategorizedCount: Number(r.uncategorized_count),
    transactions: Number(r.transactions),
  };
}

export type LedgerRow = {
  id: string;
  postedAt: Date;
  amount: string;
  direction: string;
  type: string;
  merchant: string | null;
  biller: string | null;
  isInternal: boolean;
  accountName: string;
  categoryName: string | null;
};

/**
 * The transactions in one period, newest first.
 *
 * Joined back from the view so the bucket filter is the same one the totals
 * use — a list and a total on the same screen disagreeing about which
 * transactions are "this month" is the exact failure §5.1 warns about.
 * DISTINCT because a split transaction has several rows in the view and is
 * still one line in the ledger.
 */
export async function periodTransactions(
  grain: Grain,
  period: CivilDate,
  limit = 200,
): Promise<LedgerRow[]> {
  const bucket = grain === "cycle" ? sql`v.cycle_start` : sql`v.week_start`;

  const rows = await getDb().execute<{
    id: string;
    posted_at: string;
    amount: string;
    direction: string;
    type: string;
    merchant_raw: string | null;
    biller: string | null;
    is_internal_transfer: boolean;
    account_name: string;
    category_name: string | null;
  }>(sql`
    SELECT DISTINCT ON (t.posted_at, t.id)
           t.id, t.amount, t.direction, t.type,
           -- Formatted rather than selected raw. A raw execute() skips
           -- Drizzle's column mappers, so a timestamptz arrives as whatever
           -- the driver makes of it — a Date under postgres-js, a bare string
           -- under others — and parsing a Postgres text timestamp with the
           -- Date constructor is implementation-defined. UTC ISO-8601 is not.
           to_char(t.posted_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS posted_at,
           t.merchant_raw, t.biller, t.is_internal_transfer,
           a.name AS account_name,
           CASE WHEN count(*) OVER (PARTITION BY t.id) > 1 THEN 'Split'
                ELSE c.name END AS category_name
      FROM v_categorized_amounts v
      JOIN transactions t ON t.id = v.transaction_id
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories c ON c.id = v.category_id
     WHERE ${bucket} = ${period}::date
     ORDER BY t.posted_at DESC, t.id
     LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    postedAt: new Date(r.posted_at),
    amount: r.amount,
    direction: r.direction,
    type: r.type,
    merchant: r.merchant_raw,
    biller: r.biller,
    isInternal: r.is_internal_transfer,
    accountName: r.account_name,
    categoryName: r.category_name,
  }));
}
