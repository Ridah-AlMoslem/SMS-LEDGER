/**
 * Everything the Review screen reads, in one round trip (SPEC §10.6, §10.7,
 * §11.6).
 *
 * Same constraint as `db/home.ts` and `db/account-detail.ts`, and it binds
 * harder here than anywhere else: this is the screen a person leaves open and
 * refreshes while waiting for a stuck queue to drain. A `Promise.all` of
 * independent statements on Supabase's transaction pooler stalls permanently
 * and takes the process with it, and the database is a region away, so a dozen
 * sequential awaits is a dozen round trips of blank screen. So each section is
 * a SQL fragment and `loadReview` composes them into one SELECT whose columns
 * are JSON.
 *
 * ## The health figures have to be cheap
 *
 * A polled screen whose every tile is an aggregate is a screen that scans
 * `raw_messages` on a timer, and that table only grows. Three shapes keep it
 * off the heap, and migration 0010 adds the indexes they need:
 *
 *   - **Counts come from `GROUP BY status`**, not six `count(*) FILTER (…)`
 *     columns. The grouped form is an index-only scan of
 *     `raw_messages_status_idx`; the filtered form is one sequential scan of
 *     every message ever received, because a filter still has to see each row.
 *   - **"Last message" is `max(received_at)`** against a dedicated DESC index,
 *     which the status index cannot serve — it is a max across all statuses.
 *   - **"Oldest queued" is `ORDER BY … LIMIT 1`**, not `min(… ) FILTER (…)`, so
 *     the planner takes one row off the status index and stops.
 *
 * ## What is deliberately NOT read here
 *
 * The master invariant's net-worth side is derived from the ledger's own posted
 * legs, never from the balances the banks reported. See `lib/invariant.ts`:
 * reading it from reported balances would make a missed message fail the check,
 * and a missed message is what the per-account reconciliation below already
 * reports, by name.
 */

