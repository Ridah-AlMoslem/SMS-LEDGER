/**
 * Everything one account's detail view reads, in one round trip.
 *
 * The same constraint that shapes `db/home.ts` shapes this file, and for the
 * same two measured reasons: a `Promise.all` of independent statements on the
 * transaction pooler **stalls permanently** and takes the whole process with it
 * (`getDb()` is a module singleton), and the database is a region away, so
 * thirteen sequential queries would be ~4s of blank screen. So each section
 * below is a SQL fragment and `loadAccountDetail` composes them into a single
 * SELECT whose columns are JSON.
 *
 * Every fragment is scoped by `ACCOUNT`, a scalar sub-select on the slug. The
 * slug is the parser's own address for an account (§4) and is what the URL
 * carries, so nothing here needs the id resolved in a prior round trip.
 *
 * Three rules carried over from Home, because breaking any of them produces a
 * figure that looks fine:
 *
 *   1. **Aggregate from `v_categorized_amounts`** (§9.6) — a split transaction
 *      has one row per leg there and one row in the ledger.
 *   2. **Filter with the shared §6 predicates**, never a retyped copy.
 *   3. **Bucket by `cycle_start`, never a `posted_at` range** (§5.6).
 *
 * With one deliberate exception: the balance fold reads `transactions`
 * directly, filtered on `local_date`. A balance is a fact about a *date* and is
 * derived by `recompute_balances` from posted legs — the formula below is that
 * one, truncated at the window start, so the fold's closing figure and
 * `accounts.current_balance` cannot disagree.
 */

