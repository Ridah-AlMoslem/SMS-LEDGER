/**
 * Everything Home reads, in one place (SPEC §11.1, §11.2, §11.5).
 *
 * Three rules hold across every query below, and breaking any one of them
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
 * Where a query needs a column the view does not carry — a merchant's display
 * name, an account's flags — the §6 filter is applied inside a CTE over the
 * view alone and the join happens outside it. `transactions` has columns named
 * `direction`, `type` and `amount` too, and an unqualified predicate across
 * that join is ambiguous.
 */

import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import { IS_EARNED, IS_EXPENSE, IS_PASSIVE, periodTotals, type PeriodTotals } from "@/db/aggregates";
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
 *  PGlite returns it as a number. Coerce everything, once, here. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/* ------------------------------------------------------------------ alerts */

export async function openAlerts(limit = 20): Promise<AlertRow[]> {
  const rows = await getDb().execute<{
    id: string;
    type: string;
    severity: Severity;
    payload: Record<string, unknown> | null;
    created_at: string;
  }>(sql`
    SELECT id, type, severity, payload,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM alerts
     WHERE dismissed_at IS NULL
     ORDER BY created_at DESC
     LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    payload: r.payload,
    createdAt: new Date(r.created_at),
  }));
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
export async function parkedCount(): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM raw_messages
     WHERE status IN ('needs_review', 'failed')
  `);
  return num(rows[0]?.n);
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
 * One query serves both the current cycle's pace rows and the rollover fold
 * behind them: `carry(c) = effective_budget(c−1) − spent(c−1)` needs the same
 * per-category spend, one cycle back, and issuing that as a second round trip
 * would invite the two to be computed differently.
 *
 * `category_id IS NULL` is kept rather than filtered out — uncategorized is a
 * first-class category (§11.2), it just has no budget to pace against.
 */
export async function spendByCycleAndCategory(
  from: CivilDate,
  to: CivilDate,
): Promise<CategoryCycleSpend[]> {
  const rows = await getDb().execute<{
    cycle_start: string;
    category_id: string | null;
    total: string;
  }>(sql`
    SELECT cycle_start::text AS cycle_start, category_id, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1, 2
  `);

  return rows.map((r) => ({
    cycleStart: r.cycle_start,
    categoryId: r.category_id,
    total: num(r.total),
  }));
}

export type BudgetRow = {
  cycleStart: CivilDate;
  categoryId: string;
  amount: number;
  rollover: boolean;
};

export async function budgetsBetween(from: CivilDate, to: CivilDate): Promise<BudgetRow[]> {
  const rows = await getDb().execute<{
    cycle_start: string;
    category_id: string;
    amount: string;
    rollover: boolean;
  }>(sql`
    SELECT cycle_start::text AS cycle_start, category_id, amount, rollover
      FROM budgets
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
     ORDER BY cycle_start
  `);

  return rows.map((r) => ({
    cycleStart: r.cycle_start,
    categoryId: r.category_id,
    amount: num(r.amount),
    rollover: r.rollover,
  }));
}

export type CategoryRow = { id: string; name: string; icon: string | null };

export async function categoryIndex(): Promise<Map<string, CategoryRow>> {
  const rows = await getDb().execute<{ id: string; name: string; icon: string | null }>(sql`
    SELECT id, name, icon FROM categories WHERE NOT is_income
  `);
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, icon: r.icon }]));
}

/* -------------------------------------------------------------- daily grid */

export type DaySpend = { day: CivilDate; total: number; count: number };

/**
 * Spend per calendar day (§11.1 chart 1).
 *
 * Filtered on `local_day`, not on a bucket: a heatmap cell *is* a day, and the
 * whole point of drawing the 24/25 rule on it is that it spans two cycles.
 */
export async function dailySpend(from: CivilDate, to: CivilDate): Promise<DaySpend[]> {
  const rows = await getDb().execute<{ day: string; total: string; n: number }>(sql`
    SELECT local_day::text AS day, sum(amount) AS total,
           count(DISTINCT transaction_id)::int AS n
      FROM v_categorized_amounts
     WHERE local_day BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1
  `);

  return rows.map((r) => ({ day: r.day, total: num(r.total), count: num(r.n) }));
}

