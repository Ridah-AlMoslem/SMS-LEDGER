/**
 * Everything Plan reads, in one round trip (SPEC §11.2, §11.3).
 *
 * **One statement, not seven.** The reason is the same one `db/home.ts` opens
 * with and it is a correctness requirement, not an optimisation: a `Promise.all`
 * of independent queries over the transaction pooler answers the first two and
 * stalls the rest permanently — no error, no timeout — and because `getDb()` is
 * a module-level singleton, every later request in the process hangs behind it.
 * Sequential awaits also work; they just cost a ~300ms round trip each, and this
 * page needs six unrelated result sets.
 *
 * So each section below is a SQL fragment and `loadPlan` composes them into a
 * single SELECT whose columns are JSON.
 *
 * Three rules hold across all of them:
 *
 *   1. **Aggregate from `v_categorized_amounts`** and filter with the shared §6
 *      predicates. A split transaction has one row per leg there and exactly one
 *      row in the ledger (§9.6).
 *   2. **Carry is read, never recomputed.** `budgets.carry_in` is the stored
 *      figure written when the previous cycle closed. Nothing here folds over
 *      history to derive it — that fold is precisely what makes a corrected old
 *      transaction cascade through years of budgets (§11.2).
 *   3. **Weekly spend is grouped by week *within the cycle*.** Filtering on
 *      `cycle_start` and grouping by `week_start` gives week ∩ cycle, which is
 *      what the day-weighted fair share is measured against: weeks do not tile
 *      cycles (§5.3), and comparing seven days of spending against a two-day
 *      allowance at a cycle edge is how a screen invents an overspend.
 */

