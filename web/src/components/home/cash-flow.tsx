"use client";

/**
 * Cash flow — income vs expense vs net (SPEC §11.1 chart 2).
 *
 * The note attached to that row of the SPEC's table is the whole design of this
 * component: **at week grain income spikes once per cycle, so most weeks show
 * zero income — three of every four bars look catastrophic.** That is a
 * presentation bug, not a finding. So the two grains draw different charts:
 *
 *   - **Cycle:** income and expense side by side with net as a line. All three
 *     are SAR on one axis; a second axis would be the single most common way to
 *     make two series look correlated when they are not.
 *   - **Week:** net only, with the cycle's income spread across its weeks as a
 *     reference line. The reference is what a week "should" be worth, and a
 *     zero-income week measured against it is a normal week, not a disaster.
 *
 * Partial buckets are hatched and say "3 of 7 days" in the tooltip (§5.3).
 */

import {
  Bar,
  BarChart,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AXIS,
  HatchDefs,
  Legend,
  PLOT_MARGIN,
  TooltipCard,
  compactMoney,
  exactMoney,
} from "./chart-bits";
import { ChartFrame, ChartTable } from "./chart-frame";
import { CHART } from "@/lib/chart-theme";
import type { Grain } from "@/lib/periods";

export type FlowPoint = {
  bucket: string;
  label: string;
  income: number;
  expense: number;
  net: number;
  /** §5.3 — fewer than a whole period's days. */
  partial: boolean;
  days: number;
  fullDays: number;
};

const HATCH_IN = "flow-hatch-in";
const HATCH_OUT = "flow-hatch-out";

function FlowTooltip({
  active,
  payload,
  grain,
}: {
  active?: boolean;
  payload?: { payload: FlowPoint }[];
  grain: Grain;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.label}
      note={p.partial ? `${p.days} of ${p.fullDays} days — not comparable` : undefined}
      rows={
        grain === "cycle"
          ? [
              { label: "In", value: exactMoney(p.income), color: CHART.in },
              { label: "Out", value: exactMoney(p.expense), color: CHART.out },
              { label: "Net", value: exactMoney(p.net) },
            ]
          : [
              { label: "Out", value: exactMoney(p.expense), color: CHART.out },
              { label: "In", value: exactMoney(p.income), color: CHART.in },
              { label: "Net", value: exactMoney(p.net) },
            ]
      }
    />
  );
}

export function CashFlow({
  grain,
  data,
  weeklyIncomeReference,
}: {
  grain: Grain;
  data: FlowPoint[];
  /** The cycle's income spread over its weeks. Only used at week grain. */
  weeklyIncomeReference: number | null;
}) {
  // Every other label at week grain: eight "9 Aug"-style ticks do not fit
  // across 390px, and rotating them costs more height than the chart has.
  const interval = data.length > 6 ? 1 : 0;

  const table = (
    <ChartTable
      columns={grain === "cycle" ? ["Period", "In", "Out", "Net"] : ["Week", "Out", "In", "Net"]}
      rows={data.map((p) =>
        grain === "cycle"
          ? [p.label, exactMoney(p.income), exactMoney(p.expense), exactMoney(p.net)]
          : [
              p.partial ? `${p.label} (${p.days}/${p.fullDays}d)` : p.label,
              exactMoney(p.expense),
              exactMoney(p.income),
              exactMoney(p.net),
            ],
      )}
    />
  );

  return (
    <ChartFrame
      title="Cash flow"
      hint={
        grain === "cycle"
          ? "Money in, money out, and what stayed."
          : "Net only — salary lands once a cycle, so most weeks have no income of their own. The dashed line is the cycle's income spread across its weeks."
      }
      table={table}
      legend={
        <Legend
          items={
            grain === "cycle"
              ? [
                  { key: "in", name: "In", color: CHART.in },
                  { key: "out", name: "Out", color: CHART.out },
                  { key: "net", name: "Net", color: CHART.ink },
                ]
              : [
                  { key: "net+", name: "Net saved", color: CHART.in },
                  { key: "net-", name: "Net spent", color: CHART.out },
                ]
          }
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        {grain === "cycle" ? (
          <ComposedChart data={data} margin={PLOT_MARGIN}>
            <HatchDefs id={HATCH_OUT} color={CHART.out} />
            <XAxis dataKey="label" {...AXIS} interval={interval} />
            <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
            <Tooltip content={<FlowTooltip grain={grain} />} cursor={{ fill: CHART.grid }} />
            <Bar dataKey="income" fill={CHART.in} radius={[4, 4, 0, 0]} maxBarSize={14} />
            <Bar dataKey="expense" radius={[4, 4, 0, 0]} maxBarSize={14}>
              {data.map((p) => (
                <Cell key={p.bucket} fill={p.partial ? `url(#${HATCH_OUT})` : CHART.out} />
              ))}
            </Bar>
            <Line
              type="monotone"
              dataKey="net"
              stroke={CHART.ink}
              strokeWidth={2}
              dot={{ r: 2.5, fill: CHART.ink }}
            />
          </ComposedChart>
        ) : (
          <BarChart data={data} margin={PLOT_MARGIN}>
            <HatchDefs id={HATCH_IN} color={CHART.in} />
            <XAxis dataKey="label" {...AXIS} interval={interval} />
            <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
            <Tooltip content={<FlowTooltip grain={grain} />} cursor={{ fill: CHART.grid }} />
            <ReferenceLine y={0} stroke={CHART.axis} />
            {weeklyIncomeReference !== null && (
              <ReferenceLine
                y={weeklyIncomeReference}
                stroke={CHART.in}
                strokeDasharray="4 3"
                label={{
                  value: "week's share of income",
                  position: "insideTopLeft",
                  fontSize: 11,
                  fill: CHART.axis,
                }}
              />
            )}
            <Bar dataKey="net" radius={[4, 4, 0, 0]} maxBarSize={22}>
              {data.map((p) => (
                <Cell
                  key={p.bucket}
                  fill={
                    p.partial
                      ? `url(#${HATCH_IN})`
                      : p.net >= 0
                        ? CHART.in
                        : CHART.out
                  }
                />
              ))}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </ChartFrame>
  );
}