/* --------------------------------------------------------------- cash flow */

export type BucketFlow = {
  bucket: CivilDate;
  earned: number;
  passive: number;
  expense: number;
};

export async function flowByBucket(
  grain: Grain,
  from: CivilDate,
  to: CivilDate,
): Promise<BucketFlow[]> {
  const bucket = bucketOf(grain);

  const rows = await getDb().execute<{
    bucket: string;
    earned: string;
    passive: string;
    expense: string;
  }>(sql`
    SELECT ${bucket}::text AS bucket,
           COALESCE(sum(amount) FILTER (WHERE ${IS_EARNED}), 0)  AS earned,
           COALESCE(sum(amount) FILTER (WHERE ${IS_PASSIVE}), 0) AS passive,
           COALESCE(sum(amount) FILTER (WHERE ${IS_EXPENSE}), 0) AS expense
      FROM v_categorized_amounts
     WHERE ${bucket} BETWEEN ${from}::date AND ${to}::date
     GROUP BY 1
     ORDER BY 1
  `);

  return rows.map((r) => ({
    bucket: r.bucket,
    earned: num(r.earned),
    passive: num(r.passive),
    expense: num(r.expense),
  }));
}

/* ---------------------------------------------------------- category trends */

export type BucketCategorySpend = {
  bucket: CivilDate;
  categoryId: string | null;
  total: number;
};

