/**
 * The account list, in one round trip (SPEC §3.3, §11.4).
 *
 * One statement, three JSON columns — the same rule as `db/home.ts`, for the
 * same two measured reasons: a `Promise.all` of independent statements on the
 * transaction pooler stalls permanently and wedges every later request in the
 * process, and the database is a region away, so each extra round trip is
 * ~300ms of blank screen.
 */

import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import type { AccountRow, Alert, Coverage } from "@/lib/accounts";
import { type CivilDate, addMonths, periodBounds } from "@/lib/periods";

import { COVERAGE_CYCLES } from "./account-detail";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(String(v));

/**
 * §3.3b's per-account coverage, for every account at once.
 *
 * `transactions.reported_balance` is non-null exactly when the message that
 * produced the leg printed a balance, so this counts the thing §3.3b's table
 * describes rather than restating that table in the UI. `origin = 'parsed'`
 * keeps hand-booked adjustments out of the denominator — they are not messages
 * and never had a bank balance to carry.
 *
 * The snapshot join supplies both anchors: when the bank last stated a figure,
 * and when a person last did (§3.3b, compensating control 3).
 */
function coverageQuery(from: CivilDate) {
  return sql`
    SELECT a.id                                        AS account_id,
           COALESCE(m.messages, 0)::int                AS messages,
           COALESCE(m.with_balance, 0)::int            AS with_balance,
           to_char(s.last_sms AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')       AS last_reported_at,
           to_char(s.last_manual AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')       AS last_manual_at
      FROM accounts a
      LEFT JOIN (
        SELECT account_id,
               count(*)                                              AS messages,
               count(*) FILTER (WHERE reported_balance IS NOT NULL)   AS with_balance
          FROM transactions
         WHERE origin = 'parsed'
           AND superseded_by IS NULL
           AND local_date(posted_at) >= ${from}::date
         GROUP BY account_id
      ) m ON m.account_id = a.id
      LEFT JOIN (
        SELECT account_id,
               max(as_of) FILTER (WHERE source = 'sms')    AS last_sms,
               max(as_of) FILTER (WHERE source = 'manual') AS last_manual
          FROM balance_snapshots
         GROUP BY account_id
      ) s ON s.account_id = a.id
     WHERE a.is_active
  `;
}

export type AccountsOverviewData = {
  accounts: AccountRow[];
  alerts: Alert[];
  coverage: Map<string, Coverage>;
};

export async function loadAccountsOverview(today: CivilDate): Promise<AccountsOverviewData> {
  const from = periodBounds("cycle", addMonths(today, -(COVERAGE_CYCLES - 1))).start;

  const jsonRows = (frag: ReturnType<typeof sql>) =>
    sql`(SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${frag}) t)`;

  const rows = await getDb().execute<Record<string, unknown>>(sql`
    SELECT
      ${jsonRows(sql`
        SELECT id, slug, name, institution, type::text AS type, is_liability,
               balance_semantics::text AS balance_semantics, reconcilable,
               current_balance, credit_limit, is_profit_bearing, sort_order,
               statement_day, due_day, profit_payout_day,
               to_char(balance_as_of AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS balance_as_of
          FROM accounts
         WHERE is_active
         ORDER BY sort_order
      `)}                                              AS accounts,

      ${jsonRows(sql`
        SELECT account_id, computed_balance, reported_balance, delta,
               to_char(detected_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS detected_at
          FROM reconciliation_alerts
         WHERE resolved_at IS NULL
         ORDER BY detected_at DESC
      `)}                                              AS alerts,

      ${jsonRows(coverageQuery(from))}                 AS coverage
  `);

  const list = (value: unknown): Record<string, unknown>[] => {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  };

  const p = rows[0];

  const coverage = new Map<string, Coverage>();
  for (const r of list(p?.coverage)) {
    coverage.set(String(r.account_id), {
      messages: num(r.messages),
      withBalance: num(r.with_balance),
      lastReportedAt: date(r.last_reported_at),
      lastManualAt: date(r.last_manual_at),
    });
  }

  return {
    accounts: list(p?.accounts)
      .map((r) => ({
        id: String(r.id),
        slug: String(r.slug),
        name: String(r.name),
        institution: String(r.institution),
        type: String(r.type),
        isLiability: Boolean(r.is_liability),
        balanceSemantics: String(r.balance_semantics),
        reconcilable: Boolean(r.reconcilable),
        currentBalance: String(r.current_balance),
        creditLimit: r.credit_limit === null ? null : String(r.credit_limit),
        isProfitBearing: Boolean(r.is_profit_bearing),
        balanceAsOf: date(r.balance_as_of),
        sortOrder: num(r.sort_order),
        statementDay: r.statement_day === null ? null : num(r.statement_day),
        dueDay: r.due_day === null ? null : num(r.due_day),
        profitPayoutDay: r.profit_payout_day === null ? null : num(r.profit_payout_day),
      }))
      // Sorted here rather than trusted from json_agg: an aggregate's input
      // order is only incidentally its subquery's ORDER BY.
      .sort((a, b) => a.sortOrder - b.sortOrder),

    alerts: list(p?.alerts).map((r) => ({
      accountId: String(r.account_id),
      computedBalance: String(r.computed_balance),
      reportedBalance: String(r.reported_balance),
      delta: String(r.delta),
      detectedAt: date(r.detected_at) ?? new Date(0),
    })),

    coverage,
  };
}
