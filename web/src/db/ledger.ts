/**
 * Reading the ledger: search, filters, paging, and the detail behind one row.
 *
 * Three callers share `whereClause` — the page, the paging route and the export
 * route — so a CSV is scoped by exactly the predicate that drew the list it was
 * exported from. §11.6 makes export a v1 requirement, and an export whose rows
 * differ from the screen is worse than none: you would reconcile against it.
 *
 * Paging is a keyset on `(posted_at, id)`, not an OFFSET. A transfer's two legs
 * carry the same timestamp to the second, so ordering on `posted_at` alone puts
 * a row on both page 1 and page 2 or on neither, depending on how the planner
 * felt. OFFSET has the same problem plus one more: a transaction posting while
 * you scroll shifts every later page by one.
 *
 * Nothing here loads the whole ledger. The list is capped per page and the
 * export is capped outright, because "select every transaction I have ever
 * made" on a phone over a hotel connection is not a feature.
 */

import { type SQL, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { COUNTS_IN_FLOW_SQL, SIGNED_AMOUNT_SQL } from "@/db/predicates";
import type { DateScope, LedgerFilters } from "@/lib/ledger-filters";

export const PAGE_SIZE = 100;

/** An export is a file someone will open in a spreadsheet, not a backup. Past
 *  this it is a database dump, and there is a better tool for that. */
export const EXPORT_LIMIT = 10_000;

const COUNTS_IN_FLOW = sql.raw(COUNTS_IN_FLOW_SQL);
const SIGNED_AMOUNT = sql.raw(SIGNED_AMOUNT_SQL);

/**
 * Every filter, as one predicate over `transactions t` joined to `accounts a`
 * and `raw_messages rm`.
 *
 * Aliased explicitly throughout: `type`, `direction`, `amount` and `state` all
 * exist on more than one of the tables in that join, and an unqualified one is
 * either ambiguous (the query fails, which is fine) or resolves to the wrong
 * table (the query succeeds and lies, which is not).
 */
export function whereClause(filters: LedgerFilters, scope: DateScope): SQL {
  const parts: SQL[] = [
    // §8.2.1 — a superseded leg is a second institution's description of one
    // movement. It stays in the table because the link is what explains why the
    // ledger shows one transfer where two messages arrived, and it stays out of
    // every list for the same reason it stays out of every total.
    sql`t.superseded_by IS NULL`,
  ];

  if (scope.source === "period" && scope.period) {
    // Bucket equality, never a date range — the same rule `db/aggregates.ts`
    // follows, and for the same reason. §5.6 puts an early salary in the cycle
    // it FUNDS rather than the one it landed in, so the August cycle contains a
    // 23 July transaction; a BETWEEN over `posted_at` would drop it, and the
    // list would then disagree with the totals on Home by one salary.
    //
    // The asymmetry is deliberate: `effective_cycle` honours the override and
    // `week_start` ignores it, because a week is a literal date range.
    parts.push(
      scope.grain === "week"
        ? sql`week_start(local_date(t.posted_at)) = ${scope.period}::date`
        : sql`effective_cycle(t.posted_at, t.cycle_override) = ${scope.period}::date`,
    );
  } else {
    // A hand-picked range means literal dates, including for a reassigned
    // salary: someone who typed "1–31 July" is asking what happened in July.
    if (scope.from) parts.push(sql`local_date(t.posted_at) >= ${scope.from}::date`);
    if (scope.to) parts.push(sql`local_date(t.posted_at) <= ${scope.to}::date`);
  }

  if (filters.q) {
    // ILIKE, not a tsvector. Searching the raw body is how you find a purchase
    // you can only half remember, and half-remembered means a fragment: "starb",
    // "1012412", part of an Arabic biller name. Postgres has no Arabic text
    // search configuration, so `to_tsquery` would fall back to `simple` and
    // match whole whitespace-delimited tokens only — turning the one search that
    // matters into the one that misses.
    const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(sql`(
      rm.body ILIKE ${like} ESCAPE '\\'
      OR t.merchant_raw ILIKE ${like} ESCAPE '\\'
      OR t.biller ILIKE ${like} ESCAPE '\\'
      OR t.biller_service ILIKE ${like} ESCAPE '\\'
      OR t.description ILIKE ${like} ESCAPE '\\'
      OR t.notes ILIKE ${like} ESCAPE '\\'
      OR t.invoice_number ILIKE ${like} ESCAPE '\\'
    )`);
  }

  if (filters.accountId) parts.push(sql`t.account_id = ${filters.accountId}::uuid`);

  if (filters.categoryId === "none") {
    // Uncategorized means uncategorized everywhere: a transaction split across
    // categories has no category on the row, and calling that uncategorized
    // would put every split transaction in the review pile forever.
    parts.push(sql`t.category_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)`);
  } else if (filters.categoryId) {
    parts.push(sql`(
      t.category_id = ${filters.categoryId}::uuid
      OR EXISTS (SELECT 1 FROM transaction_splits s
                  WHERE s.transaction_id = t.id AND s.category_id = ${filters.categoryId}::uuid)
    )`);
  }

  if (filters.merchant) {
    parts.push(sql`lower(coalesce(t.merchant_raw, t.biller)) = lower(${filters.merchant})`);
  }

  // Validated to `\d+(\.\d{1,2})?` by readFilters, and still parameterised.
  if (filters.min) parts.push(sql`t.amount >= ${filters.min}::numeric`);
  if (filters.max) parts.push(sql`t.amount <= ${filters.max}::numeric`);

  if (filters.type) parts.push(sql`t.type = ${filters.type}::transaction_type`);
  if (filters.direction) parts.push(sql`t.direction = ${filters.direction}::direction`);

  if (filters.internal === "only") parts.push(sql`t.is_internal_transfer`);
  if (filters.internal === "hide") parts.push(sql`NOT t.is_internal_transfer`);

  if (filters.uncategorized) {
    parts.push(sql`t.category_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)`);
  }

  if (filters.needsReview) {
    // What the parser was unsure of and nobody has confirmed since. Template
    // parses carry no confidence at all — they either matched or they did not —
    // so a NULL here is not doubt and must not be treated as some.
    parts.push(sql`NOT t.is_reviewed AND t.confidence IS NOT NULL AND t.confidence < 0.8`);
  }

  if (filters.manual) parts.push(sql`t.origin = 'manual'`);

  return sql.join(parts, sql` AND `);
}

/* --------------------------------------------------------------- the list */

export type LedgerRow = {
  id: string;
  /** UTC ISO-8601. Formatted in SQL rather than selected raw: `db.execute()`
   *  skips Drizzle's column mappers, so a timestamptz arrives as whatever the
   *  driver makes of it, and parsing a Postgres text timestamp with `new Date()`
   *  is implementation-defined. */
  postedAt: string;
  /** The local calendar day, from `local_date()` — the day header groups on
   *  this, never on the UTC date, or a 01:00 purchase files under yesterday. */
  localDay: string;
  amount: string;
  direction: "debit" | "credit";
  type: string;
  state: string;
  merchantRaw: string | null;
  biller: string | null;
  description: string | null;
  notes: string | null;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  isInternal: boolean;
  excluded: boolean;
  origin: string;
  originalCurrency: string | null;
  refundedAmount: string | null;
  reversesTransactionId: string | null;
  cycleOverride: string | null;
  isReviewed: boolean;
  lockedFields: string[];
  splitCount: number;
  rawMessageId: string | null;
  matchedRuleName: string | null;
  /** Net flow for this row's day across the whole filtered set — not just the
   *  rows on this page. A day that straddles a page boundary would otherwise
   *  show two different subtotals under the same date. */
  daySubtotal: string;
  dayCount: number;
  dayInternalCount: number;
};

export type LedgerPage = {
  rows: LedgerRow[];
  /** The cursor for the next page, or null at the end. */
  nextCursor: string | null;
};

/** `<iso>|<uuid>` — the sort key of the last row already shown. */
function parseCursor(cursor: string | null): { ts: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("|");
  if (at < 0) return null;

  const ts = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!ts || !id || Number.isNaN(Date.parse(ts))) return null;
  return { ts, id };
}

