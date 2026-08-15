/**
 * Everything Home reads, in one round trip (SPEC §11.1, §11.2, §11.5).
 *
 * **One statement, not eighteen.** Two facts force this, and both were measured
 * against production rather than assumed:
 *
 *   1. `Promise.all` over the pooled connection **deadlocks**. The client is
 *      `max: 1` (see `db/index.ts`) and Supabase's transaction-mode pooler does
 *      not survive a pipeline of independent statements: twelve concurrent
 *      counts never return, and this page died on Vercel's 300-second function
 *      timeout while every other route answered in a second. Raising the pool
 *      to 4 stalls identically — it is the pooler, not the pool size.
 *   2. The database is a region away. The function runs in `iad1` and the
 *      pooler in `ap-northeast-1`, so a round trip costs ~300ms and twelve
 *      sequential queries cost ~3.5s of blank screen. The same twelve as
 *      sub-selects of one statement cost one round trip.
 *
 * So each section below is a **SQL fragment**, and `loadHome` composes them
 * into a single SELECT whose columns are JSON. Anything added here belongs in
 * that statement; a second `await getDb()` on this page is another 300ms and
 * another chance to reintroduce the stall.
 *
 * Three rules hold across every fragment, and breaking any one of them
 * produces a number that looks fine:
 *
 *   1. **Aggregate from `v_categorized_amounts`.** A split transaction has one
 *      row per leg there and exactly one row in the ledger; summing
 *      `transactions` and `transaction_splits` together double-counts it (§9.6).
 *   2. **Filter with the shared §6 predicates**, never a hand-written copy. They
 *      live in `db/predicates.ts` as text so the verification script asserts the
 *      same clauses the app runs.
 *   3. **Cycle buckets honour `cycle_override`; week buckets ignore it.** The
 *      view materialises both columns with exactly that asymmetry (§5.6), so
 *      filtering by bucket equality gets it right and a `BETWEEN posted_at`
 *      range quietly does not.
 *
 * Where a fragment needs a column the view does not carry — a merchant's
 * display name, an account's flags — the §6 filter is applied inside a subquery
 * over the view alone and the join happens outside it. `transactions` has
 * columns named `direction`, `type` and `amount` too, and an unqualified
 * predicate across that join is ambiguous.
 */

import { type SQL, sql } from "drizzle-orm";

import { getDb } from "@/db";
import {
  IS_EARNED,
  IS_EXPENSE,
  IS_PASSIVE,
  type PeriodTotals,
  type PeriodTotalsRow,
  periodTotalsQuery,
  toPeriodTotals,
} from "@/db/aggregates";
import type { AlertRow, Severity } from "@/lib/alerts";
import type { Snapshot } from "@/lib/net-worth";
import { type CycleBudget, foldCarry } from "@/lib/pace";
import {
  type CivilDate,
  type Grain,
  addDays,
  addMonths,
  dayOfWeek,
  daysElapsed,
  daysInPeriod,
  periodBounds,
  weekStart,
} from "@/lib/periods";

/** The two grains are separate columns on the view, and `grain` is a closed
 *  union — there is nothing user-supplied in either branch. */
const bucketOf = (grain: Grain) => (grain === "cycle" ? sql`cycle_start` : sql`week_start`);

/** `db.execute()` runs raw SQL and skips Drizzle's column mappers, so what
 *  arrives is the driver's choice: postgres-js returns NUMERIC as a string,
 *  PGlite and `json_agg` as a number. Coerce everything, once, here. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/* ------------------------------------------------- composing one statement */

/** A row-returning fragment, as a JSON array column. Empty array, never null,
 *  so every consumer can `.map()` without a guard. */
const jsonRows = (frag: SQL) =>
  sql`(SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${frag}) t)`;

/** A single-row fragment, as one JSON object — or null when there is no row. */
const jsonOne = (frag: SQL) => sql`(SELECT row_to_json(t) FROM (${frag}) t LIMIT 1)`;

/** The placeholder for a section this grain does not render. Costs nothing:
 *  the planner never touches a table for it. */
const NO_ROWS = sql`'[]'::json`;

/* ------------------------------------------------------------------ alerts */