import { type SQL, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { IS_EXPENSE, IS_PASSIVE } from "@/db/aggregates";
import type { Coverage } from "@/lib/accounts";
import type { SavingsLeg } from "@/lib/savings";
import { type CivilDate, addMonths, periodBounds } from "@/lib/periods";

/** How far back the per-cycle series reach. A year of cycles is what makes a
 *  growth band visibly thick (§11.5) and is still one small result set. */
export const DETAIL_CYCLES = 12;

/** The balance line is a daily series, so it gets a shorter window — twelve
 *  cycles of days is a smear at 390px. */
export const SNAPSHOT_CYCLES = 3;

/** The window §3.3b's coverage rate is measured over. Long enough that a quiet
 *  month does not reclassify an account, short enough that a template fixed in
 *  March is not still being held against the bank in December. */
export const COVERAGE_CYCLES = 6;

/** `db.execute()` skips Drizzle's column mappers, so NUMERIC arrives as a
 *  string from postgres-js and as a number from PGlite/`json_agg`. Coerced once,
 *  here, like every other raw execute in this codebase. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const nullableNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));

const jsonRows = (frag: SQL) =>
  sql`(SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${frag}) t)`;

const jsonOne = (frag: SQL) => sql`(SELECT row_to_json(t) FROM (${frag}) t LIMIT 1)`;

/** UTC ISO-8601 in SQL rather than a raw timestamptz: parsing Postgres's text
 *  timestamp with `new Date()` is implementation-defined, this is not. */
const iso = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/* ---------------------------------------------------------------- fragments */

function accountQuery(slug: string) {
  return sql`
    SELECT id, slug, name, institution, type::text AS type, is_liability,
           balance_semantics::text AS balance_semantics, reconcilable,
           current_balance, opening_balance, credit_limit, is_profit_bearing,
           is_active, sort_order, statement_day, due_day, profit_payout_day,
           ${iso(sql`balance_as_of`)} AS balance_as_of
      FROM accounts
     WHERE slug = ${slug}
  `;
}

/**
 * Open drift first, then what was recently resolved.
 *
 * The resolved ones are not clutter: §3.3 makes drift the signal that a message
 * was missed, and "this account drifted three times last month and was closed
 * by hand each time" is the story that a single open alert cannot tell.
 */
function alertsQuery(account: SQL) {
  return sql`
    SELECT id, computed_balance, reported_balance, delta,
           ${iso(sql`detected_at`)} AS detected_at,
           ${iso(sql`resolved_at`)} AS resolved_at,
           resolution_note
      FROM reconciliation_alerts
     WHERE account_id = ${account}
     ORDER BY (resolved_at IS NULL) DESC, detected_at DESC
     LIMIT 8
  `;
}

function editsQuery(account: SQL) {
  return sql`
    SELECT id, account_id, changed, note, adjustment_transaction_id,
           ${iso(sql`created_at`)} AS created_at
      FROM account_edits
     WHERE account_id = ${account}
     ORDER BY created_at DESC
     LIMIT 8
  `;
}

/**
 * The balance line — what the bank and this app have each *said* the balance
 * was, by day.
 *
 * `source` is carried through and drawn distinctly, because a manual point and
 * an SMS point are different kinds of claim: one is the bank's word, the other
 * is yours (§3.3b), and an account whose line is entirely your own points is an
 * account with no independent verification at all.
 */
function snapshotsQuery(account: SQL, from: CivilDate, to: CivilDate) {
  return sql`
    SELECT DISTINCT ON (local_date(as_of))
           local_date(as_of)::text AS day, balance, source::text AS source
      FROM balance_snapshots
     WHERE account_id = ${account}
       AND local_date(as_of) BETWEEN ${from}::date AND ${to}::date
     ORDER BY local_date(as_of), as_of DESC
  `;
}

/**
 * This cycle's transactions on this account (§5.1).
 *
 * Bucketed by `cycle_start`, the same way every other period-scoped list in
 * this app is, so the rows here and the totals on Home cannot disagree about
 * which transactions are "this month" (§5.6).
 */
function transactionsQuery(account: SQL, cycle: CivilDate, limit = 60) {
  return sql`
    SELECT DISTINCT ON (t.posted_at, t.id)
           t.id, ${iso(sql`t.posted_at`)} AS posted_at,
           t.amount, t.direction::text AS direction, t.type::text AS type,
           t.merchant_raw, t.biller, t.description,
           t.is_internal_transfer, t.excluded_from_analytics,
           t.reported_balance, t.origin::text AS origin,
           CASE WHEN count(*) OVER (PARTITION BY t.id) > 1 THEN 'Split'
                ELSE c.name END AS category_name
      FROM v_categorized_amounts v
      JOIN transactions t ON t.id = v.transaction_id
      LEFT JOIN categories c ON c.id = v.category_id
     WHERE v.account_id = ${account}
       AND v.cycle_start = ${cycle}::date
     ORDER BY t.posted_at DESC, t.id
     LIMIT ${limit}
  `;
}

/**
 * Every posted leg in the window, for the contributions/growth fold.
 *
 * From `transactions`, not the view: this feeds a **balance**, and
 * `recompute_balances` sums posted legs. The view splits one transaction into
 * one row per category, and although the splits sum to the amount, folding a
 * balance out of a categorisation artefact is one schema change away from being
 * wrong.
 *
 * Both bucket columns come along — `local_date` for the daily balance walk and
 * `effective_cycle` for the per-cycle counters. See `SavingsLeg`.
 */
function legsQuery(account: SQL, from: CivilDate, to: CivilDate) {
  return sql`
    SELECT local_date(t.posted_at)::text                          AS day,
           effective_cycle(t.posted_at, t.cycle_override)::text    AS cycle,
           t.amount, t.direction::text AS direction, t.type::text AS type,
           t.is_internal_transfer, t.excluded_from_analytics,
           ${iso(sql`t.posted_at`)} AS posted_at,
           t.description, t.merchant_raw
      FROM transactions t
     WHERE t.account_id = ${account}
       AND t.state = 'posted'
       AND t.superseded_by IS NULL
       AND local_date(t.posted_at) BETWEEN ${from}::date AND ${to}::date
     ORDER BY t.posted_at
  `;
}

/**
 * The balance immediately before the window.
 *
 * `recompute_balances` from `api/db.py`, truncated at `from`. Written as that
 * formula on purpose: the fold that walks forward from here has to land on
 * `accounts.current_balance`, and it only does if it starts from the same
 * arithmetic the parser uses.
 */
function openingQuery(slug: string, from: CivilDate) {
  return sql`
    (SELECT a.opening_balance + COALESCE((
       SELECT sum(CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END)
         FROM transactions t
        WHERE t.account_id = a.id
          AND t.state = 'posted'
          AND t.superseded_by IS NULL
          AND local_date(t.posted_at) < ${from}::date
     ), 0)
       FROM accounts a
      WHERE a.slug = ${slug})
  `;
}

/**
 * §3.3b's coverage, measured rather than assumed.
 *
 * `origin = 'parsed'` matters: a hand-booked adjustment is not a message, and
 * counting it would dilute the rate with legs that never had a bank balance to
 * carry. `superseded_by IS NULL` for the same reason it holds everywhere else —
 * an echoed leg is a second description of one movement (§8.2.1).
 */
function coverageQuery(account: SQL, from: CivilDate) {
  return sql`
    SELECT
      (SELECT count(*)::int FROM transactions t
        WHERE t.account_id = ${account} AND t.origin = 'parsed'
          AND t.superseded_by IS NULL
          AND local_date(t.posted_at) >= ${from}::date)             AS messages,
      (SELECT count(*)::int FROM transactions t
        WHERE t.account_id = ${account} AND t.origin = 'parsed'
          AND t.superseded_by IS NULL AND t.reported_balance IS NOT NULL
          AND local_date(t.posted_at) >= ${from}::date)             AS with_balance,
      (SELECT ${iso(sql`max(as_of)`)} FROM balance_snapshots
        WHERE account_id = ${account} AND source = 'sms')           AS last_reported_at,
      (SELECT ${iso(sql`max(as_of)`)} FROM balance_snapshots
        WHERE account_id = ${account} AND source = 'manual')        AS last_manual_at
  `;
}

/** §11.4 — what the bank is asking for. The only place a statement cycle is
 *  allowed to exist (§5.5). */
function statementsQuery(account: SQL) {
  return sql`
    SELECT id, statement_date::text AS statement_date, total_due, minimum_due,
           due_date::text AS due_date, ${iso(sql`paid_at`)} AS paid_at
      FROM card_statements
     WHERE account_id = ${account}
     ORDER BY statement_date DESC
     LIMIT 6
  `;
}

/**
 * The loan terms behind a loan-type account.
 *
 * Matched by name because `loans` carries no `account_id` — §14 resolves loans
 * as "none" for v1, and the table predates any account being pointed at one.
 * The slug wins over the display name when both match, since a slug is an
 * identifier and a name is a label someone may have edited.
 */
function loanQuery(slug: string) {
  return sql`
    SELECT l.id, l.name, l.lender, l.principal, l.apr, l.term_months,
           l.start_date::text AS start_date, l.payment_amount, l.payment_day,
           l.current_balance
      FROM loans l
      JOIN accounts a ON a.slug = ${slug}
     WHERE lower(l.name) IN (lower(a.name), lower(a.slug))
     ORDER BY (lower(l.name) = lower(a.slug)) DESC
     LIMIT 1
  `;
}

/** Total expenses per cycle across everything, for §11.5's passive coverage —
 *  "your savings pays for N% of your life" is measured against what your life
 *  cost, not against what this one account spent. */
function expensesQuery(from: CivilDate, to: CivilDate) {
  return sql`
    SELECT cycle_start::text AS cycle, sum(amount) AS total
      FROM v_categorized_amounts
     WHERE cycle_start BETWEEN ${from}::date AND ${to}::date
       AND ${IS_EXPENSE}
     GROUP BY 1
  `;
}

/**
 * This account's own spending per cycle — in **salary cycles** (§5.5).
 *
 * On the card view this sits on the same screen as a statement total, which is
 * the one place two different months are allowed to appear at once. They are
 * labelled as what they are for exactly that reason: the statement is what the
 * bank wants paid, and this is what the card cost you this cycle.
 */
function accountFlowQuery(account: SQL, from: CivilDate, to: CivilDate) {
  return sql`
    SELECT cycle_start::text AS cycle,
           COALESCE(sum(amount) FILTER (WHERE ${IS_EXPENSE}), 0)  AS expense,
           COALESCE(sum(amount) FILTER (WHERE ${IS_PASSIVE}), 0)  AS passive
      FROM v_categorized_amounts
     WHERE account_id = ${account}
       AND cycle_start BETWEEN ${from}::date AND ${to}::date
     GROUP BY 1
  `;
}

/** Payout dates, and only dates. §11.5 tracks the cadence and never the
 *  amount — the column is not selected so nothing downstream can drift into
 *  warning about a smaller-than-usual payout. */
function payoutsQuery(account: SQL, limit = 24) {
  return sql`
    SELECT day FROM (
      SELECT DISTINCT local_date(t.posted_at)::text AS day, local_date(t.posted_at) AS d
        FROM transactions t
       WHERE t.account_id = ${account}
         AND t.type = 'profit' AND t.direction = 'credit'
         AND t.state = 'posted' AND t.superseded_by IS NULL
         AND NOT t.is_internal_transfer
       ORDER BY d DESC
       LIMIT ${limit}
    ) recent
    ORDER BY d
  `;
}

/* ------------------------------------------------------------------- types */

export type DetailAccount = {
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
  isActive: boolean;
  balanceAsOf: Date | null;
  sortOrder: number;
  statementDay: number | null;
  dueDay: number | null;
  profitPayoutDay: number | null;
};

export type DriftAlert = {
  id: string;
  computedBalance: number;
  reportedBalance: number;
  delta: number;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
};

export type SnapshotPoint = {
  day: CivilDate;
  balance: number;
  source: "sms" | "manual" | "computed";
};

export type AccountTransaction = {
  id: string;
  postedAt: Date;
  amount: number;
  direction: "debit" | "credit";
  type: string;
  merchant: string | null;
  biller: string | null;
  description: string | null;
  categoryName: string | null;
  isInternal: boolean;
  excluded: boolean;
  reportedBalance: number | null;
  origin: string;
};

/** A leg with the display fields the cashback view needs alongside the fold
 *  fields §11.5 needs. One query, two readings. */
export type DetailLeg = SavingsLeg & {
  postedAt: Date;
  description: string | null;
  merchant: string | null;
};

export type CardStatement = {
  id: string;
  statementDate: CivilDate;
  totalDue: number | null;
  minimumDue: number | null;
  dueDate: CivilDate | null;
  paidAt: Date | null;
};

export type LoanTerms = {
  id: string;
  name: string;
  lender: string | null;
  principal: number;
  apr: number | null;
  termMonths: number | null;
  startDate: CivilDate | null;
  paymentAmount: number | null;
  paymentDay: number | null;
  storedBalance: number;
};

export type EditRow = {
  id: string;
  accountId: string;
  changed: Record<string, { from: string | null; to: string | null }>;
  note: string | null;
  adjustmentTransactionId: string | null;
  createdAt: string;
};

export type AccountDetail = {
  account: DetailAccount;
  alerts: DriftAlert[];
  edits: EditRow[];
  snapshots: SnapshotPoint[];
  transactions: AccountTransaction[];
  legs: DetailLeg[];
  /** The balance immediately before the leg window — the fold's starting point. */
  openingBalance: number;
  coverage: Coverage;
  statements: CardStatement[];
  loan: LoanTerms | null;
  /** Cycle anchor → total expenses across all accounts. */
  expenseByCycle: Map<CivilDate, number>;
  /** Cycle anchor → this account's own expense and passive income. */
  flowByCycle: Map<CivilDate, { expense: number; passive: number }>;
  payoutDays: CivilDate[];
  /** The cycle anchors the series cover, oldest first. */
  cycles: CivilDate[];
  /** The window the leg fold and the per-cycle series run over. */
  window: { from: CivilDate; to: CivilDate };
  snapshotWindow: { from: CivilDate; to: CivilDate };
};

type Payload = Record<string, unknown>;

/** `json_agg` comes back parsed under postgres-js and as text under some
 *  drivers. Both are handled rather than assumed. */
function list(value: unknown): Payload[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as Payload[]) : [];
}