type RawRow = Record<string, unknown>;

function toRow(r: RawRow): LedgerRow {
  return {
    id: String(r.id),
    postedAt: String(r.posted_at),
    localDay: String(r.local_day),
    amount: String(r.amount),
    direction: r.direction as "debit" | "credit",
    type: String(r.type),
    state: String(r.state),
    merchantRaw: (r.merchant_raw as string | null) ?? null,
    biller: (r.biller as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    accountId: String(r.account_id),
    accountName: String(r.account_name),
    categoryId: (r.category_id as string | null) ?? null,
    categoryName: (r.category_name as string | null) ?? null,
    isInternal: Boolean(r.is_internal_transfer),
    excluded: Boolean(r.excluded_from_analytics),
    origin: String(r.origin),
    originalCurrency: (r.original_currency as string | null) ?? null,
    refundedAmount: (r.refunded_amount as string | null) ?? null,
    reversesTransactionId: (r.reverses_transaction_id as string | null) ?? null,
    cycleOverride: (r.cycle_override as string | null) ?? null,
    isReviewed: Boolean(r.is_reviewed),
    lockedFields: Array.isArray(r.locked_fields) ? (r.locked_fields as string[]) : [],
    splitCount: Number(r.split_count ?? 0),
    rawMessageId: (r.raw_message_id as string | null) ?? null,
    matchedRuleName: (r.matched_rule_name as string | null) ?? null,
    daySubtotal: String(r.day_subtotal ?? "0"),
    dayCount: Number(r.day_count ?? 0),
    dayInternalCount: Number(r.day_internal_count ?? 0),
  };
}

/**
 * One page of the filtered ledger, newest first, with each row carrying its
 * day's subtotal.
 *
 * The subtotal is aggregated over the *filtered* set restricted to the days on
 * this page, in the same statement. Computing it from the page rows alone would
 * be wrong at every page boundary; computing it in a second round trip would
 * cost another ~300ms of blank screen from a region away.
 */
export async function ledgerPage(
  filters: LedgerFilters,
  scope: DateScope,
  cursor: string | null = null,
  limit: number = PAGE_SIZE,
): Promise<LedgerPage> {
  const where = whereClause(filters, scope);
  const after = parseCursor(cursor);

  // Fetch one more than asked for. The extra row is never returned; its only
  // job is to answer "is there a next page" without a second count query.
  const fetchLimit = Math.min(limit, PAGE_SIZE) + 1;

  // Row comparison, not `posted_at < ts OR (posted_at = ts AND id < id)`. The
  // tuple form is one comparison against one composite index and — unlike the
  // expanded version, which is easy to write with the wrong parentheses — it
  // cannot silently drop the second clause.
  const keyset = after
    ? sql` AND (f.posted_at, f.id) < (${after.ts}::timestamptz, ${after.id}::uuid)`
    : sql``;

  const rows = await getDb().execute<RawRow>(sql`
    WITH filtered AS (
      SELECT t.id, t.posted_at, local_date(t.posted_at) AS local_day,
             t.amount, t.direction, t.type, t.state,
             t.is_internal_transfer, t.excluded_from_analytics
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN raw_messages rm ON rm.id = t.raw_message_id
       WHERE ${where}
    ),
    page AS (
      SELECT f.id, f.posted_at, f.local_day
        FROM filtered f
       WHERE true${keyset}
       ORDER BY f.posted_at DESC, f.id DESC
       LIMIT ${fetchLimit}
    ),
    days AS (
      -- Bare column names: the filtered CTE is one relation with exactly these
      -- columns, which is the only context the §6 predicates may be pasted
      -- into. Internal transfers are counted in day_count and excluded from
      -- day_subtotal — both facts have to be visible or the arithmetic on
      -- screen looks broken.
      SELECT local_day,
             COALESCE(sum(${SIGNED_AMOUNT}) FILTER (WHERE ${COUNTS_IN_FLOW}), 0) AS day_subtotal,
             count(*)::int AS day_count,
             count(*) FILTER (WHERE is_internal_transfer)::int AS day_internal_count
        FROM filtered
       WHERE local_day IN (SELECT local_day FROM page)
       GROUP BY local_day
    )
    SELECT t.id,
           to_char(t.posted_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')          AS posted_at,
           to_char(p.local_day, 'YYYY-MM-DD')             AS local_day,
           t.amount, t.direction, t.type, t.state,
           t.merchant_raw, t.biller, t.description, t.notes,
           t.account_id, a.name AS account_name,
           t.category_id, c.name AS category_name,
           t.is_internal_transfer, t.excluded_from_analytics,
           t.origin, t.original_currency, t.refunded_amount,
           t.reverses_transaction_id,
           to_char(t.cycle_override, 'YYYY-MM-DD')        AS cycle_override,
           t.is_reviewed,
           COALESCE(t.locked_fields, '[]'::jsonb)         AS locked_fields,
           t.raw_message_id,
           r.name AS matched_rule_name,
           (SELECT count(*)::int FROM transaction_splits s
             WHERE s.transaction_id = t.id)               AS split_count,
           d.day_subtotal, d.day_count, d.day_internal_count
      FROM page p
      JOIN transactions t ON t.id = p.id
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN rules r ON r.id = t.matched_rule_id
      JOIN days d ON d.local_day = p.local_day
     ORDER BY t.posted_at DESC, t.id DESC
  `);

  const hasMore = rows.length === fetchLimit;
  const page = hasMore ? rows.slice(0, -1) : rows;
  const last = page[page.length - 1];

  return {
    rows: page.map(toRow),
    nextCursor: hasMore && last ? `${String(last.posted_at)}|${String(last.id)}` : null,
  };
}

/* ------------------------------------------------------------- the export */

export type ExportRow = Record<string, string>;

/**
 * The current filtered view, flattened for CSV or JSON (§11.6).
 *
 * Split transactions emit one row per split, with the whole transaction's
 * amount repeated and the split amount in its own column. Emitting only the
 * parent would export a file whose category column is blank for exactly the
 * transactions someone bothered to categorize carefully; emitting only the
 * splits would make the amount column stop summing to what left the account.
 * Both columns are present so either question can be answered, and the header
 * row says which is which.
 */
export async function ledgerExport(
  filters: LedgerFilters,
  scope: DateScope,
  limit = EXPORT_LIMIT,
): Promise<ExportRow[]> {
  const where = whereClause(filters, scope);

  const rows = await getDb().execute<RawRow>(sql`
    SELECT to_char(t.posted_at AT TIME ZONE 'Asia/Riyadh',
                   'YYYY-MM-DD"T"HH24:MI:SS')            AS posted_at_local,
           to_char(local_date(t.posted_at), 'YYYY-MM-DD') AS day,
           to_char(effective_cycle(t.posted_at, t.cycle_override),
                   'YYYY-MM-DD')                          AS cycle_start,
           to_char(week_start(local_date(t.posted_at)),
                   'YYYY-MM-DD')                          AS week_start,
           a.name        AS account,
           t.type, t.direction, t.state,
           t.amount,
           s.amount      AS split_amount,
           COALESCE(sc.name, c.name) AS category,
           t.merchant_raw, t.biller, t.biller_service, t.invoice_number,
           t.description, t.notes,
           t.is_internal_transfer, t.excluded_from_analytics,
           t.origin,
           COALESCE(t.locked_fields, '[]'::jsonb) AS locked_fields,
           t.original_amount, t.original_currency, t.fx_rate, t.fee_amount, t.country,
           t.reported_balance, t.confidence, t.is_reviewed,
           rm.sender, rm.body AS raw_body,
           t.id
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN raw_messages rm ON rm.id = t.raw_message_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN transaction_splits s ON s.transaction_id = t.id
      LEFT JOIN categories sc ON sc.id = s.category_id
     WHERE ${where}
     ORDER BY t.posted_at DESC, t.id DESC, s.id
     LIMIT ${limit}
  `);

  return rows.map((r) => {
    const out: ExportRow = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] =
        v === null || v === undefined
          ? ""
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
    }
    return out;
  });
}

