/**
 * The ledger's filter state, as URL search params (SPEC §11.1).
 *
 * Same contract as `period-params.ts` and for the same reasons: a filtered view
 * is a link you can send yourself, the back button steps back through filters
 * rather than out of the page, and the server component reads the whole
 * selection from `searchParams` without waiting for the client to tell it.
 *
 * Pure and dependency-free. The page, the paging route and the export route all
 * parse with `readFilters` and nothing else, so a CSV can never be scoped
 * differently from the list it was exported from — which is the entire point of
 * exporting the current view.
 *
 * One date scope, always. The period stepper scopes the list by default; an
 * explicit range replaces it and hides it. A stepper that no longer scopes what
 * is beneath it is worse than no stepper, because it invites the reader to
 * believe a total moved when they stepped back a month.
 */

import { type CivilDate, type Grain, periodBounds } from "./periods.ts";
import { DEFAULT_SETTINGS, type PeriodSettings } from "./settings.ts";

/** Anything with a `.get()`: URLSearchParams, Next's ReadonlyURLSearchParams. */
type Readable = { get(name: string): string | null };
export type SearchParamsInput = Record<string, string | string[] | undefined>;

function asReadable(input: Readable | SearchParamsInput): Readable {
  if (typeof (input as Readable).get === "function") return input as Readable;
  const record = input as SearchParamsInput;
  return {
    get: (name) => {
      const v = record[name];
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    },
  };
}

/* ------------------------------------------------------------------ shape */

export const TRANSACTION_TYPES = [
  "purchase",
  "withdrawal",
  "transfer",
  "card_payment",
  "loan_payment",
  "fee",
  "refund",
  "income",
  "profit",
  "bill_payment",
  "adjustment",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TYPE_LABELS: Record<string, string> = {
  purchase: "Purchase",
  withdrawal: "Cash withdrawal",
  transfer: "Transfer",
  card_payment: "Card payment",
  loan_payment: "Loan payment",
  fee: "Fee",
  refund: "Refund",
  income: "Income",
  profit: "Profit",
  bill_payment: "Bill payment",
  adjustment: "Adjustment",
};

/** `only` shows nothing but internal transfers; `hide` removes them. Absent
 *  means shown alongside everything else — which is the default, because §6
 *  requires them to be visible AND uncounted, not hidden. */
export type InternalMode = "only" | "hide";

export type LedgerFilters = {
  /** Full-text over the raw SMS body and the parsed merchant/biller/description. */
  q: string | null;
  accountId: string | null;
  /** A category id, or `"none"` for uncategorized. */
  categoryId: string | null;
  /** Matched case-insensitively against merchant_raw, falling back to biller. */
  merchant: string | null;
  from: CivilDate | null;
  to: CivilDate | null;
  /** As typed, in SAR. Validated on the way into SQL, never interpolated. */
  min: string | null;
  max: string | null;
  type: TransactionType | null;
  direction: "debit" | "credit" | null;
  internal: InternalMode | null;
  uncategorized: boolean;
  needsReview: boolean;
  manual: boolean;
  /** Explicitly unscoped by date — the period stepper stops applying. */
  allTime: boolean;
};

export const EMPTY_FILTERS: LedgerFilters = {
  q: null,
  accountId: null,
  categoryId: null,
  merchant: null,
  from: null,
  to: null,
  min: null,
  max: null,
  type: null,
  direction: null,
  internal: null,
  uncategorized: false,
  needsReview: false,
  manual: false,
  allTime: false,
};

/** URL parameter names, in one place because three routes read them. */
export const PARAM = {
  q: "q",
  account: "account",
  category: "category",
  merchant: "merchant",
  from: "from",
  to: "to",
  min: "min",
  max: "max",
  type: "type",
  direction: "dir",
  internal: "internal",
  uncategorized: "uncat",
  needsReview: "review",
  manual: "manual",
  allTime: "all",
  cursor: "cursor",
} as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Junk is dropped, never thrown on.
 *
 * These params are hand-editable by definition — they are in a URL someone may
 * have trimmed by hand or a link that outlived a category. A ledger that 500s
 * because `?min=lots` is a ledger you cannot get back into, and the failure
 * arrives at exactly the moment you were trying to find something.
 */
export function readFilters(input: Readable | SearchParamsInput): LedgerFilters {
  const p = asReadable(input);
  const str = (name: string) => {
    const v = p.get(name)?.trim();
    return v ? v : null;
  };
  const flag = (name: string) => p.get(name) === "1";

  const uuid = (name: string) => {
    const v = str(name);
    return v && UUID.test(v) ? v : null;
  };
  const date = (name: string) => {
    const v = str(name);
    return v && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
  };
  const amount = (name: string) => {
    const v = str(name)?.replace(/,/g, "");
    return v && AMOUNT.test(v) ? v : null;
  };

  const category = str(PARAM.category);
  const type = str(PARAM.type);
  const direction = str(PARAM.direction);
  const internal = str(PARAM.internal);

  let from = date(PARAM.from);
  let to = date(PARAM.to);
  // A range entered backwards is a slip, not an empty result. Swapping is what
  // the reader meant; returning nothing looks like the ledger lost the data.
  if (from && to && from > to) [from, to] = [to, from];

  return {
    q: str(PARAM.q),
    accountId: uuid(PARAM.account),
    categoryId: category === "none" ? "none" : category && UUID.test(category) ? category : null,
    merchant: str(PARAM.merchant),
    from,
    to,
    min: amount(PARAM.min),
    max: amount(PARAM.max),
    type: (TRANSACTION_TYPES as readonly string[]).includes(type ?? "")
      ? (type as TransactionType)
      : null,
    direction: direction === "debit" || direction === "credit" ? direction : null,
    internal: internal === "only" || internal === "hide" ? internal : null,
    uncategorized: flag(PARAM.uncategorized),
    needsReview: flag(PARAM.needsReview),
    manual: flag(PARAM.manual),
    allTime: flag(PARAM.allTime),
  };
}

/** The paging cursor: the (posted_at, id) of the last row already shown. */
export function readCursor(input: Readable | SearchParamsInput): string | null {
  const raw = asReadable(input).get(PARAM.cursor)?.trim();
  return raw ? raw : null;
}

/* ------------------------------------------------------------ date scope */

export type DateScope = {
  /** Inclusive local dates. Null is unbounded; on a period scope these are the
   *  bucket's own bounds, for labels and for the merchant facet only — the list
   *  itself filters on the bucket, not on these. */
  from: CivilDate | null;
  to: CivilDate | null;
  source: "period" | "custom" | "all";
  /** Set only on a period scope, and what the query actually filters by. */
  grain?: Grain;
  period?: CivilDate;
};

/**
 * The one date range in effect, resolved from both halves of the URL.
 *
 * `from`/`to` win over the period stepper, and `all=1` wins over both. The page
 * hides the stepper whenever this returns anything but `period`, so what is on
 * screen is always the scope that is actually applied.
 *
 * A period scope carries the bucket rather than only its dates, because the two
 * are NOT the same set of transactions. §5.6 lets a salary paid on the 23rd
 * carry a `cycle_override` into the cycle that opens on the 25th, so the August
 * cycle contains a transaction whose posting date is in July. Home counts it
 * there. A ledger that filtered `posted_at BETWEEN 25 Jul AND 24 Aug` would not
 * show it — the list and the total on the screen you arrived from would differ
 * by one salary, which is the single largest row in the ledger.
 */
export function dateScope(
  filters: LedgerFilters,
  grain: Grain,
  period: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): DateScope {
  if (filters.from || filters.to) {
    return { from: filters.from, to: filters.to, source: "custom" };
  }
  if (filters.allTime) return { from: null, to: null, source: "all" };

  const { start, end } = periodBounds(grain, period, s);
  return { from: start, to: end, source: "period", grain, period };
}

/* -------------------------------------------------------------- writing */

/**
 * Next's `ReadonlyURLSearchParams` extends `URLSearchParams`, so the first
 * branch catches what `useSearchParams()` hands a client component and the
 * second catches the plain record a server page gets. Same two cases
 * `withSelection` in `period-params.ts` handles, deliberately the same way.
 */
function toParams(input: URLSearchParams | SearchParamsInput): URLSearchParams {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);

  return new URLSearchParams(
    Object.entries(input as SearchParamsInput).flatMap(([k, v]) =>
      v === undefined
        ? []
        : Array.isArray(v)
          ? v.map((x) => [k, x] as [string, string])
          : [[k, v] as [string, string]],
    ),
  );
}