export function alertsQuery(limit = 20) {
  return sql`
    SELECT id, type, severity, payload,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM alerts
     WHERE dismissed_at IS NULL
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
}

/**
 * Messages the parser could not read (§10.6).
 *
 * Counted here as well as in the layout — the layout badges the tab, Home
 * raises it as an alert. The condition has no row in `alerts` because nothing
 * writes one yet (that is Prompt 5's background job), and a parked queue that
 * announces itself only once a job exists to announce it is a pipeline failure
 * that hides until the pipeline is fixed.
 */
export function parkedCountQuery() {
  return sql`(SELECT count(*)::int FROM raw_messages
               WHERE status IN ('needs_review', 'failed'))`;
}

/* --------------------------------------------------------- budgets & pace */

export type CategoryCycleSpend = {
  cycleStart: CivilDate;
  categoryId: string | null;
  total: number;
};

/**
 * Expense per (cycle, category) over a span of cycles.
 *
 * One fragment serves both the current cycle's pace rows and the rollover fold
 * behind them: `carry(c) = effective_budget(c−1) − spent(c−1)` needs the same
 * per-category spend, one cycle back, and computing that separately would
 * invite the two to disagree.
 *
 * `category_id IS NULL` is kept rather than filtered out — uncategorized is a
 * first-class category (§11.2), it just has no budget to pace against.
 */
export function spendByCycleAndCategoryQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT cycle_start::text AS cycle_start, category_id, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1, 2
  `;
}

export type BudgetRow = {
  cycleStart: CivilDate;
  categoryId: string;
  amount: number;
  rollover: boolean;
};

export function budgetsQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT cycle_start::text AS cycle_start, category_id, amount, rollover
      FROM budgets
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
     ORDER BY cycle_start
  `;
}

export type CategoryRow = { id: string; name: string; icon: string | null };

export function categoriesQuery() {
  return sql`SELECT id, name, icon FROM categories WHERE NOT is_income`;
}

/* -------------------------------------------------------------- daily grid */

export type DaySpend = { day: CivilDate; total: number; count: number };

/**
 * Spend per calendar day (§11.1 chart 1).
 *
 * Filtered on `local_day`, not on a bucket: a heatmap cell *is* a day, and the
 * whole point of drawing the 24/25 rule on it is that it spans two cycles.
 */
export function dailySpendQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT local_day::text AS day, sum(amount) AS total,
           count(DISTINCT transaction_id)::int AS n
      FROM v_categorized_amounts
     WHERE local_day BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1
  `;
}

/* --------------------------------------------------------------- cash flow */

export type BucketFlow = {
  bucket: CivilDate;
  earned: number;
  passive: number;
  expense: number;
};

export function flowByBucketQuery(grain: Grain, from: CivilDate, to: CivilDate) {
  const bucket = bucketOf(grain);

  return sql`
    SELECT ${bucket}::text AS bucket,
           COALESCE(sum(amount) FILTER (WHERE ${IS_EARNED}), 0)  AS earned,
           COALESCE(sum(amount) FILTER (WHERE ${IS_PASSIVE}), 0) AS passive,
           COALESCE(sum(amount) FILTER (WHERE ${IS_EXPENSE}), 0) AS expense
      FROM v_categorized_amounts
     WHERE ${bucket} BETWEEN ${from}::date AND ${to}::date
     GROUP BY 1
     ORDER BY 1
  `;
}

/* ---------------------------------------------------------- category trends */

export type BucketCategorySpend = {
  bucket: CivilDate;
  categoryId: string | null;
  total: number;
};

export function categoryByBucketQuery(grain: Grain, from: CivilDate, to: CivilDate) {
  const bucket = bucketOf(grain);

  return sql`
    SELECT ${bucket}::text AS bucket, category_id, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE ${bucket} BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1, 2
  `;
}

/* ------------------------------------------------------ merchant leaderboard */

export type MerchantRow = { name: string; total: number; count: number };

/**
 * §11.1 chart 9 — "an unglamorous table that is consistently the most
 * actionable thing on screen."
 *
 * The name falls back merchant → biller → description → type, because a SADAD
 * bill has no merchant (§7.5) and a hand-booked adjustment has neither.
 */
