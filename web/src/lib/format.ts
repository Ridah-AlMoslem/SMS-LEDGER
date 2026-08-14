/**
 * Date and time display, in the configured zone.
 *
 * Every `Intl.DateTimeFormat` in the app comes from here, because every one of
 * them needs the timezone from `settings` and none of them should name it. A
 * formatter built with a literal "Asia/Riyadh" is a second opinion about when
 * a day starts: change the anchor in settings and the buckets move while the
 * timestamps beside them do not, which is the kind of disagreement nobody
 * notices until they are reconciling by hand at the 24th/25th boundary.
 *
 * SPEC §5.5 — "Both anchors are configurable but read from one place, never
 * inline the literals." `src/lib/settings.ts` is that place; this module and
 * `periods.ts` are its only consumers.
 *
 * Formatters are cached: constructing one is expensive enough to matter in a
 * list of 200 transactions, and they are immutable once built.
 */

import { DEFAULT_SETTINGS, type PeriodSettings } from "./settings.ts";

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions, tz: string) {
  const key = `${locale}|${tz}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz });
    cache.set(key, f);
  }
  return f;
}

/** "13 Aug, 09:30" — a ledger row that is already grouped by day. */
export function timeOfDay(d: Date, s: PeriodSettings = DEFAULT_SETTINGS): string {
  return formatter(
    "en-GB",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false },
    s.timezone,
  ).format(d);
}

/** "Thu 13 Aug, 09:30" — a flat list where the weekday is the fastest way to
 *  place a transaction, since spending has a strong weekday shape (§11.1). */
export function weekdayTime(d: Date, s: PeriodSettings = DEFAULT_SETTINGS): string {
  return formatter(
    "en-GB",
    {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    },
    s.timezone,
  ).format(d);
}

/** "13 Aug 2026" — no time. For an as-of date, where the hour is noise. */
export function dayMonthYear(d: Date, s: PeriodSettings = DEFAULT_SETTINGS): string {
  return formatter(
    "en-GB",
    { day: "numeric", month: "short", year: "numeric" },
    s.timezone,
  ).format(d);
}