function one(value: unknown): Payload | null {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" ? (parsed as Payload) : null;
}

/* ============================================================ orchestration */

/**
 * One account, one statement.
 *
 * `cycle` is the salary cycle the transaction list and the headline figures are
 * reported in — carried from wherever the reader came from, so a drill-through
 * from Home lands on the cycle they were already looking at.
 */
export async function loadAccountDetail(
  slug: string,
  cycle: CivilDate,
  today: CivilDate,
): Promise<AccountDetail | null> {
  const account = sql`(SELECT id FROM accounts WHERE slug = ${slug})`;

  // Oldest first, ending at the cycle on screen. Stepping back through history
  // therefore moves the window rather than always drawing the last year of now.
  const cycles: CivilDate[] = [];
  for (let i = DETAIL_CYCLES - 1; i >= 0; i--) cycles.push(addMonths(cycle, -i));

  const window = {
    from: periodBounds("cycle", cycles[0]).start,
    to: periodBounds("cycle", cycle).end,
  };

  const snapshotWindow = {
    from: periodBounds("cycle", addMonths(cycle, -(SNAPSHOT_CYCLES - 1))).start,
    // The line stops at today rather than at the cycle end: drawn flat across
    // days that have not happened it reads as a plateau.
    to: today < window.to ? today : window.to,
  };

  const coverageFrom = periodBounds("cycle", addMonths(cycle, -(COVERAGE_CYCLES - 1))).start;

  const rows = await getDb().execute<Payload>(sql`
    SELECT
      ${jsonOne(accountQuery(slug))}                                    AS account,
      ${jsonRows(alertsQuery(account))}                                 AS alerts,
      ${jsonRows(editsQuery(account))}                                  AS edits,
      ${jsonRows(snapshotsQuery(account, snapshotWindow.from, snapshotWindow.to))}
                                                                        AS snapshots,
      ${jsonRows(transactionsQuery(account, cycle))}                    AS transactions,
      ${jsonRows(legsQuery(account, window.from, window.to))}           AS legs,
      ${openingQuery(slug, window.from)}                                AS opening,
      ${jsonOne(coverageQuery(account, coverageFrom))}                  AS coverage,
      ${jsonRows(statementsQuery(account))}                             AS statements,
      ${jsonOne(loanQuery(slug))}                                       AS loan,
      ${jsonRows(expensesQuery(cycles[0], cycle))}                      AS expenses,
      ${jsonRows(accountFlowQuery(account, cycles[0], cycle))}          AS flows,
      ${jsonRows(payoutsQuery(account))}                                AS payouts
  `);

  const p = rows[0];
  const raw = one(p?.account);
  if (!raw) return null;

  const account_ = {
    id: String(raw.id),
    slug: String(raw.slug),
    name: String(raw.name),
    institution: String(raw.institution),
    type: String(raw.type),
    isLiability: Boolean(raw.is_liability),
    balanceSemantics: String(raw.balance_semantics),
    reconcilable: Boolean(raw.reconcilable),
    currentBalance: String(raw.current_balance),
    openingBalance: String(raw.opening_balance),
    creditLimit: raw.credit_limit === null ? null : String(raw.credit_limit),
    isProfitBearing: Boolean(raw.is_profit_bearing),
    isActive: Boolean(raw.is_active),
    balanceAsOf: date(raw.balance_as_of),
    sortOrder: num(raw.sort_order),
    statementDay: nullableNum(raw.statement_day),
    dueDay: nullableNum(raw.due_day),
    profitPayoutDay: nullableNum(raw.profit_payout_day),
  } satisfies DetailAccount;

  const coverageRow = one(p?.coverage);

  const expenseByCycle = new Map<CivilDate, number>();
  for (const r of list(p?.expenses)) expenseByCycle.set(String(r.cycle), num(r.total));

  const flowByCycle = new Map<CivilDate, { expense: number; passive: number }>();
  for (const r of list(p?.flows)) {
    flowByCycle.set(String(r.cycle), { expense: num(r.expense), passive: num(r.passive) });
  }

  return {
    account: account_,

    alerts: list(p?.alerts).map((r) => ({
      id: String(r.id),
      computedBalance: num(r.computed_balance),
      reportedBalance: num(r.reported_balance),
      delta: num(r.delta),
      detectedAt: date(r.detected_at) ?? new Date(0),
      resolvedAt: date(r.resolved_at),
      resolutionNote: (r.resolution_note as string | null) ?? null,
    })),

    edits: list(p?.edits).map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      changed: (r.changed ?? {}) as EditRow["changed"],
      note: (r.note as string | null) ?? null,
      adjustmentTransactionId: (r.adjustment_transaction_id as string | null) ?? null,
      createdAt: String(r.created_at),
    })),

    // Sorted here rather than trusted from json_agg: an aggregate's input order
    // is only incidentally its subquery's ORDER BY, and for a series the order
    // *is* the reading.
    snapshots: list(p?.snapshots)
      .map((r) => ({
        day: String(r.day),
        balance: num(r.balance),
        source: String(r.source) as SnapshotPoint["source"],
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),

    transactions: list(p?.transactions)
      .map((r) => ({
        id: String(r.id),
        postedAt: date(r.posted_at) ?? new Date(0),
        amount: num(r.amount),
        direction: String(r.direction) as "debit" | "credit",
        type: String(r.type),
        merchant: (r.merchant_raw as string | null) ?? null,
        biller: (r.biller as string | null) ?? null,
        description: (r.description as string | null) ?? null,
        categoryName: (r.category_name as string | null) ?? null,
        isInternal: Boolean(r.is_internal_transfer),
        excluded: Boolean(r.excluded_from_analytics),
        reportedBalance: nullableNum(r.reported_balance),
        origin: String(r.origin),
      }))
      .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()),

    legs: list(p?.legs)
      .map((r) => ({
        day: String(r.day),
        cycle: String(r.cycle),
        amount: num(r.amount),
        direction: String(r.direction) as "debit" | "credit",
        type: String(r.type),
        isInternalTransfer: Boolean(r.is_internal_transfer),
        excluded: Boolean(r.excluded_from_analytics),
        postedAt: date(r.posted_at) ?? new Date(0),
        description: (r.description as string | null) ?? null,
        merchant: (r.merchant_raw as string | null) ?? null,
      }))
      .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime()),

    openingBalance: num(p?.opening),

    coverage: {
      messages: num(coverageRow?.messages),
      withBalance: num(coverageRow?.with_balance),
      lastReportedAt: date(coverageRow?.last_reported_at),
      lastManualAt: date(coverageRow?.last_manual_at),
    },

    statements: list(p?.statements).map((r) => ({
      id: String(r.id),
      statementDate: String(r.statement_date),
      totalDue: nullableNum(r.total_due),
      minimumDue: nullableNum(r.minimum_due),
      dueDate: r.due_date === null ? null : String(r.due_date),
      paidAt: date(r.paid_at),
    })),

    loan: (() => {
      const l = one(p?.loan);
      if (!l) return null;
      return {
        id: String(l.id),
        name: String(l.name),
        lender: (l.lender as string | null) ?? null,
        principal: num(l.principal),
        apr: nullableNum(l.apr),
        termMonths: nullableNum(l.term_months),
        startDate: l.start_date === null ? null : String(l.start_date),
        paymentAmount: nullableNum(l.payment_amount),
        paymentDay: nullableNum(l.payment_day),
        storedBalance: num(l.current_balance),
      };
    })(),

    expenseByCycle,
    flowByCycle,
    payoutDays: list(p?.payouts).map((r) => String(r.day)).sort(),
    cycles,
    window,
    snapshotWindow,
  };
}
