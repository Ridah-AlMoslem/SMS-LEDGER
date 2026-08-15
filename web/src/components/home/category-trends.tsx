"use client";

/**
 * Category trends, stacked area (SPEC §11.1 chart 3).
 *
 * §5.4: "Raw weekly category breakdowns swing wildly on a single large
 * purchase. Default trend charts to a rolling 4-week average, with raw weekly
 * available as a toggle." So at week grain the smoothed series is what loads,
 * and raw is one tap away in the expanded sheet — the toggle is a filter, and
 * filters live where there is room for them.
 *
 * Five categories plus "Other". The palette has six fixed slots and a stacked
 * area with more bands than that is a texture, not a chart; the residual is
 * deliberately grey so it never reads as a category of its own.
 */

import { useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AXIS, Legend, PLOT_MARGIN, TooltipCard, compactMoney, exactMoney } from "./chart-bits";
import { ChartFrame, ChartTable } from "./chart-frame";
import { Chip } from "@/components/ui/chip";
import { CHART } from "@/lib/chart-theme";
import type { Grain } from "@/lib/periods";

export type TrendSeries = { key: string; name: string; color: string };

export type TrendPoint = {
  bucket: string;
  label: string;
  /** One entry per series key, plus whatever the caller smoothed. */
  [key: string]: string | number;
};

function TrendTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: { payload: TrendPoint }[];
  label?: string;
  series: TrendSeries[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <TooltipCard
      title={String(label ?? point.label)}
      rows={series
        .map((s) => ({
          label: s.name,
          value: exactMoney(Number(point[s.key] ?? 0)),
          color: s.color,
        }))
        .filter((r) => r.value !== "0.00")}
    />
  );
}

export function CategoryTrends({
  grain,
  raw,
  smoothed,
  series,
  totals,
}: {
  grain: Grain;
  raw: TrendPoint[];
  /** Rolling 4-bucket mean. Same shape as `raw`; null at cycle grain, where a
   *  six-point series has nothing to smooth. */
  smoothed: TrendPoint[] | null;
  series: TrendSeries[];
  /** Period totals per series, printed on the legend — the relief channel for
   *  the light-mode steps that sit below 3:1. */
  totals: Record<string, number>;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const data = smoothed && !showRaw ? smoothed : raw;

  if (series.length === 0) return null;

  const legend = (
    <Legend
      items={series.map((s) => ({
        key: s.key,
        name: s.name,
        color: s.color,
        value: exactMoney(totals[s.key] ?? 0),
      }))}
    />
  );

  return (
    <ChartFrame
      title="Category trends"
      hint={
        smoothed && !showRaw
          ? "Rolling 4-week average — a single large purchase would otherwise swing the whole line."
          : undefined
      }
      legend={legend}
      table={
        <ChartTable
          columns={[grain === "cycle" ? "Cycle" : "Week", ...series.map((s) => s.name)]}
          rows={data.map((p) => [
            p.label,
            ...series.map((s) => exactMoney(Number(p[s.key] ?? 0))),
          ])}
        />
      }
      filters={
        smoothed ? (
          <div className="flex gap-2">
            <Chip selected={!showRaw} onClick={() => setShowRaw(false)}>
              4-week average
            </Chip>
            <Chip selected={showRaw} onClick={() => setShowRaw(true)}>
              Raw weekly
            </Chip>
          </div>
        ) : undefined
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={PLOT_MARGIN}>
          <XAxis dataKey="label" {...AXIS} interval={data.length > 6 ? 1 : 0} />
          <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
          <Tooltip content={<TrendTooltip series={series} />} cursor={{ stroke: CHART.axis }} />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stackId="spend"
              // The band is separated from its neighbour by a 2px line in the
              // page's own background colour rather than by a darker edge of
              // itself: adjacent fills that touch read as one band, and a gap
              // in the surface colour is the separation that survives both
              // themes and colour-blind simulation.
              stroke="var(--background)"
              strokeWidth={2}
              fill={s.color}
              fillOpacity={0.9}
              activeDot={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
