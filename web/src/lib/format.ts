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

/* ------------------------------------------------- editing an instant */

/**
 * An instant as `<input type="datetime-local">` wants it: `2026-08-13T09:30`,
 * with the wall clock reading in the configured zone.
 *
 * The browser's own zone is wrong here. A phone in another country editing a
 * transaction would be shown a time three hours from the one printed in the
 * SMS, and would save a different instant than the one it displayed.
 */
export function toLocalInput(d: Date, s: PeriodSettings = DEFAULT_SETTINGS): string {
  const parts = formatter(
    "en-CA",
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      // h23 rather than hour12:false: some ICU versions render midnight as 24
      // under the latter, and "2026-08-13T24:00" is not a value any input
      // accepts.
      hourCycle: "h23",
    },
    s.timezone,
  )
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The inverse: a wall clock in the configured zone back to an instant.
 *
 * Read the offset from the zone rather than hardcoding +03:00. Riyadh has no
 * DST — §13 lists "DST-free but timezone-sensitive midnight transactions" as
 * its own fixture — so the offset taken at the approximate instant is the
 * offset at the true one, and the two-step resolution below is exact. In a zone
 * with DST it would be ambiguous for one hour a year, which is why the offset
 * is derived instead of assumed.
 */
export function fromLocalInput(
  value: string,
  s: PeriodSettings = DEFAULT_SETTINGS,
): Date | null {
  if (!LOCAL_INPUT.test(value)) return null;

  const asIfUtc = new Date(`${value}:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;

  return new Date(asIfUtc.getTime() - offsetMinutes(asIfUtc, s.timezone) * 60_000);
}

/** Minutes east of UTC in `tz` at `at`. Read from Intl, never from a table. */
function offsetMinutes(at: Date, tz: string): number {
  const name = formatter("en-GB", { timeZoneName: "longOffset" }, tz)
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;

  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