export function merchantsQuery(grain: Grain, period: CivilDate, limit = 8) {
  const bucket = bucketOf(grain);

  return sql`
    SELECT COALESCE(m.display_name, t.merchant_raw, t.biller, t.description, t.type::text)
             AS name,
           sum(s.amount)                        AS total,
           count(DISTINCT s.transaction_id)::int AS n
      FROM (SELECT transaction_id, merchant_id, amount
              FROM v_categorized_amounts
             WHERE ${bucket} = ${period}::date AND ${IS_EXPENSE}) s
      JOIN transactions t ON t.id = s.transaction_id
      LEFT JOIN merchants m ON m.id = s.merchant_id
     GROUP BY 1
     ORDER BY sum(s.amount) DESC
     LIMIT ${limit}
  `;
}

/* --------------------------------------------------------- weekday profile */

export type WeekdaySpend = { dow: number; total: number; average: number };

/**
 * §11.1 chart 6 — average spend by weekday over the last 8 weeks.
 *
 * The divisor is the number of times that weekday *occurred*, not the number of
 * days that had spending, and it is applied in TypeScript because the query
 * cannot know it. A Tuesday with nothing on it is a zero in the average, and
 * dropping it would turn "I rarely spend on Tuesdays" into "my Tuesdays are
 * expensive".
 */
export function weekdayQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT EXTRACT(DOW FROM local_day)::int AS dow, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE local_day BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1
  `;
}

/* --------------------------------------------------------------- cycle flow */

export type IncomeSource = { source: string; incomeClass: "earned" | "passive"; total: number };

export function incomeSourcesQuery(cycle: CivilDate) {
  return sql`
    WITH inc AS (
      SELECT transaction_id, merchant_id, account_id, amount,
             CASE WHEN ${IS_PASSIVE} THEN 'passive' ELSE 'earned' END AS class
        FROM v_categorized_amounts
       WHERE cycle_start = ${cycle}::date
         AND ((${IS_EARNED}) OR (${IS_PASSIVE}))
    )
    -- A salary carries no merchant, so without the fallback the biggest income
    -- source on the page would be labelled with the account it landed in —
    -- which answers "where" when the column is asking "from what".
    SELECT COALESCE(m.display_name, t.merchant_raw, t.biller,
                    CASE t.income_class
                      WHEN 'earned'  THEN 'Salary'
                      WHEN 'passive' THEN a.name
                      ELSE 'Other income'
                    END) AS source,
           i.class,
           sum(i.amount) AS total
      FROM inc i
      JOIN transactions t ON t.id = i.transaction_id
      JOIN accounts a ON a.id = i.account_id
      LEFT JOIN merchants m ON m.id = i.merchant_id
     GROUP BY 1, 2
     ORDER BY sum(i.amount) DESC
  `;
}

/**
 * §11.5 — net contribution to the profit-bearing account: deposits minus
 * withdrawals, **which can be negative**.
 *
 * Only internal transfers count. A profit credit lands in the same account and
 * is income, not a contribution; folding it in here would report the account
 * growing itself and would double-count against the income column beside it.
 */
export function netToSavingsQuery(cycle: CivilDate) {
  return sql`
    (SELECT COALESCE(sum(CASE WHEN v.direction = 'credit' THEN v.amount ELSE -v.amount END), 0)
       FROM v_categorized_amounts v
       JOIN accounts a ON a.id = v.account_id
      WHERE v.cycle_start = ${cycle}::date
        AND a.is_profit_bearing
        AND v.is_internal_transfer
        AND v.state <> 'declined')
  `;
}

/* ------------------------------------------------------------ weekly digest */

export type BiggestExpense = { label: string; total: number; day: CivilDate } | null;

export function biggestExpenseQuery(grain: Grain, period: CivilDate) {
  const bucket = bucketOf(grain);

  return sql`
    SELECT COALESCE(m.display_name, t.merchant_raw, t.biller, t.description, t.type::text)
             AS label,
           sum(s.amount)          AS total,
           min(s.local_day)::text AS day
      FROM (SELECT transaction_id, amount, local_day
              FROM v_categorized_amounts
             WHERE ${bucket} = ${period}::date AND ${IS_EXPENSE}) s
      JOIN transactions t ON t.id = s.transaction_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
     GROUP BY t.id, 1
     ORDER BY sum(s.amount) DESC
     LIMIT 1
  `;
}

/* ------------------------------------------------------------- net worth */

export type AccountBalanceRow = {
  id: string;
  slug: string;
  name: string;
  institution: string;
  type: string;
  isLiability: boolean;
  balanceSemantics: string;
  reconcilable: boolean;
  currentBalance: string;
  openingBalance: string;
  creditLimit: string | null;
  isProfitBearing: boolean;
  balanceAsOf: Date | null;
  sortOrder: number;
  statementDay: number | null;
  dueDay: number | null;
  profitPayoutDay: number | null;
};

export function accountsQuery() {
  return sql`
    SELECT id, slug, name, institution, type::text AS type, is_liability,
           balance_semantics::text AS balance_semantics, reconcilable,
           current_balance, opening_balance, credit_limit, is_profit_bearing,
           sort_order, statement_day, due_day, profit_payout_day
      FROM accounts
     WHERE is_active
     ORDER BY sort_order
  `;
}

/**
 * Daily-last snapshots inside the window, plus one seed per account from
 * before it.
 *
 * The seed is what makes the first day of the window a real figure rather than
 * an opening balance: an account whose bank last spoke a month ago still holds
 * that balance today, and starting the line at zero for it would draw a rise
 * that never happened.
 */
export function snapshotsQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT account_id, day::text AS day, balance FROM (
      SELECT DISTINCT ON (account_id, local_date(as_of))
             account_id, local_date(as_of) AS day, balance
        FROM balance_snapshots
       WHERE local_date(as_of) BETWEEN ${from}::date AND ${to}::date
       ORDER BY account_id, local_date(as_of), as_of DESC
    ) inside
    UNION ALL
    SELECT account_id, day::text, balance FROM (
      SELECT DISTINCT ON (account_id)
             account_id, local_date(as_of) AS day, balance
        FROM balance_snapshots
       WHERE local_date(as_of) < ${from}::date
       ORDER BY account_id, as_of DESC
    ) seed
  `;
}

