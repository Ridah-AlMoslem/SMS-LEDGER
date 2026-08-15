/**
 * Chart chrome, in one place.
 *
 * The colours themselves live in `globals.css` as custom properties — see the
 * block there for how each was chosen and validated. This module is the
 * TypeScript handle on them plus the two rules every chart in this app obeys:
 *
 *   1. **Slots are assigned in order and never skipped** (`seriesColorAt`).
 *      The palette is validated for *adjacent* pairs — the case where two
 *      bands of a stack touch — at ΔE 9.1 light and 8.4 dark under simulated
 *      protanopia. Assigning slots by anything other than position (a hash of
 *      the category id, say) lets non-adjacent slots become neighbours, and
 *      those are not safe: the same six colours fail all-pairs at ΔE 1.6 under
 *      deuteranopia. So one page decides the order once and every chart on it
 *      is handed the same map.
 *   2. **11px is the floor.** The design target is a 390px phone. An axis that
 *      does not fit drops or rotates its labels; it never shrinks below this,
 *      because a chart nobody can read is worse than a chart with fewer ticks.
 */

export const CHART = {
  /** Money in / money out — the brand pair, stepped per surface. */
  in: "var(--chart-in)",
  out: "var(--chart-out)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  /** A mark with no identity of its own — the net line over in/out bars. */
  ink: "var(--chart-ink)",
} as const;

/** Fixed order, assigned in sequence, never cycled. A 7th series folds into
 *  "Other" rather than inventing a colour — see `foldToOther` below. */
export const SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

/** Anything folded into "Other" is deliberately colourless — it is a residual,
 *  not a category, and giving it a hue invites reading it as one. */
export const OTHER_COLOR = "var(--chart-axis)";

export const HEAT = [
  "var(--chart-heat-1)",
  "var(--chart-heat-2)",
  "var(--chart-heat-3)",
  "var(--chart-heat-4)",
] as const;

export const HEAT_EMPTY = "var(--chart-heat-0)";

/** The smallest legible axis label at 390px. Never go below it — drop ticks. */
export const AXIS_FONT = 11;

/**
 * Sunday-first weekday initials, shared by the calendar heatmap and the
 * day-of-week profile.
 *
 * Defined once because the two charts sit on the same page and a reader will
 * compare them: if one started the week on Monday (Postgres's default, §5.2)
 * and the other on Sunday, the Thu–Fri weekend spike would appear in two
 * different places on the same screen.
 */
export const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const AXIS_TICK = { fontSize: AXIS_FONT, fill: CHART.axis } as const;

/**
 * The slot for the nth series, in order.
 *
 * Past the palette's six the answer is the residual grey rather than a
 * generated hue: a seventh colour is one nobody validated, and the honest fix
 * for a seventh series is `foldToOther`.
 */
export function seriesColorAt(index: number): string {
  return index < SERIES.length ? SERIES[index] : OTHER_COLOR;
}

/**
 * Sequential bucket for a magnitude, 0-based, against the ramp.
 *
 * `max` is the ramp's top. Zero is not the bottom step — it has no step at all,
 * because "nothing was spent" is categorically different from "a little was".
 */
export function heatColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return HEAT_EMPTY;
  const step = Math.min(HEAT.length - 1, Math.floor((value / max) * HEAT.length));
  return HEAT[step];
}

/**
 * Keep the first `n` series by size and sum the rest into "Other".
 *
 * §11.1's charts are read on a phone. Past five bands a stacked area is a
 * texture, and the palette's fixed order runs out at six by design.
 */
export function foldToOther<T extends { key: string; total: number }>(
  items: T[],
  n = 5,
): { kept: T[]; otherTotal: number } {
  const sorted = [...items].sort((a, b) => b.total - a.total);
  const kept = sorted.slice(0, n);
  return { kept, otherTotal: sorted.slice(n).reduce((s, x) => s + x.total, 0) };
}
