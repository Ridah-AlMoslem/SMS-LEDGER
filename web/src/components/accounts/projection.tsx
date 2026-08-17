"use client";

/**
 * Compounding projection — SPEC §11.5, "show it as a **range**, not a line."
 *
 * The variable rate is the reason. A single projected line reads as a promise,
 * and this account's rate is whatever the bank decides each month; the band is
 * one standard deviation of the yields it has actually paid, compounded
 * forward. When there is not enough history for that to mean anything, the
 * chart says so rather than drawing a confident-looking hairline (`grounded`).
 *
 * The slider is §11.5's "what if I add 500 more per cycle". It moves the
 * contribution, never the rate — a rate you can choose is a fantasy generator,
 * and the one number here that is genuinely under your control is how much you
 * put in.
 */

import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AXIS, PLOT_MARGIN, TooltipCard, exactMoney } from "@/components/home/chart-bits";
import { ChartFrame, ChartTable } from "@/components/home/chart-frame";
import { CHART } from "@/lib/chart-theme";
import { project } from "@/lib/savings";

import { PROFIT } from "./savings-charts";

/** The step §11.5 names, and a range either side of it. */
const STEPS = [0, 250, 500, 1000, 2000];

/** "529K". Whole thousands, so a six-figure projection fits the axis gutter. */
const WHOLE_K = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

type Point = {
  cycle: number;
  label: string;
  low: number;
  mid: number;
  high: number;
};

function ProjectionTooltip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.cycle === 0 ? "Today" : `In ${p.cycle} ${p.cycle === 1 ? "cycle" : "cycles"}`}
      rows={[
        { label: "If the rate holds up", value: exactMoney(p.high) },
        { label: "Middle", value: exactMoney(p.mid), color: PROFIT },
        { label: "If it drops off", value: exactMoney(p.low) },
      ]}
    />
  );
}

export function Projection({
  balance,
  yields,
  contribution,
  cycles = 24,
}: {
  balance: number;
  /** Realized yields per cycle, annualised. Nulls are dropped. */
  yields: (number | null)[];
  /** Trailing-average net contribution per cycle. Signed. */
  contribution: number;
  cycles?: number;
}) {
  const [extra, setExtra] = useState(0);

  const projection = project({ balance, yields, contribution, extra, cycles });

  const data: Point[] = projection.points.map((p) => ({
    cycle: p.cycle,
    label: p.cycle % 6 === 0 ? (p.cycle === 0 ? "now" : `${p.cycle / 12 >= 1 ? `${p.cycle / 12}y` : `+${p.cycle}`}`) : "",
    low: p.low,
    mid: p.mid,
    high: p.high,
  }));

  const end = projection.points[projection.points.length - 1];
  const rate = (v: number) => `${(v * 100).toFixed(2)}%`;

  // Computed here rather than left to recharts' "auto". The band between the
  // two rates is a few percent of the balance, and against a zero baseline it
  // collapses into the line §11.5 asks this chart not to be. Anchoring the
  // floor just below today's balance spends the plot's height on the growth,
  // which is the only thing being asked about.
  const floor = Math.max(0, Math.min(balance, end.low) * 0.96);
  const ceiling = end.high * 1.02;

  return (
    <ChartFrame
      title="If this carries on"
      hint={
        projection.grounded
          ? `Between ${rate(projection.rate.low)} and ${rate(projection.rate.high)} a year — the spread this account has actually paid — plus ${exactMoney(projection.contribution)} a cycle.`
          : `Only ${projection.observations} ${projection.observations === 1 ? "cycle" : "cycles"} of profit so far. The band below is drawn from too little history to be a forecast; it is what would happen if the little that has been seen kept happening.`
      }
      filters={
        <fieldset>
          <legend className="text-xs opacity-70">Add per cycle</legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STEPS.map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => setExtra(step)}
                aria-pressed={extra === step}
                className={`rounded-full border px-3 py-1 text-xs ${
                  extra === step
                    ? "border-transparent bg-black/[0.08] font-medium dark:bg-white/[0.14]"
                    : "border-black/10 opacity-70 hover:opacity-100 dark:border-white/20"
                }`}
              >
                {step === 0 ? "as now" : `+${step.toLocaleString("en-US")}`}
              </button>
            ))}
          </div>
        </fieldset>
      }
      legend={
        <div className="mt-2 space-y-2">
          <label className="block text-[11px]">
            <span className="flex items-baseline justify-between">
              <span className="opacity-70">Add per cycle</span>
              <span className="tabular font-medium">
                {extra === 0 ? "nothing extra" : `+${extra.toLocaleString("en-US")}`}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={2000}
              step={50}
              value={extra}
              onChange={(e) => setExtra(Number(e.target.value))}
              className="mt-1 w-full accent-emerald-500"
              aria-label="Extra contribution per cycle"
            />
          </label>

          <p className="text-[11px] opacity-70">
            In {cycles / 12} {cycles / 12 === 1 ? "year" : "years"}:{" "}
            <span className="tabular font-medium">{exactMoney(end.low)}</span> to{" "}
            <span className="tabular font-medium">{exactMoney(end.high)}</span>
            {!projection.grounded && <span className="opacity-70"> — on very little history</span>}
          </p>
        </div>
      }
      table={
        <ChartTable
          columns={["Cycles ahead", "Low", "Middle", "High"]}
          rows={projection.points
            .filter((p) => p.cycle % 6 === 0)
            .map((p) => [
              p.cycle === 0 ? "now" : String(p.cycle),
              exactMoney(p.low),
              exactMoney(p.mid),
              exactMoney(p.high),
            ])}
        />
      }
      height={150}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={PLOT_MARGIN}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={0} />
          {/* The baseline is today's balance, and the x-axis labels it "now" —
              the truncation is stated rather than smuggled.

              Whole thousands, not one decimal: these figures run to six digits
              and "529.3K" does not fit the 38px gutter `chart-bits` fixes for
              390px. It renders as "29.3K", which is not a cropped label, it is
              a different number. */}
          <YAxis
            {...AXIS}
            tickFormatter={(v: number) => WHOLE_K.format(v)}
            width={38}
            tickCount={4}
            domain={[floor, ceiling]}
          />
          <Tooltip content={<ProjectionTooltip />} cursor={{ stroke: CHART.grid }} />
          {/* A range area: recharts takes a [min, max] pair per point, which is
              the band itself rather than two areas stacked to imply one. The
              stacked version forces the y-domain to include zero, and against a
              zero baseline a band a few percent wide is a line. */}
          <Area
            type="monotone"
            dataKey={(p: Point) => [p.low, p.high]}
            stroke={PROFIT}
            strokeOpacity={0.55}
            strokeWidth={1}
            fill={PROFIT}
            fillOpacity={0.3}
            isAnimationActive={false}
          />
          {/* Dotted and thin: the band is the answer, and a solid centre line
              through it is exactly the single number §11.5 calls false
              precision. It is here to be read as the middle of a range. */}
          <Line
            type="monotone"
            dataKey="mid"
            stroke={PROFIT}
            strokeWidth={1.5}
            strokeDasharray="2 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