/* ============================================================ orchestration */

export type CategoryPace = {
  categoryId: string | null;
  name: string;
  icon: string | null;
  /** null when the category has no budget this cycle. */
  base: number | null;
  /** §11.2 — carried separately so a large negative carry is never mistaken
   *  for a small budget. Signed. */
  carry: number;
  effective: number | null;
  spent: number;
  /** End-of-cycle spend at the current run rate. */
  projected: number;
  /** spent ÷ effective, uncapped. null with no budget. */
  share: number | null;
};

export type CycleFlow = {
  income: IncomeSource[];
  categories: { name: string; total: number; categoryId: string | null }[];
  /** §11.5 — deposits minus withdrawals on the profit-bearing account. */
  toSavings: number;
  /** income − expense − toSavings: what stayed in the current accounts or paid
   *  down debt. Together with `toSavings` this is the whole of Δ net worth. */
  retained: number;
  incomeTotal: number;
  expenseTotal: number;
};

export type Digest = {
  /** The completed week being reviewed — never the one in progress. */
  week: CivilDate;
  spend: number;
  /** Mean of the four completed weeks before it. null with no history. */
  fourWeekAverage: number | null;
  top: { name: string; total: number }[];
  biggest: BiggestExpense;
};

export type HomeData = {
  totals: PeriodTotals;
  /** The enclosing cycle. Pacing, passive coverage and the flow column are
   *  cycle figures at both grains — a week has no budget and no income. */
  cycleTotals: PeriodTotals;
  cycle: CivilDate;
  cycleDays: number;
  cycleElapsed: number;
  alerts: AlertRow[];
  /** Messages the parser parked. Raised as a derived alert, not a stored one. */
  parked: number;
  /** Every non-income category, for naming series the current cycle does not
   *  contain — a trend window is six cycles wide and the categories in it are
   *  not the categories in this one. */
  categoryNames: Map<string, CategoryRow>;
  categories: CategoryPace[];
  /** Σ effective budgets. null when nothing is budgeted at all, which is a
   *  different state from a budget of zero and is displayed as one. */
  cycleBudget: number | null;
  accounts: AccountBalanceRow[];
  snapshots: Snapshot[];
  /** [from, to] of the sparkline and the heatmap respectively. */
  netWorthWindow: { from: CivilDate; to: CivilDate };
  heatWindow: { from: CivilDate; to: CivilDate };
  daily: DaySpend[];
  flows: BucketFlow[];
  trends: BucketCategorySpend[];
  merchants: MerchantRow[];
  weekday: WeekdaySpend[];
  flow: CycleFlow | null;
  digest: Digest | null;
};

/** How far back the rollover fold and the trend charts look. §11.2 caps carry
 *  history at six cycles; the same window is what a phone-width chart can
 *  legibly carry. */
