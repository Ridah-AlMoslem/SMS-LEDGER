"use client";

/**
 * Day-of-week spending profile (SPEC §11.1 chart 6) — **week grain only**.
 *
 * "Average spend by weekday over the last 8 weeks. Usually reveals a Thu–Fri
 * weekend spike you can act on. Meaningless at cycle grain," which is why the
 * page does not render this component at all there rather than hiding it with
 * CSS: a chart that exists in the DOM at the wrong grain is a chart that will
 * eventually be shown at the wrong grain.
 *
 * Weeks here start Sunday (§5.2), so Fri–Sat land together at the right-hand
 * end instead of being split across the axis. That is the entire reason the
 * week was shifted off Postgres's Monday default, and it is visible here more
 * than anywhere else in the app.
 */

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AXIS, PLOT_MARGIN, TooltipCard, compactMoney, exactMoney } from "./chart-bits";
import { ChartFrame, ChartTable } from "./chart-frame";
import { CHART, WEEKDAY_NAMES } from "@/lib/chart-theme";

export type WeekdayPoint = {
  dow: number;
  label: string;
  average: number;
  total: number;
};

function WeekdayTooltip({
  active,
  payload,
  weeks,
}: {
  active?: boolean;
  payload?: { payload: WeekdayPoint }[];
  weeks: number;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={WEEKDAY_NAMES[p.dow]}
      note={`averaged over ${weeks} weeks`}
      rows={[
        { label: "Average", value: exactMoney(p.average), color: CHART.out },
        { label: "Total", value: exactMoney(p.total) },
      ]}
    />
  );
}

export function WeekdayProfile({ data, weeks }: { data: WeekdayPoint[]; weeks: number }) {
  // The Gulf weekend. Highlighted rather than annotated: the shape of this
  // chart is almost always "Thursday and Friday", and pointing at it in a
  // caption every week would be noise.
  const isWeekend = (dow: number) => dow === 4 || dow === 5;
  const peak = Math.max(...data.map((d) => d.average));

  return (
    <ChartFrame
      title="By day of week"
      hint={`Average spend per weekday over the last ${weeks} weeks.`}
      table={
        <ChartTable
          columns={["Day", "Average", "Total"]}
          rows={data.map((d) => [WEEKDAY_NAMES[d.dow], exactMoney(d.average), exactMoney(d.total)])}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={PLOT_MARGIN}>
          <XAxis dataKey="label" {...AXIS} interval={0} />
          <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
          <Tooltip content={<WeekdayTooltip weeks={weeks} />} cursor={{ fill: CHART.grid }} />
          <Bar dataKey="average" radius={[4, 4, 0, 0]} maxBarSize={28}>
            {data.map((d) => (
              <Cell
                key={d.dow}
                fill={CHART.out}
                // One channel, two readings: the weekend bars are the same hue
                // at full strength, the weekdays are stepped back. Colour is
                // not doing identity work here — the axis already names the day.
                fillOpacity={isWeekend(d.dow) ? 1 : d.average >= peak ? 1 : 0.55}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