import { type SQL, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { type PeriodTotalsRow, periodTotalsQuery, toPeriodTotals } from "@/db/aggregates";
import { alertsQuery } from "@/db/home";
import { SIGNED_AMOUNT_SQL } from "@/db/predicates";
import type { AccountRow, Coverage } from "@/lib/accounts";
import type { CycleMovement } from "@/lib/invariant";
import type { AlertRow, Severity } from "@/lib/alerts";
import { type CivilDate, addMonths, periodBounds } from "@/lib/periods";
import { type Health, NO_METHODS, type ParkedMessage } from "@/lib/review";

/** How many parked messages the queue loads. Grouped by shape on arrival, so
 *  this is a bound on messages, not on groups — forty of one format is one
 *  card. */
const PARKED_LIMIT = 500;
const DISMISSED_LIMIT = 200;

/** §3.3b's coverage window, the same six cycles `db/account-detail.ts` measures
 *  over — the two screens must not disagree about how well an account
 *  reconciles. */
const COVERAGE_CYCLES = 6;

/** Open drift first, then what was recently closed. The closed ones are not
 *  clutter: "this account drifted three times last month" is the story a single
 *  open alert cannot tell. */
const DRIFT_LIMIT = 12;

/** `db.execute()` skips Drizzle's column mappers, so NUMERIC arrives as a
 *  string from postgres-js and as a number from PGlite/`json_agg`. Coerced
 *  once, here, like every other raw execute in this codebase. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(String(v));

const jsonRows = (frag: SQL) =>
  sql`(SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${frag}) t)`;

const jsonOne = (frag: SQL) => sql`(SELECT row_to_json(t) FROM (${frag}) t LIMIT 1)`;

/** UTC ISO-8601 built in SQL rather than a raw timestamptz. A raw `sql`
 *  fragment bypasses Drizzle's mappers, so what arrives is whatever the driver
 *  decided — postgres-js hands back a string for an aggregate it cannot type,
 *  and `new Date(thatString)` is implementation-defined. This is not. */
const iso = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/* ------------------------------------------------------------------ health */

/** One row per status. See the header: this shape is an index-only scan and
 *  the `count(*) FILTER (…)` shape it replaces was a sequential scan. */
function statusCountsQuery() {
  return sql`SELECT status::text AS status, count(*)::int AS n
               FROM raw_messages GROUP BY status`;
}

/**
 * How the parsed messages were parsed — §11.6's template hit rate.
 *
 * Restricted to `status = 'parsed'`, which is both the correct denominator
 * (a message that never reached a verdict has no method) and what makes the
 * partial index in migration 0010 apply.
 */
function parseMethodQuery() {
  return sql`SELECT COALESCE(parse_method::text, 'unattributed') AS method,
                    count(*)::int AS n
               FROM raw_messages
              WHERE status = 'parsed'
              GROUP BY 1`;
}

/** `max()` over the DESC index — one row read, whatever the table holds. */
function lastReceivedQuery() {
  return sql`(SELECT ${iso(sql`max(received_at)`)} FROM raw_messages)`;
}

/**
 * The oldest message still waiting to be parsed.
 *
 * `ORDER BY … LIMIT 1` rather than `min(received_at) FILTER (…)`: the status
 * index is ordered on `(status, received_at)`, so this stops after one row
 * where the aggregate would walk every pending message.
 */
function oldestQueuedQuery() {
  return sql`(SELECT ${iso(sql`received_at`)} FROM raw_messages
               WHERE status IN ('pending', 'processing')
               ORDER BY received_at LIMIT 1)`;
}

/** LLM calls since the start of the local month. Compared against a timestamp
 *  computed in TypeScript rather than `date_trunc('month', now())` in SQL,
 *  because the month has to start in the configured zone and §5.5 forbids
 *  naming that zone anywhere but `settings`. */
function llmCallsQuery(since: Date) {
  return sql`(SELECT count(*)::int FROM raw_messages
               WHERE parse_method = 'llm' AND received_at >= ${since.toISOString()}::timestamptz)`;
}

/* ------------------------------------------------------------- the queue */

const PARKED_COLUMNS = sql`
  id, sender, body, ${iso(sql`received_at`)} AS received_at, status::text AS status,
  shape_hash, last_error, ignored_reason::text AS ignored_reason, attempts
`;

function parkedQuery() {
  return sql`SELECT ${PARKED_COLUMNS} FROM raw_messages
              WHERE status IN ('needs_review', 'failed')
              ORDER BY received_at DESC LIMIT ${PARKED_LIMIT}`;
}

/** Dismissed by hand, never deleted (§3.1). Listed so a mistake here stays
 *  recoverable rather than merely theoretically recoverable. */
function dismissedQuery() {
  return sql`SELECT ${PARKED_COLUMNS} FROM raw_messages
              WHERE ignored_reason = 'user'
              ORDER BY received_at DESC LIMIT ${DISMISSED_LIMIT}`;
}

/* ------------------------------------------------ accounts and the invariant */

/**
 * Every account, active or not.
 *
 * **No `WHERE is_active`**, unlike `accountsQuery` in `db/home.ts`, and the
 * difference is load-bearing. The master invariant compares a net-worth
 * movement against income and expense aggregated across the whole ledger; if
 * the net-worth side quietly omitted a deactivated account that still carries
 * this cycle's legs, the check would report a classification error that is
 * really a filter. `is_active` comes along as a column so the reconciliation
 * list below can still hide closed accounts, which is a display decision.
 */
function accountsQuery() {
  return sql`
    SELECT id, slug, name, institution, type::text AS type, is_liability,
           balance_semantics::text AS balance_semantics, reconcilable, is_active,
           current_balance, credit_limit, is_profit_bearing, sort_order
      FROM accounts
     ORDER BY sort_order
  `;
}

/**
 * Each account's signed movement across the cycle, in balance terms.
 *
 * `SIGNED_AMOUNT_SQL` is the same credit-adds/debit-subtracts rule
 * `recompute_balances` uses, imported rather than retyped, so a movement here
 * and a balance there cannot disagree about which way the money went.
 *
 * Read from `v_categorized_amounts` — the same relation the income and expense
 * side reads — so both halves of the invariant see one universe of rows. The
 * view already drops superseded legs (§8.2.1), exactly as `recompute_balances`
 * does, and a split transaction contributes its legs summing to its amount, so
 * summing over the view equals summing over `transactions`.
 */
function movementsQuery(cycle: CivilDate) {
  const signed = sql.raw(SIGNED_AMOUNT_SQL);

  return sql`
    SELECT account_id,
           COALESCE(sum(${signed}) FILTER (WHERE state = 'posted'), 0)      AS posted,
           COALESCE(sum(${signed}) FILTER (
             WHERE state = 'posted' AND excluded_from_analytics), 0)        AS excluded,
           -- Counted by §6 but reflected in no balance: a pre-auth (§7.2) is
           -- expense the moment it arrives and moves nothing until it settles.
           -- 'declined' is excluded from both sides and so belongs in neither.
           COALESCE(sum(${signed}) FILTER (
             WHERE state IN ('pending', 'reversed')
               AND NOT excluded_from_analytics), 0)                         AS unposted
      FROM v_categorized_amounts
     WHERE cycle_start = ${cycle}::date
     GROUP BY account_id
  `;
}

/* -------------------------------------------------------- reconciliation */

/**
 * Open drift, and what was recently closed (§3.3).
 *
 * `window_from` is the second-most-recent balance the bank stated before the
 * alert fired — i.e. the last figure the ledger is known to have agreed with.
 * Everything posted between that and `detected_at` is what could have caused
 * the difference, and it is the list the resolve panel links through to. NULL
 * when the bank has only ever stated one balance, in which case the honest
 * window is the whole account.
 */
function driftQuery() {
  return sql`
    SELECT ra.id, a.id AS account_id, a.slug, a.name,
           ra.computed_balance, ra.reported_balance, ra.delta,
           ${iso(sql`ra.detected_at`)} AS detected_at,
           ${iso(sql`ra.resolved_at`)} AS resolved_at,
           ra.resolution_note,
           (SELECT to_char(local_date(bs.as_of), 'YYYY-MM-DD')
              FROM balance_snapshots bs
             WHERE bs.account_id = ra.account_id AND bs.source = 'sms'
               AND bs.as_of <= ra.detected_at
             ORDER BY bs.as_of DESC
             OFFSET 1 LIMIT 1)                             AS window_from,
           to_char(local_date(ra.detected_at), 'YYYY-MM-DD') AS window_to
      FROM reconciliation_alerts ra
      JOIN accounts a ON a.id = ra.account_id
     ORDER BY (ra.resolved_at IS NULL) DESC, ra.detected_at DESC
     LIMIT ${DRIFT_LIMIT}
  `;
}

/**
 * §3.3b's coverage, per account, measured rather than assumed — the same
 * counts `db/account-detail.ts` takes for one account.
 *
 * `origin = 'parsed'` matters: a hand-booked adjustment never had a bank
 * balance to carry, and counting it would dilute the rate with legs that could
 * not have reconciled.
 */
function coverageQuery(from: CivilDate) {
  return sql`
    SELECT a.id AS account_id,
           (SELECT count(*)::int FROM transactions t
             WHERE t.account_id = a.id AND t.origin = 'parsed'
               AND t.superseded_by IS NULL
               AND local_date(t.posted_at) >= ${from}::date)          AS messages,
           (SELECT count(*)::int FROM transactions t
             WHERE t.account_id = a.id AND t.origin = 'parsed'
               AND t.superseded_by IS NULL AND t.reported_balance IS NOT NULL
               AND local_date(t.posted_at) >= ${from}::date)          AS with_balance,
           (SELECT ${iso(sql`max(as_of)`)} FROM balance_snapshots
             WHERE account_id = a.id AND source = 'sms')              AS last_reported_at,
           (SELECT ${iso(sql`max(as_of)`)} FROM balance_snapshots
             WHERE account_id = a.id AND source = 'manual')           AS last_manual_at
      FROM accounts a
     WHERE a.is_active
  `;
}

/* ------------------------------------------------------------ orchestration */

export type DriftRow = {
  id: string;
  accountId: string;
  slug: string;
  name: string;
  computedBalance: number;
  reportedBalance: number;
  delta: number;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  /** Local dates bounding the transactions that could explain the drift. */
  windowFrom: CivilDate | null;
  windowTo: CivilDate;
};

/** An account plus the two things only this screen needs of it. */
export type ReviewAccount = AccountRow & { isActive: boolean; coverage: Coverage };

export type ReviewData = {
  parked: ParkedMessage[];
  dismissed: ParkedMessage[];
  health: Health;
  alerts: AlertRow[];
  drift: DriftRow[];
  /** Every account, including deactivated ones — see `accountsQuery`. */
  accounts: ReviewAccount[];
  movements: CycleMovement[];
  income: number;
  expense: number;
  cycle: CivilDate;
  lastExportAt: Date | null;
};

type Payload = {
  parked: Record<string, unknown>[];
  dismissed: Record<string, unknown>[];
  statuses: { status: string; n: number }[];
  methods: { method: string; n: number }[];
  last_received: string | null;
  oldest_queued: string | null;
  llm_calls: number;
  alerts: { id: string; type: string; severity: Severity; payload: Record<string, unknown> | null; created_at: string }[];
  drift: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  movements: { account_id: string; posted: string | number; excluded: string | number; unposted: string | number }[];
  coverage: Record<string, unknown>[];
  totals: PeriodTotalsRow[];
  settings: { last_export_at: string | null } | null;
};

const toParked = (r: Record<string, unknown>): ParkedMessage => ({
  id: String(r.id),
  sender: String(r.sender),
  body: String(r.body),
  receivedAt: new Date(String(r.received_at)),
  status: String(r.status),
  shapeHash: r.shape_hash === null ? null : String(r.shape_hash),
  lastError: r.last_error === null ? null : String(r.last_error),
  ignoredReason: r.ignored_reason === null ? null : String(r.ignored_reason),
  attempts: num(r.attempts),
});

/**
 * `cycle` is the salary cycle the invariant is checked over, and `monthStart`
 * the instant the local calendar month began — two different periods on
 * purpose. The invariant is a §6 statement about a cycle; the LLM quota is a
 * billing figure about a calendar month, and folding either into the other
 * would report one of them against a window nobody measures it in.
 */
export async function loadReview(input: {
  cycle: CivilDate;
  monthStart: Date;
}): Promise<ReviewData> {
  const { cycle, monthStart } = input;
  const coverageFrom = periodBounds(
    "cycle",
    addMonths(cycle, -(COVERAGE_CYCLES - 1)),
  ).start;

  const result = await getDb().execute<Payload>(sql`
    SELECT
      ${jsonRows(parkedQuery())}                       AS parked,
      ${jsonRows(dismissedQuery())}                    AS dismissed,
      ${jsonRows(statusCountsQuery())}                 AS statuses,
      ${jsonRows(parseMethodQuery())}                  AS methods,
      ${lastReceivedQuery()}                           AS last_received,
      ${oldestQueuedQuery()}                           AS oldest_queued,
      ${llmCallsQuery(monthStart)}                     AS llm_calls,
      ${jsonRows(alertsQuery(60))}                     AS alerts,
      ${jsonRows(driftQuery())}                        AS drift,
      ${jsonRows(accountsQuery())}                     AS accounts,
      ${jsonRows(movementsQuery(cycle))}               AS movements,
      ${jsonRows(coverageQuery(coverageFrom))}         AS coverage,
      ${jsonRows(periodTotalsQuery("cycle", cycle))}   AS totals,
      ${jsonOne(sql`SELECT ${iso(sql`last_export_at`)} AS last_export_at FROM settings LIMIT 1`)}
                                                       AS settings
  `);

  const p = result[0];

  const byStatus = new Map((p?.statuses ?? []).map((r) => [r.status, num(r.n)]));
  const byMethodRows = new Map((p?.methods ?? []).map((r) => [r.method, num(r.n)]));

  const health: Health = {
    lastReceived: date(p?.last_received),
    oldestQueued: date(p?.oldest_queued),
    pending: byStatus.get("pending") ?? 0,
    processing: byStatus.get("processing") ?? 0,
    parsed: byStatus.get("parsed") ?? 0,
    ignored: byStatus.get("ignored") ?? 0,
    needsReview: byStatus.get("needs_review") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    byMethod: {
      ...NO_METHODS,
      template: byMethodRows.get("template") ?? 0,
      llm: byMethodRows.get("llm") ?? 0,
      manual: byMethodRows.get("manual") ?? 0,
      unattributed: byMethodRows.get("unattributed") ?? 0,
    },
    llmThisMonth: num(p?.llm_calls),
  };

  const coverage = new Map<string, Coverage>(
    (p?.coverage ?? []).map((r) => [
      String(r.account_id),
      {
        messages: num(r.messages),
        withBalance: num(r.with_balance),
        lastReportedAt: date(r.last_reported_at),
        lastManualAt: date(r.last_manual_at),
      },
    ]),
  );

  const accounts: ReviewAccount[] = (p?.accounts ?? []).map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    institution: String(r.institution),
    type: String(r.type),
    isLiability: Boolean(r.is_liability),
    balanceSemantics: String(r.balance_semantics),
    reconcilable: Boolean(r.reconcilable),
    isActive: Boolean(r.is_active),
    currentBalance: String(r.current_balance),
    creditLimit: r.credit_limit === null ? null : String(r.credit_limit),
    isProfitBearing: Boolean(r.is_profit_bearing),
    balanceAsOf: null,
    sortOrder: num(r.sort_order),
    statementDay: null,
    dueDay: null,
    profitPayoutDay: null,
    coverage: coverage.get(String(r.id)) ?? {
      messages: 0,
      withBalance: 0,
      lastReportedAt: null,
      lastManualAt: null,
    },
  }));

  const totals = toPeriodTotals(p?.totals?.[0]);

  return {
    parked: (p?.parked ?? []).map(toParked),
    dismissed: (p?.dismissed ?? []).map(toParked),
    health,
    alerts: (p?.alerts ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      payload: r.payload,
      createdAt: new Date(r.created_at),
    })),
    drift: (p?.drift ?? []).map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      slug: String(r.slug),
      name: String(r.name),
      computedBalance: num(r.computed_balance),
      reportedBalance: num(r.reported_balance),
      delta: num(r.delta),
      detectedAt: new Date(String(r.detected_at)),
      resolvedAt: date(r.resolved_at),
      resolutionNote: r.resolution_note === null ? null : String(r.resolution_note),
      windowFrom: r.window_from === null ? null : (String(r.window_from) as CivilDate),
      windowTo: String(r.window_to) as CivilDate,
    })),
    accounts,
    movements: (p?.movements ?? []).map((r) => ({
      accountId: String(r.account_id),
      posted: num(r.posted),
      excluded: num(r.excluded),
      unposted: num(r.unposted),
    })),
    income: totals.income,
    expense: totals.expense,
    cycle,
    lastExportAt: date(p?.settings?.last_export_at),
  };
}