const CYCLES_BACK = 6;
const WEEKS_BACK = 8;

/** What the combined statement returns: one row, every column JSON. */
type Payload = {
  totals: PeriodTotalsRow[];
  cycle_totals: PeriodTotalsRow[];
  alerts: {
    id: string;
    type: string;
    severity: Severity;
    payload: Record<string, unknown> | null;
    created_at: string;
  }[];
  parked: number | string;
  categories: { id: string; name: string; icon: string | null }[];
  accounts: Record<string, unknown>[];
  snapshots: { account_id: string; day: string; balance: number | string }[];
  spend: { cycle_start: string; category_id: string | null; total: number | string }[];
  budgets: {
    cycle_start: string;
    category_id: string;
    amount: number | string;
    rollover: boolean;
  }[];
  daily: { day: string; total: number | string; n: number | string }[];
  flows: {
    bucket: string;
    earned: number | string;
    passive: number | string;
    expense: number | string;
  }[];
  trends: { bucket: string; category_id: string | null; total: number | string }[];
  merchants: { name: string; total: number | string; n: number | string }[];
  weekday: { dow: number | string; total: number | string }[];
  income: { source: string; class: string; total: number | string }[];
  to_savings: number | string | null;
  digest_flows: Payload["flows"];
  digest_categories: Payload["trends"];
  digest_biggest: { label: string; total: number | string; day: string } | null;
};

/**
 * Everything above and below the fold, for one grain and one period.
 *
 * One statement. See the note at the top of this file for why that is a
 * correctness requirement rather than an optimisation.
 */