/* ------------------------------------------------------------- the facets */

export type Facets = {
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string; parentName: string | null; isIncome: boolean }[];
  /** Top merchant/biller strings in the current scope, by transaction count. */
  merchants: { value: string; count: number }[];
};

/**
 * What the filter chips offer, in ONE round trip.
 *
 * Three lists, one statement, deliberately — and not only for the ~300ms per
 * round trip the comment in `db/aggregates.ts` is about.
 *
 * `getDb()` holds a single connection (`max: 1`) against Supabase's transaction
 * pooler, and more than two statements pipelined onto one of those connections
 * stalls: the third and everything after it never return, and because the
 * client is a module-level singleton, every later request in the process hangs
 * behind them. A `Promise.all` of three queries here does not make this page
 * slow — it takes the whole app down until the process restarts.
 *
 * So this file fans out nowhere. Sub-selects with `json_agg`, which the planner
 * runs in one pass anyway.
 *
 * Accounts and categories are the full lists: they are reference data, and a
 * picker that hides the account you are looking for because nothing matched it
 * this month is a picker that looks broken. Merchants are scoped and capped,
 * because that list is unbounded and mostly noise past the first twenty.
 */
export async function ledgerFacets(scope: DateScope): Promise<Facets> {
  const [row] = await getDb().execute<{
    accounts: unknown;
    categories: unknown;
    merchants: unknown;
  }>(sql`
    SELECT
      (SELECT COALESCE(json_agg(a), '[]'::json) FROM (
         SELECT id, name FROM accounts WHERE is_active ORDER BY sort_order, name
       ) a) AS accounts,

      (SELECT COALESCE(json_agg(c), '[]'::json) FROM (
         SELECT c.id, c.name, p.name AS parent_name, c.is_income
           FROM categories c
           LEFT JOIN categories p ON p.id = c.parent_id
          ORDER BY COALESCE(p.name, c.name), (c.parent_id IS NOT NULL), c.name
       ) c) AS categories,

      (SELECT COALESCE(json_agg(m), '[]'::json) FROM (
         SELECT lower(COALESCE(t.merchant_raw, t.biller)) AS value, count(*)::int AS n
           FROM transactions t
          WHERE t.superseded_by IS NULL
            AND COALESCE(t.merchant_raw, t.biller) IS NOT NULL
            ${scope.from ? sql`AND local_date(t.posted_at) >= ${scope.from}::date` : sql``}
            ${scope.to ? sql`AND local_date(t.posted_at) <= ${scope.to}::date` : sql``}
          GROUP BY 1
          ORDER BY n DESC, value
          LIMIT 30
       ) m) AS merchants
  `);

  // json_agg comes back parsed by postgres-js and as a string under some
  // drivers; both are handled rather than assumed, the same way every other
  // raw execute() in this codebase coerces what it gets.
  const list = (value: unknown): RawRow[] => {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as RawRow[]) : [];
  };

  return {
    accounts: list(row?.accounts).map((r) => ({ id: String(r.id), name: String(r.name) })),
    categories: list(row?.categories).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      parentName: (r.parent_name as string | null) ?? null,
      isIncome: Boolean(r.is_income),
    })),
    merchants: list(row?.merchants).map((r) => ({
      value: String(r.value),
      count: Number(r.n),
    })),
  };
}

