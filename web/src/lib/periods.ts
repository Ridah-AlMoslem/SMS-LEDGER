/**
 * Period math — SPEC §5.1, §5.2, §5.3, §11.1.
 *
 * The TypeScript twin of the SQL functions in migration 0003. Both exist
 * because the database buckets rows and the browser labels and steps through
 * them, and `scripts/verify-periods.mjs` asserts the two agree date-for-date
 * over five years (and against api/ledger/periods.py where Python is present).
 *
 * Everything here works on **civil dates** — plain `YYYY-MM-DD` strings — not
 * Date objects. A Date is an instant, and an instant has no month until you
 * pick a zone; doing "the 25th" arithmetic on instants is how a purchase at
 * 01:00 local on the 25th ends up in the previous cycle. The only place a zone
 * is consulted is `today()`, which converts one instant into one civil date.
 *
 * Two rules this module exists to enforce:
 *
 *   1. `date_trunc('month')` is wrong everywhere. Cycles run 25th → 24th.
 *   2. Weeks start Sunday, and weeks do NOT tile cycles (§5.3). Summing the
 *      week buckets that touch a cycle does not give the cycle total, and
 *      nothing here pretends otherwise.
 */

import { DEFAULT_SETTINGS, type PeriodSettings } from "./settings.ts";

export const GRAINS = ["week", "cycle"] as const;
export type Grain = (typeof GRAINS)[number];

export function isGrain(v: unknown): v is Grain {
  return v === "week" || v === "cycle";
}

/** An ISO civil date, `YYYY-MM-DD`. Not an instant. */
export type CivilDate = string;

export type Period = {
  grain: Grain;
  /** Inclusive. Also the canonical anchor: what goes in the URL. */
  start: CivilDate;
  /** Inclusive. */
  end: CivilDate;
  /** Actual length. 7 for a week; 28–31 for a cycle — never assume 30. */
  days: number;
  /** §11.1 — "August 2026 (25 Jul – 24 Aug)" or "Sun 9 – Sat 15 Aug". */
  label: string;
};