/**
 * The current query string with one parameter set or cleared.
 *
 * Everything else is carried through, so setting an account filter does not
 * drop the period, and the cursor is always dropped, because page 4 of the old
 * filter is not page 4 of the new one — it is a window onto rows that no longer
 * match.
 */
export function withParam(
  current: URLSearchParams | SearchParamsInput,
  name: string,
  value: string | null,
): string {
  const next = toParams(current);
  if (value === null || value === "") next.delete(name);
  else next.set(name, value);
  next.delete(PARAM.cursor);
  return next.toString();
}

/** Set several at once — a date range is two params and one decision. */
export function withParams(
  current: URLSearchParams | SearchParamsInput,
  patch: Record<string, string | null>,
): string {
  const next = toParams(current);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === "") next.delete(name);
    else next.set(name, value);
  }
  next.delete(PARAM.cursor);
  return next.toString();
}

/** Everything off. Keeps grain/period, which are not filters. */
export function withoutFilters(
  current: URLSearchParams | SearchParamsInput,
): string {
  const next = toParams(current);
  for (const name of Object.values(PARAM)) next.delete(name);
  return next.toString();
}

/** How many filters are on, for the "N filters · clear" affordance. A date
 *  range counts once however many of its two ends are set. */
export function activeCount(f: LedgerFilters): number {
  let n = 0;
  if (f.q) n++;
  if (f.accountId) n++;
  if (f.categoryId) n++;
  if (f.merchant) n++;
  if (f.from || f.to || f.allTime) n++;
  if (f.min || f.max) n++;
  if (f.type) n++;
  if (f.direction) n++;
  if (f.internal) n++;
  if (f.uncategorized) n++;
  if (f.needsReview) n++;
  if (f.manual) n++;
  return n;
}

export function hasFilters(f: LedgerFilters): boolean {
  return activeCount(f) > 0;
}

/** A filename that says what is in the file. An export whose scope is invisible
 *  is one you cannot trust three months later. */
export function exportName(scope: DateScope, f: LedgerFilters, ext: string): string {
  const parts = ["ledger"];
  if (scope.source === "all") parts.push("all-time");
  else parts.push(scope.from ?? "start", "to", scope.to ?? "now");
  if (activeCount(f) > (scope.source === "period" ? 0 : 1)) parts.push("filtered");
  return `${parts.join("-")}.${ext}`;
}