export async function loadHome(
  grain: Grain,
  period: CivilDate,
  now: CivilDate,
): Promise<HomeData> {
  const cycle = grain === "cycle" ? period : periodBounds("cycle", period).start;
  const cycleSpan = periodBounds("cycle", cycle);
  const span = periodBounds(grain, period);

  const cycleDays = daysInPeriod("cycle", cycle);
  const cycleElapsed = daysElapsed("cycle", cycle, now);

  // Trend/flow window: six cycles or eight weeks back, ending at the period
  // being viewed. Stepping back through history therefore moves the window
  // rather than always showing the last six cycles of *today*.
  const trendFrom =
    grain === "cycle"
      ? addMonths(period, -(CYCLES_BACK - 1))
      : addDays(period, -7 * (WEEKS_BACK - 1));

  const carryFrom = addMonths(cycle, -(CYCLES_BACK - 1));

  // §11.1 chart 1 — the heatmap is a calendar, so it is padded out to whole
  // weeks. Half a week of blank cells at the edge is what makes the 24/25 rule
  // legible as a boundary crossing a grid rather than as a ragged edge.
  const heatWindow = {
    from: weekStart(cycleSpan.start),
    to: addDays(weekStart(cycleSpan.end), 6),
  };

  // The sparkline stops at today rather than at the cycle end: a line drawn
  // flat across days that have not happened reads as a plateau.
  const netWorthWindow = {
    from: cycleSpan.start,
    to: now < cycleSpan.end ? now : cycleSpan.end,
  };

  // §11.1 — the digest is a *week in review*, so it reviews the week that
  // closed, never the one in progress. On any other day there is nothing to
  // review and those columns are not selected at all.
  const digestWeek = dayOfWeek(now) === 0 ? addDays(weekStart(now), -7) : null;

  const result = await getDb().execute<Payload>(sql`
    SELECT
      ${jsonRows(periodTotalsQuery(grain, period))}                       AS totals,
      ${jsonRows(periodTotalsQuery("cycle", cycle))}                      AS cycle_totals,
      ${jsonRows(alertsQuery())}                                          AS alerts,
      ${parkedCountQuery()}                                               AS parked,
      ${jsonRows(categoriesQuery())}                                      AS categories,
      ${jsonRows(accountsQuery())}                                        AS accounts,
      ${jsonRows(snapshotsQuery(netWorthWindow.from, netWorthWindow.to))} AS snapshots,
      ${jsonRows(spendByCycleAndCategoryQuery(carryFrom, cycle))}         AS spend,
      ${jsonRows(budgetsQuery(carryFrom, cycle))}                         AS budgets,
      ${jsonRows(dailySpendQuery(heatWindow.from, heatWindow.to))}        AS daily,
      ${jsonRows(flowByBucketQuery(grain, trendFrom, period))}            AS flows,
      ${jsonRows(categoryByBucketQuery(grain, trendFrom, period))}        AS trends,
      ${jsonRows(merchantsQuery(grain, period))}                          AS merchants,
      ${
        // §11.1 chart 6 is weekly-only: at cycle grain the column is not
        // selected at all rather than computed and hidden.
        grain === "week"
          ? jsonRows(weekdayQuery(addDays(span.end, -(7 * WEEKS_BACK - 1)), span.end))
          : NO_ROWS
      }                                                                   AS weekday,
      ${grain === "cycle" ? jsonRows(incomeSourcesQuery(cycle)) : NO_ROWS} AS income,
      ${grain === "cycle" ? netToSavingsQuery(cycle) : sql`0`}            AS to_savings,
      ${
        digestWeek
          ? jsonRows(flowByBucketQuery("week", addDays(digestWeek, -7 * 4), digestWeek))
          : NO_ROWS
      }                                                                   AS digest_flows,
      ${digestWeek ? jsonRows(categoryByBucketQuery("week", digestWeek, digestWeek)) : NO_ROWS}
                                                                          AS digest_categories,
      ${digestWeek ? jsonOne(biggestExpenseQuery("week", digestWeek)) : sql`NULL`}
                                                                          AS digest_biggest
  `);

  const p = result[0];

  const totals = toPeriodTotals(p?.totals?.[0]);
  const resolvedCycleTotals = grain === "cycle" ? totals : toPeriodTotals(p?.cycle_totals?.[0]);

  const alerts: AlertRow[] = (p?.alerts ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    payload: r.payload,
    createdAt: new Date(r.created_at),
  }));

  const categoryNames = new Map<string, CategoryRow>(
    (p?.categories ?? []).map((r) => [r.id, { id: r.id, name: r.name, icon: r.icon }]),
  );

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

  // Sorted here rather than trusted from `json_agg`: an aggregate's input order
  // is only incidentally its subquery's ORDER BY, and for these two the order
  // *is* the reading.
  const snapshots: Snapshot[] = (p?.snapshots ?? [])
    .map((r) => ({ accountId: r.account_id, day: r.day, balance: num(r.balance) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const merchants: MerchantRow[] = (p?.merchants ?? [])
    .map((r) => ({ name: r.name, total: num(r.total), count: num(r.n) }))
    .sort((a, b) => b.total - a.total);

  const spend: CategoryCycleSpend[] = (p?.spend ?? []).map((r) => ({
    cycleStart: r.cycle_start,
    categoryId: r.category_id,
    total: num(r.total),
  }));

  const budgets: BudgetRow[] = (p?.budgets ?? []).map((r) => ({
    cycleStart: r.cycle_start,
    categoryId: r.category_id,
    amount: num(r.amount),
    rollover: r.rollover,
  }));

  const daily: DaySpend[] = (p?.daily ?? []).map((r) => ({
    day: r.day,
    total: num(r.total),
    count: num(r.n),
  }));

  const asFlows = (rows: Payload["flows"] | undefined): BucketFlow[] =>
    (rows ?? [])
      .map((r) => ({
        bucket: r.bucket,
        earned: num(r.earned),
        passive: num(r.passive),
        expense: num(r.expense),
      }))
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  const asTrends = (rows: Payload["trends"] | undefined): BucketCategorySpend[] =>
    (rows ?? []).map((r) => ({
      bucket: r.bucket,
      categoryId: r.category_id,
      total: num(r.total),
    }));

  const flows = asFlows(p?.flows);
  const trends = asTrends(p?.trends);

  // The divisor the query could not know: eight weeks, whether or not any of
  // them had spending on that weekday.
  const weekdayTotals = new Map((p?.weekday ?? []).map((r) => [num(r.dow), num(r.total)]));
  const weekday: WeekdaySpend[] =
    grain === "week"
      ? Array.from({ length: 7 }, (_, dow) => {
          const total = weekdayTotals.get(dow) ?? 0;
          return { dow, total, average: total / WEEKS_BACK };
        })
      : [];

  /* ---- category pace, with the rollover fold behind it (§11.2) ---- */

  const cycles: CivilDate[] = [];
  for (let i = CYCLES_BACK - 1; i >= 0; i--) cycles.push(addMonths(cycle, -i));

  const spentAt = new Map<string, number>();
  for (const r of spend) spentAt.set(`${r.cycleStart}|${r.categoryId ?? ""}`, r.total);

  const budgetAt = new Map<string, BudgetRow>();
  for (const b of budgets) budgetAt.set(`${b.cycleStart}|${b.categoryId}`, b);

  const ids = new Set<string>();
  for (const b of budgets) if (b.cycleStart === cycle) ids.add(b.categoryId);
  for (const r of spend) if (r.cycleStart === cycle && r.categoryId) ids.add(r.categoryId);

  const categories: CategoryPace[] = [...ids].map((id) => {
    const history: CycleBudget[] = cycles.map((c) => {
      const b = budgetAt.get(`${c}|${id}`);
      return {
        cycleStart: c,
        base: b?.amount ?? 0,
        rollover: b?.rollover ?? false,
        spent: spentAt.get(`${c}|${id}`) ?? 0,
      };
    });

    const carry = foldCarry(history);
    const base = budgetAt.get(`${cycle}|${id}`)?.amount ?? null;
    const effective = base === null ? null : base + carry;
    const spent = spentAt.get(`${cycle}|${id}`) ?? 0;

    return {
      categoryId: id,
      name: categoryNames.get(id)?.name ?? "Uncategorized",
      icon: categoryNames.get(id)?.icon ?? null,
      base,
      carry,
      effective,
      spent,
      projected: cycleElapsed > 0 ? (spent / cycleElapsed) * cycleDays : spent,
      // Uncapped, and Infinity when something was spent against a budget that
      // rollover has driven to zero. Both are real states.
      share:
        effective === null ? null : effective > 0 ? spent / effective : spent > 0 ? Infinity : 0,
    };
  });

  const budgeted = categories.filter((c) => c.effective !== null);
  const cycleBudget =
    budgeted.length > 0 ? budgeted.reduce((s, c) => s + (c.effective ?? 0), 0) : null;

  /* ---- the cycle flow list, §11.1 chart 8 rebuilt as three columns ---- */

  let flow: CycleFlow | null = null;
  if (grain === "cycle") {
    const byCategory = spend
      .filter((r) => r.cycleStart === cycle)
      .map((r) => ({
        categoryId: r.categoryId,
        name: r.categoryId
          ? (categoryNames.get(r.categoryId)?.name ?? "Uncategorized")
          : "Uncategorized",
        total: r.total,
      }))
      .sort((a, b) => b.total - a.total);

    const saved = num(p?.to_savings);
    flow = {
      income: (p?.income ?? []).map((r) => ({
        source: r.source,
        incomeClass: r.class === "passive" ? "passive" : "earned",
        total: num(r.total),
      })),
      categories: byCategory,
      toSavings: saved,
      // The three columns tie out by the master invariant, not by construction:
      // income − expense is Δ net worth, and it went either into savings or
      // stayed where it was.
      retained: resolvedCycleTotals.income - resolvedCycleTotals.expense - saved,
      incomeTotal: resolvedCycleTotals.income,
      expenseTotal: resolvedCycleTotals.expense,
    };
  }

  /* ---- the Sunday digest ---- */

  let digest: Digest | null = null;
  if (digestWeek) {
    const digestFlows = asFlows(p?.digest_flows);
    const week = digestFlows.find((f) => f.bucket === digestWeek);
    const prior = digestFlows.filter((f) => f.bucket < digestWeek);
    const biggest = p?.digest_biggest ?? null;

    digest = {
      week: digestWeek,
      spend: week?.expense ?? 0,
      fourWeekAverage:
        prior.length > 0 ? prior.reduce((s, f) => s + f.expense, 0) / prior.length : null,
      top: asTrends(p?.digest_categories)
        .map((r) => ({
          name: r.categoryId
            ? (categoryNames.get(r.categoryId)?.name ?? "Uncategorized")
            : "Uncategorized",
          total: r.total,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 3),
      biggest: biggest
        ? { label: biggest.label, total: num(biggest.total), day: biggest.day }
        : null,
    };
  }

  return {
    totals,
    cycleTotals: resolvedCycleTotals,
    cycle,
    cycleDays,
    cycleElapsed,
    alerts,
    parked: num(p?.parked),
    categoryNames,
    categories,
    cycleBudget,
    accounts,
    snapshots,
    netWorthWindow,
    heatWindow,
    daily,
    flows,
    trends,
    merchants,
    weekday,
    flow,
    digest,
  };
}