import { type SQL, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { IS_EXPENSE } from "@/db/aggregates";
import {
  type AccountBalanceRow,
  type CategoryRow,
  accountsQuery,
  categoriesQuery,
} from "@/db/home";
import type { Goal } from "@/lib/goals";
import type { Cadence, RecurringKind } from "@/lib/recurring";
import {
  type CivilDate,
  type WeekBucket,
  addMonths,
  daysElapsed,
  daysInPeriod,
  periodBounds,
  weekBucketsInCycle,
} from "@/lib/periods";

/** Coerce everything: `db.execute()` skips Drizzle's column mappers, so NUMERIC
 *  arrives as a string under postgres-js and as a number under PGlite. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const jsonRows = (frag: SQL) =>
  sql`(SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${frag}) t)`;

/** §11.2 — "cap displayed carry history at the last 6 cycles". The same window
 *  bounds the query, so a screen cannot show what it did not ask for. */
export const CARRY_HISTORY_CYCLES = 6;

/** How far back the goal run rate looks. Completed cycles only — including the
 *  cycle in progress would average a partial month against whole ones and
 *  report every goal as falling behind for the first three weeks. */
const RUN_RATE_CYCLES = 3;

/* ----------------------------------------------------------------- budgets */

export type BudgetCycleRow = {
  cycleStart: CivilDate;
  categoryId: string;
  base: number;
  rollover: boolean;
  /** Stored, signed. §11.2. */
  carryIn: number;
  /** Non-null once settled: the close job will not touch it again. */
  carryClosedAt: string | null;
};

export function budgetsQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT cycle_start::text AS cycle_start, category_id, amount, rollover, carry_in,
           to_char(carry_closed_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS carry_closed_at
      FROM budgets
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
     ORDER BY cycle_start
  `;
}

export type WeekCategorySpend = {
  /** The real Sunday of the week, as `v_categorized_amounts` buckets it. */
  week: CivilDate;
  /** null is uncategorized — a first-class row (§11.2), just not a paced one. */
  categoryId: string | null;
  total: number;
  count: number;
};

/**
 * Expense per (week, category) inside one cycle.
 *
 * One fragment serves both grains: summing every group gives the cycle total
 * that pacing and rollover need, and a single group is the week row shown at
 * week grain. Deriving them from one query is what stops the two screens
 * disagreeing about how much has been spent.
 */
export function spendByWeekAndCategoryQuery(cycle: CivilDate) {
  return sql`
    SELECT week_start::text AS week, category_id,
           sum(amount) AS total,
           count(DISTINCT transaction_id)::int AS n
      FROM v_categorized_amounts
     WHERE cycle_start = ${cycle}::date
       AND ${IS_EXPENSE}
     GROUP BY 1, 2
  `;
}

/* ------------------------------------------------------------------- goals */

export type GoalRow = Goal & {
  accountName: string | null;
  createdAt: string;
};

export function goalsQuery() {
  return sql`
    SELECT g.id, g.name, g.target_amount, g.target_date::text AS target_date,
           g.linked_account_id, g.allocation, a.name AS account_name,
           to_char(g.created_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM goals g
      LEFT JOIN accounts a ON a.id = g.linked_account_id
     ORDER BY g.created_at
  `;
}

/**
 * Net internal-transfer contribution per (account, cycle).
 *
 * The measure of whether a goal is actually being funded. Only internal
 * transfers count: a profit credit lands in the same account and is income, not
 * a contribution (§11.5), and counting it would report the account funding
 * itself. Signed, because a cycle you took money back out of contributed
 * negatively and a goal projection that hides that is a projection that lies.
 */
export function contributionsQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT account_id, cycle_start::text AS cycle_start,
           sum(CASE WHEN direction = 'credit' THEN amount ELSE -amount END) AS net
      FROM v_categorized_amounts
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
       AND is_internal_transfer
       AND state <> 'declined'
     GROUP BY 1, 2
  `;
}

/* --------------------------------------------------------------- recurring */

export type SeriesRow = {
  id: string;
  label: string;
  kind: RecurringKind;
  cadence: Cadence;
  intervalDays: number | null;
  accountId: string | null;
  accountName: string | null;
  merchantId: string | null;
  amountAvg: number | null;
  amountLast: number | null;
  amountPrev: number | null;
  priceChangeAt: CivilDate | null;
  dayOfMonth: number | null;
  nextExpectedAt: CivilDate | null;
  firstSeen: CivilDate | null;
  lastSeen: CivilDate | null;
  occurrenceCount: number;
  status: "active" | "paused" | "cancelled";
  confidence: number | null;
  confirmed: boolean;
  dismissed: boolean;
  excludedFromDetection: boolean;
};

/**
 * Every series, including the ones a person has silenced.
 *
 * Dismissed and excluded rows are loaded rather than filtered out in SQL,
 * because the panel offers them back: a series dismissed as noise by mistake is
 * otherwise unrecoverable, and an invisible tombstone that suppresses detection
 * is worse than no tombstone at all — the detector would look broken.
 *
 * The label is the one the detector resolved and stored. The merchant's current
 * display name comes first of the fallbacks so a merchant renamed since the last
 * pass reads correctly, and `detect_key` is the last resort — its middle segment
 * is a normalised key (`stc`, `profit:saib_savings`), which is a poor label and
 * only ever better than nothing.
 */
export function seriesQuery() {
  return sql`
    SELECT s.id,
           COALESCE(m.display_name, s.label, split_part(s.detect_key, '|', 2), 'Unnamed') AS label,
           s.kind::text     AS kind,
           s.cadence::text  AS cadence,
           s.interval_days,
           s.account_id, a.name AS account_name,
           s.merchant_id,
           s.amount_avg, s.amount_last, s.amount_prev,
           s.price_change_at::text   AS price_change_at,
           s.day_of_month,
           s.next_expected_at::text  AS next_expected_at,
           local_date(s.first_seen)::text AS first_seen,
           local_date(s.last_seen)::text  AS last_seen,
           s.occurrence_count,
           s.status::text AS status,
           s.confidence,
           (s.confirmed_at IS NOT NULL) AS confirmed,
           (s.dismissed_at IS NOT NULL) AS dismissed,
           s.excluded_from_detection
      FROM recurring_series s
      LEFT JOIN merchants m ON m.id = s.merchant_id
      LEFT JOIN accounts  a ON a.id = s.account_id
     ORDER BY s.next_expected_at NULLS LAST
  `;
}

/* ============================================================ orchestration */

export type PlanData = {
  /** The cycle every budget row is scoped to, at either grain. */
  cycle: CivilDate;
  /** 28–31. Never 30 by assumption (§11.2). */
  cycleDays: number;
  cycleElapsed: number;
  /** §5.3 — the week buckets touching this cycle, clipped to it. Their real day
   *  counts are the fair-share weights. */
  weeks: WeekBucket[];
  categories: Map<string, CategoryRow>;
  budgets: BudgetCycleRow[];
  weekSpend: WeekCategorySpend[];
  accounts: AccountBalanceRow[];
  goals: GoalRow[];
  /** Mean net contribution per completed cycle, per account. */
  runRates: Map<string, number>;
  series: SeriesRow[];
};

type Payload = {
  categories: { id: string; name: string; icon: string | null }[];
  budgets: {
    cycle_start: string;
    category_id: string;
    amount: number | string;
    rollover: boolean;
    carry_in: number | string;
    carry_closed_at: string | null;
  }[];
  spend: { week: string; category_id: string | null; total: number | string; n: number | string }[];
  accounts: Record<string, unknown>[];
  goals: {
    id: string;
    name: string;
    target_amount: number | string;
    target_date: string | null;
    linked_account_id: string | null;
    allocation: number | string;
    account_name: string | null;
    created_at: string;
  }[];
  contributions: { account_id: string; cycle_start: string; net: number | string }[];
  series: Record<string, unknown>[];
};

/**
 * Plan, for one grain and one period.
 *
 * The budget rows are **always cycle-scoped**, at both grains — §11.2: budgets
 * are set monthly and viewed at both grains, and the weekly figures are derived
 * from the cycle budget rather than stored. So this takes the period only to
 * resolve which cycle encloses it; the week grain changes how the same rows are
 * rendered, not what is loaded. That is also what lets the grain toggle flip the
 * rows in the browser without another request.
 */
export async function loadPlan(period: CivilDate, now: CivilDate): Promise<PlanData> {
  const cycle = periodBounds("cycle", period).start;

  const carryFrom = addMonths(cycle, -(CARRY_HISTORY_CYCLES - 1));
  // Completed cycles only: [cycle − 3, cycle − 1].
  const runRateFrom = addMonths(cycle, -RUN_RATE_CYCLES);
  const runRateTo = addMonths(cycle, -1);

  const result = await getDb().execute<Payload>(sql`
    SELECT
      ${jsonRows(categoriesQuery())}                             AS categories,
      ${jsonRows(budgetsQuery(carryFrom, cycle))}                AS budgets,
      ${jsonRows(spendByWeekAndCategoryQuery(cycle))}            AS spend,
      ${jsonRows(accountsQuery())}                               AS accounts,
      ${jsonRows(goalsQuery())}                                  AS goals,
      ${jsonRows(contributionsQuery(runRateFrom, runRateTo))}     AS contributions,
      ${jsonRows(seriesQuery())}                                 AS series
  `);

  const p = result[0];

  const categories = new Map<string, CategoryRow>(
    (p?.categories ?? []).map((r) => [r.id, { id: r.id, name: r.name, icon: r.icon }]),
  );

  const budgets: BudgetCycleRow[] = (p?.budgets ?? []).map((r) => ({
    cycleStart: r.cycle_start,
    categoryId: r.category_id,
    base: num(r.amount),
    rollover: r.rollover,
    carryIn: num(r.carry_in),
    carryClosedAt: r.carry_closed_at,
  }));

  const weekSpend: WeekCategorySpend[] = (p?.spend ?? []).map((r) => ({
    week: r.week,
    categoryId: r.category_id,
    total: num(r.total),
    count: num(r.n),
  }));

  const accounts: AccountBalanceRow[] = (p?.accounts ?? []).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    institution: String(r.institution),
    type: String(r.type),
    isLiability: Boolean(r.is_liability),
    balanceSemantics: String(r.balance_semantics),
    reconcilable: Boolean(r.reconcilable),
    currentBalance: String(r.current_balance),
    openingBalance: String(r.opening_balance),
    creditLimit: r.credit_limit === null ? null : String(r.credit_limit),
    isProfitBearing: Boolean(r.is_profit_bearing),
    balanceAsOf: null,
    sortOrder: num(r.sort_order),
    statementDay: r.statement_day === null ? null : num(r.statement_day),
    dueDay: r.due_day === null ? null : num(r.due_day),
    profitPayoutDay: r.profit_payout_day === null ? null : num(r.profit_payout_day),
  }));

  const goals: GoalRow[] = (p?.goals ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    targetAmount: num(r.target_amount),
    targetDate: r.target_date,
    accountId: r.linked_account_id,
    allocation: num(r.allocation),
    accountName: r.account_name,
    createdAt: r.created_at,
  }));

  // Mean over the cycles that actually have a row: an account that received
  // nothing in one of the three cycles contributed zero, and averaging over the
  // window rather than over the rows is the version that says so.
  const totals = new Map<string, number>();
  for (const c of p?.contributions ?? []) {
    totals.set(c.account_id, (totals.get(c.account_id) ?? 0) + num(c.net));
  }
  const runRates = new Map<string, number>(
    [...totals].map(([id, total]) => [id, total / RUN_RATE_CYCLES]),
  );

  const series: SeriesRow[] = (p?.series ?? []).map((r) => ({
    id: String(r.id),
    label: String(r.label),
    kind: r.kind as RecurringKind,
    cadence: r.cadence as Cadence,
    intervalDays: r.interval_days === null ? null : num(r.interval_days),
    accountId: r.account_id === null ? null : String(r.account_id),
    accountName: r.account_name === null ? null : String(r.account_name),
    merchantId: r.merchant_id === null ? null : String(r.merchant_id),
    amountAvg: r.amount_avg === null ? null : num(r.amount_avg),
    amountLast: r.amount_last === null ? null : num(r.amount_last),
    amountPrev: r.amount_prev === null ? null : num(r.amount_prev),
    priceChangeAt: r.price_change_at === null ? null : String(r.price_change_at),
    dayOfMonth: r.day_of_month === null ? null : num(r.day_of_month),
    nextExpectedAt: r.next_expected_at === null ? null : String(r.next_expected_at),
    firstSeen: r.first_seen === null ? null : String(r.first_seen),
    lastSeen: r.last_seen === null ? null : String(r.last_seen),
    occurrenceCount: num(r.occurrence_count),
    status: r.status as SeriesRow["status"],
    confidence: r.confidence === null ? null : num(r.confidence),
    confirmed: Boolean(r.confirmed),
    dismissed: Boolean(r.dismissed),
    excludedFromDetection: Boolean(r.excluded_from_detection),
  }));

  return {
    cycle,
    cycleDays: daysInPeriod("cycle", cycle),
    cycleElapsed: daysElapsed("cycle", cycle, now),
    weeks: weekBucketsInCycle(cycle),
    categories,
    budgets,
    weekSpend,
    accounts,
    goals,
    runRates,
    series,
  };
}
