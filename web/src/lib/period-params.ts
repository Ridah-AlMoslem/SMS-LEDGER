/**
 * The global Week/Cycle state, as URL search params (SPEC §11.1).
 *
 *   ?grain=week|cycle&period=<ISO date>
 *
 * The URL is the source of truth, not a store. That buys three things a
 * React context would not: every view is linkable ("look at this cycle"), the
 * back button steps through periods the way a user expects, and a server
 * component can read the selection from `searchParams` without a round trip
 * to the client.
 *
 * localStorage remembers only the *grain*, and only as a fallback for when the
 * param is absent — the first load of a session. It deliberately does not
 * remember the period: coming back tomorrow to a dashboard silently pinned to
 * last month is how you end up reading stale numbers as current ones.
 *
 * Pure and dependency-free so both the client components and the server pages
 * can use it, and so it can be tested without a browser.
 */

import {
  type CivilDate,
  type Grain,
  isGrain,
  periodBounds,
  today,
} from "./periods.ts";
import { DEFAULT_SETTINGS, type PeriodSettings } from "./settings.ts";

export const GRAIN_PARAM = "grain";
export const PERIOD_PARAM = "period";

/** Namespaced: localStorage is shared across everything on the origin. */
export const GRAIN_STORAGE_KEY = "sms-ledger:grain";

export const DEFAULT_GRAIN: Grain = "cycle";

/** Anything with a `.get()`: URLSearchParams, Next's ReadonlyURLSearchParams. */
type Readable = { get(name: string): string | null };

/** A plain object as handed to a page's `searchParams`. */
export type SearchParamsInput = Record<string, string | string[] | undefined>;

export function asReadable(input: Readable | SearchParamsInput): Readable {
  if (typeof (input as Readable).get === "function") return input as Readable;
  const record = input as SearchParamsInput;
  return {
    get: (name) => {
      const v = record[name];
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    },
  };
}

/** The grain in the URL, or null when it says nothing. Junk is not an error —
 *  a hand-edited URL falls back rather than throwing a page away. */
export function readGrain(params: Readable | SearchParamsInput): Grain | null {
  const raw = asReadable(params).get(GRAIN_PARAM);
  return isGrain(raw) ? raw : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The period anchor in the URL, normalised to the start of its period.
 *
 * Normalising matters: `?period=2026-08-11` and `?period=2026-07-25` name the
 * same cycle, and if they produced different anchors the prev/next steppers
 * would drift and two links to "the same" period would not compare equal.
 * Falls back to the period containing today.
 */
export function readPeriod(
  params: Readable | SearchParamsInput,
  grain: Grain,
  now: Date = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): CivilDate {
  const raw = asReadable(params).get(PERIOD_PARAM);
  const anchor = raw && ISO.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : today(now, s);
  return periodBounds(grain, anchor, s).start;
}

/** Both halves of the selection, resolved. What every page actually wants. */
export function readSelection(
  params: Readable | SearchParamsInput,
  now: Date = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): { grain: Grain; period: CivilDate } {
  const grain = readGrain(params) ?? DEFAULT_GRAIN;
  return { grain, period: readPeriod(params, grain, now, s) };
}

/**
 * The current query string with the selection replaced.
 *
 * Every other param is carried through untouched, so a period stepper does not
 * silently drop an account filter — the two are independent selections and the
 * URL has to keep them that way.
 */
export function withSelection(
  current: Readable | URLSearchParams | SearchParamsInput,
  grain: Grain,
  period: CivilDate,
): string {
  const next =
    current instanceof URLSearchParams
      ? new URLSearchParams(current)
      : new URLSearchParams(
          Object.entries(current as SearchParamsInput).flatMap(([k, v]) =>
            v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]],
          ),
        );

  next.set(GRAIN_PARAM, grain);
  next.set(PERIOD_PARAM, period);
  return next.toString();
}

/**
 * Re-anchor when the grain changes.
 *
 * Switching from a cycle to a week must land somewhere meaningful. If the
 * period being viewed contains today, stay on today — that is almost always
 * what "switch to weekly" means. Otherwise anchor on the start of what was
 * being viewed, so browsing history at one grain continues at the other
 * instead of jumping back to now.
 */
export function reanchor(
  from: Grain,
  fromPeriod: CivilDate,
  to: Grain,
  now: Date = new Date(),
  s: PeriodSettings = DEFAULT_SETTINGS,
): CivilDate {
  const { start, end } = periodBounds(from, fromPeriod, s);
  const at = today(now, s);
  const anchor = at >= start && at <= end ? at : start;
  return periodBounds(to, anchor, s).start;
}

/* --------------------------------------------------------- persistence */

/** Reads the remembered grain. Never throws: Safari private mode makes
 *  localStorage access itself raise, and a nav bar is not worth a crash. */
export function loadGrain(): Grain | null {
  try {
    const raw = window.localStorage.getItem(GRAIN_STORAGE_KEY);
    return isGrain(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveGrain(grain: Grain): void {
  try {
    window.localStorage.setItem(GRAIN_STORAGE_KEY, grain);
  } catch {
    /* storage disabled; the URL still carries the selection */
  }
}