export async function categoryByBucket(
  grain: Grain,
  from: CivilDate,
  to: CivilDate,
): Promise<BucketCategorySpend[]> {
  const bucket = bucketOf(grain);

  const rows = await getDb().execute<{
    bucket: string;
    category_id: string | null;
    total: string;
  }>(sql`
    SELECT ${bucket}::text AS bucket, category_id, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE ${bucket} BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1, 2
  `);

  return rows.map((r) => ({
    bucket: r.bucket,
    categoryId: r.category_id,
    total: num(r.total),
  }));
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
export async function merchantLeaderboard(
  grain: Grain,
  period: CivilDate,
  limit = 8,
): Promise<MerchantRow[]> {
  const bucket = bucketOf(grain);

  const rows = await getDb().execute<{ name: string; total: string; n: number }>(sql`
    WITH spend AS (
      SELECT transaction_id, merchant_id, amount
        FROM v_categorized_amounts
       WHERE ${bucket} = ${period}::date AND ${IS_EXPENSE}
    )
    SELECT COALESCE(m.display_name, t.merchant_raw, t.biller, t.description, t.type::text)
             AS name,
           sum(s.amount)                    AS total,
           count(DISTINCT s.transaction_id)::int AS n
      FROM spend s
      JOIN transactions t ON t.id = s.transaction_id
      LEFT JOIN merchants m ON m.id = s.merchant_id
     GROUP BY 1
     ORDER BY sum(s.amount) DESC
     LIMIT ${limit}
  `);

  return rows.map((r) => ({ name: r.name, total: num(r.total), count: num(r.n) }));
}

/* --------------------------------------------------------- weekday profile */

export type WeekdaySpend = { dow: number; total: number; average: number };

/**
 * §11.1 chart 6 — average spend by weekday over the last 8 weeks.
 *
 * The divisor is the number of times that weekday *occurred*, not the number of
 * days that had spending. A Tuesday with nothing on it is a zero in the
 * average, and dropping it would turn "I rarely spend on Tuesdays" into "my
 * Tuesdays are expensive".
 */
export async function weekdayProfile(
  from: CivilDate,
  to: CivilDate,
  occurrences: number,
): Promise<WeekdaySpend[]> {
  const rows = await getDb().execute<{ dow: number; total: string }>(sql`
    SELECT EXTRACT(DOW FROM local_day)::int AS dow, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE local_day BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1
  `);

  const totals = new Map(rows.map((r) => [Number(r.dow), num(r.total)]));
  const divisor = Math.max(occurrences, 1);

  return Array.from({ length: 7 }, (_, dow) => {
    const total = totals.get(dow) ?? 0;
    return { dow, total, average: total / divisor };
  });
}

/* --------------------------------------------------------------- cycle flow */

export type IncomeSource = { source: string; incomeClass: "earned" | "passive"; total: number };

export async function incomeSources(cycle: CivilDate): Promise<IncomeSource[]> {
  const rows = await getDb().execute<{ source: string; class: string; total: string }>(sql`
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
  `);

  return rows.map((r) => ({
    source: r.source,
    incomeClass: r.class === "passive" ? "passive" : "earned",
    total: num(r.total),
  }));
}

/**
 * §11.5 — net contribution to the profit-bearing account: deposits minus
 * withdrawals, **which can be negative**.
 *
 * Only internal transfers count. A profit credit lands in the same account and
 * is income, not a contribution; folding it in here would report the account
 * growing itself and would double-count against the income column beside it.
 */
export async function netToSavings(cycle: CivilDate): Promise<number> {
  const rows = await getDb().execute<{ net: string }>(sql`
    SELECT COALESCE(sum(CASE WHEN v.direction = 'credit' THEN v.amount ELSE -v.amount END), 0)
             AS net
      FROM v_categorized_amounts v
      JOIN accounts a ON a.id = v.account_id
     WHERE v.cycle_start = ${cycle}::date
       AND a.is_profit_bearing
       AND v.is_internal_transfer
       AND v.state <> 'declined'
  `);

  return num(rows[0]?.net);
}

/* ------------------------------------------------------------ weekly digest */

export type BiggestExpense = { label: string; total: number; day: CivilDate } | null;

export async function biggestExpense(
  grain: Grain,
  period: CivilDate,
): Promise<BiggestExpense> {
  const bucket = bucketOf(grain);

  const rows = await getDb().execute<{ label: string; total: string; day: string }>(sql`
    WITH spend AS (
      SELECT transaction_id, amount, local_day
        FROM v_categorized_amounts
       WHERE ${bucket} = ${period}::date AND ${IS_EXPENSE}
    )
    SELECT COALESCE(m.display_name, t.merchant_raw, t.biller, t.description, t.type::text)
             AS label,
           sum(s.amount)         AS total,
           min(s.local_day)::text AS day
      FROM spend s
      JOIN transactions t ON t.id = s.transaction_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
     GROUP BY t.id, 1
     ORDER BY sum(s.amount) DESC
     LIMIT 1
  `);

  const r = rows[0];
  return r ? { label: r.label, total: num(r.total), day: r.day } : null;
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

export async function activeAccounts(): Promise<AccountBalanceRow[]> {
  const rows = await getDb().execute<{
    id: string;
    slug: string;
    name: string;
    institution: string;
    type: string;
    is_liability: boolean;
    balance_semantics: string;
    reconcilable: boolean;
    current_balance: string;
    opening_balance: string;
    credit_limit: string | null;
    is_profit_bearing: boolean;
    sort_order: number;
    statement_day: number | null;
    due_day: number | null;
    profit_payout_day: number | null;
  }>(sql`
    SELECT id, slug, name, institution, type::text AS type, is_liability,
           balance_semantics::text AS balance_semantics, reconcilable,
           current_balance, opening_balance, credit_limit, is_profit_bearing,
           sort_order, statement_day, due_day, profit_payout_day
      FROM accounts
     WHERE is_active
     ORDER BY sort_order
  `);

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    institution: r.institution,
    type: r.type,
    isLiability: r.is_liability,
    balanceSemantics: r.balance_semantics,
    reconcilable: r.reconcilable,
    currentBalance: String(r.current_balance),
    openingBalance: String(r.opening_balance),
    creditLimit: r.credit_limit === null ? null : String(r.credit_limit),
    isProfitBearing: r.is_profit_bearing,
    balanceAsOf: null,
    sortOrder: Number(r.sort_order),
    statementDay: r.statement_day,
    dueDay: r.due_day,
    profitPayoutDay: r.profit_payout_day,
  }));
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
export async function balanceSnapshots(from: CivilDate, to: CivilDate): Promise<Snapshot[]> {
  const rows = await getDb().execute<{ account_id: string; day: string; balance: string }>(sql`
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
  `);

  return rows.map((r) => ({
    accountId: r.account_id,
    day: r.day,
    balance: num(r.balance),
  }));
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

/**
 * Everything above and below the fold, for one grain and one period.
 *
 * Issued as one batch. The connection is `max: 1` (serverless pooling, see
 * `db/index.ts`), so these pipeline on a single connection rather than opening
 * twelve — which on Supabase's free tier is the difference between a page load
 * and a connection-limit error.
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
  const trendFrom = grain === "cycle" ? addMonths(period, -(CYCLES_BACK - 1)) : addDays(period, -7 * (WEEKS_BACK - 1));

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
  // review and the queries are not issued at all.
  const digestWeek = dayOfWeek(now) === 0 ? addDays(weekStart(now), -7) : null;

  const [
    totals,
    cycleTotals,
    alerts,
    parked,
    spend,
    budgets,
    categoryNames,
    accounts,
    snapshots,
    daily,
    flows,
    trends,
    merchants,
    weekday,
    income,
    toSavings,
    digestFlows,
    digestCategories,
    digestBiggest,
  ] = await Promise.all([
    periodTotals(grain, period),
    grain === "cycle" ? null : periodTotals("cycle", cycle),
    openAlerts(),
    parkedCount(),
    spendByCycleAndCategory(addMonths(cycle, -(CYCLES_BACK - 1)), cycle),
    budgetsBetween(addMonths(cycle, -(CYCLES_BACK - 1)), cycle),
    categoryIndex(),
    activeAccounts(),
    balanceSnapshots(netWorthWindow.from, netWorthWindow.to),
    dailySpend(heatWindow.from, heatWindow.to),
    flowByBucket(grain, trendFrom, period),
    categoryByBucket(grain, trendFrom, period),
    merchantLeaderboard(grain, period),
    // §11.1 chart 6 is weekly-only: at cycle grain the query is skipped rather
    // than computed and hidden.
    grain === "week"
      ? weekdayProfile(addDays(span.end, -(7 * WEEKS_BACK - 1)), span.end, WEEKS_BACK)
      : null,
    grain === "cycle" ? incomeSources(cycle) : null,
    grain === "cycle" ? netToSavings(cycle) : null,
    digestWeek ? flowByBucket("week", addDays(digestWeek, -7 * 4), digestWeek) : null,
    digestWeek ? categoryByBucket("week", digestWeek, digestWeek) : null,
    digestWeek ? biggestExpense("week", digestWeek) : null,
  ]);

  const resolvedCycleTotals = cycleTotals ?? totals;

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
      share: effective === null ? null : effective > 0 ? spent / effective : spent > 0 ? Infinity : 0,
    };
  });

  const budgeted = categories.filter((c) => c.effective !== null);
  const cycleBudget = budgeted.length > 0 ? budgeted.reduce((s, c) => s + (c.effective ?? 0), 0) : null;

  /* ---- the cycle flow list, §11.1 chart 8 rebuilt as three columns ---- */

  let flow: CycleFlow | null = null;
  if (grain === "cycle" && income) {
    const byCategory = spend
      .filter((r) => r.cycleStart === cycle)
      .map((r) => ({
        categoryId: r.categoryId,
        name: r.categoryId ? (categoryNames.get(r.categoryId)?.name ?? "Uncategorized") : "Uncategorized",
        total: r.total,
      }))
      .sort((a, b) => b.total - a.total);

    const saved = toSavings ?? 0;
    flow = {
      income,
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
  if (digestWeek && digestFlows) {
    const week = digestFlows.find((f) => f.bucket === digestWeek);
    const prior = digestFlows.filter((f) => f.bucket < digestWeek);

    digest = {
      week: digestWeek,
      spend: week?.expense ?? 0,
      fourWeekAverage:
        prior.length > 0 ? prior.reduce((s, f) => s + f.expense, 0) / prior.length : null,
      top: (digestCategories ?? [])
        .map((r) => ({
          name: r.categoryId ? (categoryNames.get(r.categoryId)?.name ?? "Uncategorized") : "Uncategorized",
          total: r.total,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 3),
      biggest: digestBiggest ?? null,
    };
  }

  return {
    totals,
    cycleTotals: resolvedCycleTotals,
    cycle,
    cycleDays,
    cycleElapsed,
    alerts,
    parked,
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
    weekday: weekday ?? [],
    flow,
    digest,
  };
}