/* ------------------------------------------------------- civil date atoms */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(d: CivilDate): { y: number; m: number; day: number } {
  const match = ISO.exec(d);
  if (!match) throw new Error(`not an ISO civil date: ${JSON.stringify(d)}`);
  return { y: Number(match[1]), m: Number(match[2]), day: Number(match[3]) };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function civil(y: number, m: number, day: number): CivilDate {
  return `${pad(y, 4)}-${pad(m)}-${pad(day)}`;
}

/** UTC noon, so the value is a stable calendar day under any local zone. */
function asUTC(d: CivilDate): Date {
  const { y, m, day } = parse(d);
  return new Date(Date.UTC(y, m - 1, day, 12));
}

function fromUTC(t: Date): CivilDate {
  return civil(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const DAY_MS = 86_400_000;

export function addDays(d: CivilDate, n: number): CivilDate {
  return fromUTC(new Date(asUTC(d).getTime() + n * DAY_MS));
}

/** Inclusive difference in days: `b − a`. */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((asUTC(b).getTime() - asUTC(a).getTime()) / DAY_MS);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Clamps the day, so adding a month to the 31st cannot overflow. Irrelevant
 *  at anchor 25 — every month has one — but the anchor is configurable. */
export function addMonths(d: CivilDate, n: number): CivilDate {
  const { y, m, day } = parse(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return civil(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

/** 0 = Sunday. */
export function dayOfWeek(d: CivilDate): number {
  return asUTC(d).getUTCDay();
}

/* ------------------------------------------------------------- boundaries */

/** §5.1 — the 25th that opens the cycle containing `d`. */
export function periodStart(d: CivilDate, s: PeriodSettings = DEFAULT_SETTINGS): CivilDate {
  const { y, m, day } = parse(d);
  const anchor = civil(y, m, s.cycleAnchorDay);
  return day >= s.cycleAnchorDay ? anchor : addMonths(anchor, -1);
}

/** §5.1 — inclusive last day of the cycle: the 24th of the following month. */
export function periodEnd(d: CivilDate, s: PeriodSettings = DEFAULT_SETTINGS): CivilDate {
  return addDays(addMonths(periodStart(d, s), 1), -1);
}

/**
 * §5.2 — the Sunday that opens the week containing `d`.
 *
 * Not `date_trunc('week')`, which is Monday-based and would split every Fri–Sat
 * weekend across two buckets.
 */
export function weekStart(d: CivilDate, s: PeriodSettings = DEFAULT_SETTINGS): CivilDate {
  const offset = (((dayOfWeek(d) - s.weekStartDow) % 7) + 7) % 7;
  return addDays(d, -offset);
}

/**
 * Bounds of the period of `grain` containing `anchor`.
 *
 * `anchor` may be any date inside the period, which is what makes the `period`
 * URL parameter forgiving: a hand-typed or stale date still resolves to a real
 * period rather than a half-open range.
 */
export function periodBounds(
  grain: Grain,
  anchor: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): { start: CivilDate; end: CivilDate } {
  if (grain === "cycle") {
    return { start: periodStart(anchor, s), end: periodEnd(anchor, s) };
  }
  const start = weekStart(anchor, s);
  return { start, end: addDays(start, 6) };
}

/* ----------------------------------------------------------------- labels */

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Spelled out rather than taken from Intl on purpose. ICU has changed
// "Sep" to "Sept" in en-GB between versions, and a label that shifts with the
// runtime's locale data is a label that breaks its own tests.
const monthLong = (d: CivilDate) => MONTHS_LONG[parse(d).m - 1];
const monthShort = (d: CivilDate) => MONTHS_SHORT[parse(d).m - 1];
const weekday = (d: CivilDate) => WEEKDAYS_SHORT[dayOfWeek(d)];

/**
 * §5.1 — a cycle is named after the month it ENDS in. 25 Jul – 24 Aug is
 * "August 2026", because the salary that lands on 25 July is August's money.
 */
export function cycleName(anchor: CivilDate, s: PeriodSettings = DEFAULT_SETTINGS): string {
  const end = periodEnd(anchor, s);
  return `${monthLong(end)} ${parse(end).y}`;
}

/**
 * §11.1 — the label that goes above every chart.
 *
 *   cycle: "August 2026 (25 Jul – 24 Aug)"
 *   week:  "Sun 9 – Sat 15 Aug"
 *
 * The cycle's bounds are spelled out because the whole point is that the
 * boundary is never ambiguous: a reader who assumes calendar months has to be
 * shown, on every screen, that this is not one.
 */
export function periodLabel(
  grain: Grain,
  anchor: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): string {
  const { start, end } = periodBounds(grain, anchor, s);

  if (grain === "cycle") {
    const from = `${parse(start).day} ${monthShort(start)}`;
    const to = `${parse(end).day} ${monthShort(end)}`;
    return `${cycleName(anchor, s)} (${from} – ${to})`;
  }

  const sameYear = parse(start).y === parse(end).y;
  const sameMonth = sameYear && parse(start).m === parse(end).m;

  // The month is stated once when the week sits inside it, and on both ends
  // when it straddles — "Sun 30 – Sat 5 Sep" would be unreadable.
  const from = sameMonth
    ? `${weekday(start)} ${parse(start).day}`
    : `${weekday(start)} ${parse(start).day} ${monthShort(start)}${sameYear ? "" : ` ${parse(start).y}`}`;
  const to = `${weekday(end)} ${parse(end).day} ${monthShort(end)}${sameYear ? "" : ` ${parse(end).y}`}`;

  return `${from} – ${to}`;
}

/**
 * The same period, short enough for a chart axis at 390px.
 *
 *   cycle: "Aug"        week: "9 Aug"
 *
 * A separate function rather than a truncation of `periodLabel`, because the
 * full label is what makes the 25th–24th boundary unambiguous and an axis tick
 * that says "August 2026 (25 Jul – 24 Aug)" is an axis tick nobody can read.
 * The unambiguous version is one tap away in the tooltip; both come from here,
 * so they cannot disagree about which cycle is August.
 */
export function shortLabel(
  grain: Grain,
  anchor: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): string {
  const { start } = periodBounds(grain, anchor, s);
  if (grain === "cycle") return monthShort(periodEnd(start, s));
  return `${parse(start).day} ${monthShort(start)}`;
}

/**
 * One civil date. "9 Aug", or "9 Aug 2025" once the year stops being obvious.
 *
 * A date, not a period — the ledger's date-range chips and day headers name a
 * single day, and `shortLabel` would round it to the period containing it,
 * which is how a filter comes to say something different from what it does.
 */
export function civilShort(
  d: CivilDate,
  now: Date = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): string {
  const { y, day } = parse(d);
  const thisYear = parse(today(now, s)).y;
  return `${day} ${monthShort(d)}${y === thisYear ? "" : ` ${y}`}`;
}

/**
 * A day header in the ledger: "Today", "Yesterday", or "Sun 9 Aug".
 *
 * Today and yesterday are named rather than dated because that is how anyone
 * reading a ledger on the day thinks about them, and because a date that
 * silently means today is a date you check against your phone's clock.
 */
export function dayLabel(
  d: CivilDate,
  now: Date = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): string {
  const at = today(now, s);
  if (d === at) return "Today";
  if (d === addDays(at, -1)) return "Yesterday";
  return `${weekday(d)} ${civilShort(d, now, s)}`;
}

/* ---------------------------------------------------------------- periods */

/**
 * The civil date it is *right now* in the configured zone.
 *
 * The one place an instant becomes a date. `Date` methods like getDate() would
 * answer in the runtime's zone — the server's, which is UTC on Vercel — and
 * three hours of every day would be attributed to yesterday.
 */
export function today(now: Date = new Date(), s: PeriodSettings = DEFAULT_SETTINGS): CivilDate {
  // en-CA renders ISO order; the zone is what actually matters here.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: s.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function toPeriod(
  grain: Grain,
  anchor: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): Period {
  const { start, end } = periodBounds(grain, anchor, s);
  return {
    grain,
    start,
    end,
    days: diffDays(start, end) + 1,
    label: periodLabel(grain, start, s),
  };
}

export function currentPeriod(
  grain: Grain,
  now: Date = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): Period {
  return toPeriod(grain, today(now, s), s);
}

/** Move `delta` periods and return the new anchor (the period's start). */
export function stepPeriod(
  grain: Grain,
  anchor: CivilDate,
  delta: number,
  s: PeriodSettings = DEFAULT_SETTINGS,
): CivilDate {
  const { start } = periodBounds(grain, anchor, s);
  return grain === "cycle" ? addMonths(start, delta) : addDays(start, delta * 7);
}

/**
 * §11.2 — pacing needs the *actual* length. A cycle is 28, 29, 30 or 31 days,
 * and "60% spent, 40% through the cycle" computed against a hardcoded 30 is
 * wrong by up to 10% in February.
 */
export function daysInPeriod(
  grain: Grain,
  anchor: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): number {
  const { start, end } = periodBounds(grain, anchor, s);
  return diffDays(start, end) + 1;
}

/**
 * Days of the period consumed, inclusive of today, clamped to the period.
 *
 * A past period reads as fully elapsed and a future one as zero, so pacing
 * never shows "day 34 of 31" while browsing history.
 */
export function daysElapsed(
  grain: Grain,
  anchor: CivilDate,
  now: Date | CivilDate = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): number {
  const { start, end } = periodBounds(grain, anchor, s);
  const at = typeof now === "string" ? now : today(now, s);
  if (diffDays(at, start) > 0) return 0;
  if (diffDays(end, at) > 0) return diffDays(start, end) + 1;
  return diffDays(start, at) + 1;
}

/* ---------------------------------------------- weeks against cycles (§5.3) */

export type WeekBucket = {
  /** The real Sunday this week began, even when clipped below. */
  weekStart: CivilDate;
  /** Clipped to the cycle. */
  start: CivilDate;
  end: CivilDate;
  days: number;
  /** True when the cycle boundary cut the week short. */
  partial: boolean;
};

/**
 * §5.3 — the week buckets touching a cycle, clipped to it.
 *
 * A cycle averages 4.43 weeks and starts mid-week, so August 2026 splits into
 * six buckets, two of them stubs of 1 and 2 days. Rendering a 1-day bar beside
 * 7-day bars reads as a spending collapse that never happened, which is why
 * `partial` is carried out of here rather than inferred in the chart.
 *
 * These buckets are for *display against a cycle only*. Weeks are not nested
 * inside cycles: a transaction belongs to its own week and its own cycle,
 * independently, and the two totals are never reconciled.
 */
export function weekBucketsInCycle(
  anchor: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): WeekBucket[] {
  const { start, end } = periodBounds("cycle", anchor, s);
  const buckets: WeekBucket[] = [];

  // Civil dates are zero-padded ISO, so `<` is date order. Comparing them as
  // strings beats diffDays() here — the sign convention of a difference is
  // exactly the kind of thing that silently inverts a clip.
  for (let w = weekStart(start, s); w <= end; w = addDays(w, 7)) {
    const wEnd = addDays(w, 6);
    const from = w < start ? start : w;
    const to = wEnd > end ? end : wEnd;
    const days = diffDays(from, to) + 1;
    buckets.push({ weekStart: w, start: from, end: to, days, partial: days < 7 });
  }

  return buckets;
}

/**
 * Whether a week is cut short by the cycle it is being shown against.
 *
 * §5.3: never compute a week-over-week delta against a partial week — suppress
 * the comparison instead. Called with no cycle, a bare week is always whole;
 * "partial" is a statement about the pairing, not about the week.
 */
export function isPartialWeek(
  week: CivilDate,
  cycleAnchor?: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): boolean {
  if (!cycleAnchor) return false;
  const w = weekStart(week, s);
  const { start, end } = periodBounds("cycle", cycleAnchor, s);
  return w < start || addDays(w, 6) > end;
}
