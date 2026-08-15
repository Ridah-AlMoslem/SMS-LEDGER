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
import {
  IS_EARNED_SQL,
  IS_EXPENSE_SQL,
  IS_PASSIVE_SQL,
  IS_UNCATEGORIZED_SQL,
} from "@/db/predicates";
import type { CivilDate, Grain } from "@/lib/periods";

/**
 * §6, as one predicate each. Every chart, total and drill-through filters with
 * these — never with a hand-written copy.
 *
 * The rules are short enough to retype and that is exactly the danger: §6's
 * worked example overstates expense by nearly 7× when a single clause is
 * dropped, and the wrong figure is entirely plausible. One chart quietly
 * disagreeing with the total above it is the failure this prevents.
 *
 * The text lives in `db/predicates.ts` so the verification scripts — which run
 * raw SQL against PGlite and cannot import a database client — assert the same
 * clauses the app runs rather than a copy of them.
 */
export const IS_EXPENSE = sql.raw(IS_EXPENSE_SQL);
export const IS_EARNED = sql.raw(IS_EARNED_SQL);
export const IS_PASSIVE = sql.raw(IS_PASSIVE_SQL);
export const IS_UNCATEGORIZED = sql.raw(IS_UNCATEGORIZED_SQL);

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

/**
 * The totals for one bucket, as a fragment rather than a query.
 *
 * Home embeds this twice — once for the selected grain, once for the enclosing
 * cycle — inside a single combined statement, because the database is a region
 * away and every extra round trip is ~300ms of blank screen. Exported as SQL so
 * there is still exactly one definition of what the totals are.
 */
export function periodTotalsQuery(grain: Grain, period: CivilDate) {
  // Column name, not a value — the two grains are separate columns on the view
  // and `grain` is a closed union, so there is nothing user-supplied here.
  const bucket = grain === "cycle" ? sql`cycle_start` : sql`week_start`;

  return sql`
    SELECT
      COALESCE(sum(amount) FILTER (WHERE ${IS_EXPENSE}), 0)        AS expense,
      COALESCE(sum(amount) FILTER (WHERE ${IS_EARNED}), 0)         AS earned,
      COALESCE(sum(amount) FILTER (WHERE ${IS_PASSIVE}), 0)        AS passive,
      COALESCE(sum(amount) FILTER (WHERE ${IS_UNCATEGORIZED}), 0)  AS uncategorized,
      count(*) FILTER (WHERE ${IS_UNCATEGORIZED})::int             AS uncategorized_count,
      count(DISTINCT transaction_id)::int                          AS transactions
    FROM v_categorized_amounts
    WHERE ${bucket} = ${period}::date
  `;
}

export type PeriodTotalsRow = {
  expense: string | number;
  earned: string | number;
  passive: string | number;
  uncategorized: string | number;
  uncategorized_count: string | number;
  transactions: string | number;
};

/**
 * Everything is coerced explicitly. `db.execute()` runs raw SQL and does not
 * apply Drizzle's column mappers, so what comes back is whatever the driver
 * decided: postgres-js parses NUMERIC to string, PGlite to a number, and JSON
 * aggregation to a number again. A count that arrives as "2" compares
 * `"2" > 0` correctly and `"2" + 1` catastrophically.
 */
export function toPeriodTotals(r: PeriodTotalsRow | undefined): PeriodTotals {
  if (!r) return ZERO;

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

export async function periodTotals(grain: Grain, period: CivilDate): Promise<PeriodTotals> {
  const rows = await getDb().execute<PeriodTotalsRow>(periodTotalsQuery(grain, period));
  return toPeriodTotals(rows[0]);
}

export type LedgerRow = {
  id: string;
  postedAt: Date;
  amount: string;
  direction: string;
  type: string;
  merchant: string | null;
  biller: string | null;
  /** Set on rows that were not parsed from a message — a hand-booked balance
   *  adjustment says what it is here, since it has no merchant to name. */
  description: string | null;
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
    description: string | null;
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
           t.merchant_raw, t.biller, t.description,
           t.is_internal_transfer,
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
    description: r.description,
    isInternal: r.is_internal_transfer,
    accountName: r.account_name,
    categoryName: r.category_name,
  }));
}