/* ------------------------------------------------------------- one row */

export type TransactionDetail = {
  row: LedgerRow;
  /** The message this was derived from, verbatim (§3.1). Null for a manual
   *  entry, which has no source but itself. */
  raw: { id: string; sender: string; body: string; receivedAt: string; status: string } | null;
  splits: { id: string; categoryId: string; categoryName: string; amount: string }[];
  fx: {
    originalAmount: string | null;
    originalCurrency: string | null;
    fxRate: string | null;
    feeAmount: string | null;
    country: string | null;
  };
  /** Other legs from the same message — a transfer sends one message and books
   *  two. Deleting one of them has consequences for the other, and the sheet
   *  has to be able to say so. */
  siblingLegs: number;
};

export async function transactionDetail(id: string): Promise<TransactionDetail | null> {
  const db = getDb();

  const [row] = await db.execute<RawRow>(sql`
    SELECT t.id,
           to_char(t.posted_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')           AS posted_at,
           to_char(local_date(t.posted_at), 'YYYY-MM-DD')  AS local_day,
           t.amount, t.direction, t.type, t.state,
           t.merchant_raw, t.biller, t.description, t.notes,
           t.account_id, a.name AS account_name,
           t.category_id, c.name AS category_name,
           t.is_internal_transfer, t.excluded_from_analytics,
           t.origin, t.original_currency, t.refunded_amount,
           t.reverses_transaction_id,
           to_char(t.cycle_override, 'YYYY-MM-DD')         AS cycle_override,
           t.is_reviewed,
           COALESCE(t.locked_fields, '[]'::jsonb)          AS locked_fields,
           t.raw_message_id,
           r.name AS matched_rule_name,
           t.original_amount, t.fx_rate, t.fee_amount, t.country,
           (SELECT count(*)::int FROM transaction_splits s
             WHERE s.transaction_id = t.id)                AS split_count,
           (SELECT count(*)::int FROM transactions o
             WHERE o.raw_message_id = t.raw_message_id
               AND t.raw_message_id IS NOT NULL
               AND o.id <> t.id)                           AS sibling_legs,
           rm.id AS rm_id, rm.sender AS rm_sender, rm.body AS rm_body,
           rm.status AS rm_status,
           to_char(rm.received_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')           AS rm_received_at
           -- No day columns: one transaction has no day subtotal of its own,
           -- and toRow defaults them to zero. The sheet never shows them.
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN rules r ON r.id = t.matched_rule_id
      LEFT JOIN raw_messages rm ON rm.id = t.raw_message_id
     WHERE t.id = ${id}::uuid
  `);

  if (!row) return null;

  const splits = await db.execute<RawRow>(sql`
    SELECT s.id, s.category_id, c.name AS category_name, s.amount
      FROM transaction_splits s
      JOIN categories c ON c.id = s.category_id
     WHERE s.transaction_id = ${id}::uuid
     ORDER BY s.amount DESC, c.name
  `);

  return {
    row: toRow(row),
    raw: row.rm_id
      ? {
          id: String(row.rm_id),
          sender: String(row.rm_sender),
          body: String(row.rm_body),
          receivedAt: String(row.rm_received_at),
          status: String(row.rm_status),
        }
      : null,
    splits: splits.map((s) => ({
      id: String(s.id),
      categoryId: String(s.category_id),
      categoryName: String(s.category_name),
      amount: String(s.amount),
    })),
    fx: {
      originalAmount: (row.original_amount as string | null) ?? null,
      originalCurrency: (row.original_currency as string | null) ?? null,
      fxRate: (row.fx_rate as string | null) ?? null,
      feeAmount: (row.fee_amount as string | null) ?? null,
      country: (row.country as string | null) ?? null,
    },
    siblingLegs: Number(row.sibling_legs ?? 0),
  };
}
