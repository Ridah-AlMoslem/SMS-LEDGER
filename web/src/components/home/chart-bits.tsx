"use client";

/**
 * The pieces every recharts chart on this page shares.
 *
 * Kept together so the axis rules are decided once. The design target is a
 * 390px phone, which means:
 *
 *   - **11px is the floor for a tick label** (`AXIS_FONT`). A chart that does
 *     not fit drops ticks or rotates them; it never shrinks the type, because
 *     an unreadable label is worse than an absent one.
 *   - **Amounts on an axis are compact** — "1.2k", not "1,200.00". The exact
 *     figure lives in the tooltip and in the table view; an axis is a scale.
 *   - **Partial buckets are hatched** (§5.3). A 1-day bar beside 7-day bars
 *     reads as a spending collapse that never happened, and colour alone cannot
 *     say "this one is not comparable" — the texture can.
 */

import { AXIS_FONT, CHART } from "@/lib/chart-theme";

export const AXIS = {
  tick: { fontSize: AXIS_FONT, fill: CHART.axis },
  tickLine: false,
  axisLine: false,
} as const;

/**
 * Plot margins.
 *
 * `left: 0`, not a negative margin. Pulling the plot left to reclaim the axis
 * gutter is the usual recharts trick and it clips the widest tick — "10.5K"
 * renders as ".5K", which reads as a different number rather than as a cropped
 * one. The gutter is 38px and the ticks are capped at four, which is what makes
 * that fit at 390px.
 *
 * The right margin is for the last tick, not for whitespace: an area chart puts
 * its final point on the plot's right edge, and a label centred there loses its
 * last character — "Aug" renders as "Au".
 */
export const PLOT_MARGIN = { top: 4, right: 12, bottom: 0, left: 0 } as const;

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const compactMoney = (n: number) => COMPACT.format(n);

const EXACT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const exactMoney = (n: number) =>
  `${n < 0 ? "−" : ""}${EXACT.format(Math.abs(n))}`;

/**
 * The 45° hatch used for any bucket that is not a whole period.
 *
 * An SVG pattern rather than a CSS one: it has to live inside the chart's own
 * `<defs>` to be referenceable by a `fill` on a recharts mark.
 */
export function HatchDefs({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <pattern id={id} width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill={color} fillOpacity={0.25} />
        <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="3" />
      </pattern>
    </defs>
  );
}

export function TooltipCard({
  title,
  note,
  rows,
}: {
  title: string;
  note?: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  return (
    <div className="rounded-lg border border-black/10 bg-[var(--background)] px-2.5 py-2 text-xs shadow-lg dark:border-white/15">
      <p className="font-medium">{title}</p>
      {note && <p className="mt-0.5 opacity-60">{note}</p>}
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline gap-2">
            {r.color && (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: r.color }}
              />
            )}
            <span className="opacity-60">{r.label}</span>
            <span className="tabular ml-auto">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Identity is never carried by colour alone: every multi-series chart here
 * ships this legend, and it carries the period total beside each swatch so the
 * chart is readable as text when the fill is not.
 */
export function Legend({
  items,
}: {
  items: { key: string; name: string; color: string; value?: string }[];
}) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
      {items.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: s.color }}
          />
          <span className="sms-body opacity-70">{s.name}</span>
          {s.value && <span className="tabular opacity-50">{s.value}</span>}
        </li>
      ))}
    </ul>
  );
}
