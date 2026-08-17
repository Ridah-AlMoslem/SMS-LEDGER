"use client";

/**
 * The four charts of SPEC §11.5, and the reasons each is the shape it is.
 *
 * They live in one module because they sit on one screen and share one palette
 * map. `lib/chart-theme.ts` is explicit that slots are assigned by position and
 * that "one page decides the order once and every chart on it is handed the
 * same map" — so `PRINCIPAL` and `PROFIT` are fixed here, and the growth band
 * is the same colour in the stacked area as the yield it produces is in the
 * rate chart.
 *
 * All four take figures computed by `lib/savings.ts`. Nothing here does
 * arithmetic on money beyond formatting it: the split between contributions and
 * growth is two independent running totals (§6), and a chart that re-derived it
 * from the balance would be the exact mistake that module exists to prevent.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
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
} from "@/components/home/chart-bits";
import { ChartFrame, ChartTable } from "@/components/home/chart-frame";
import { CHART, seriesColorAt } from "@/lib/chart-theme";

/** The two bands, in fixed slots. Adjacent in the stack, which is the pair the
 *  palette was validated on (`lib/chart-theme.ts`). */
export const PRINCIPAL = seriesColorAt(0);
export const PROFIT = seriesColorAt(1);

export type CyclePoint = {
  cycle: string;
  label: string;
  principal: number;
  profit: number;
  other: number;
  net: number;
  deposits: number;
  withdrawals: number;
  balance: number;
  /** The denominator §11.5 requires. Carried so the table can show what the
   *  rate was measured against — a yield with no denominator beside it is a
   *  number nobody can check. */
  averageDailyBalance: number;
  realizedYield: number | null;
  trailingYield: number | null;
  closingYield: number | null;
  coverage: number | null;
  partial: boolean;
};

const percent = (v: number | null, digits = 2) =>
  v === null ? "—" : `${(v * 100).toFixed(digits)}%`;

/* ------------------------------------------- 1. contributions vs growth */

function GrowthTooltip({ active, payload }: { active?: boolean; payload?: { payload: CyclePoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.label}
      note={p.partial ? "cycle still in progress" : undefined}
      rows={[
        { label: "What you put in", value: exactMoney(p.principal), color: PRINCIPAL },
        { label: "What it earned", value: exactMoney(p.profit), color: PROFIT },
        ...(p.other !== 0 ? [{ label: "Other", value: exactMoney(p.other) }] : []),
        { label: "Balance", value: exactMoney(p.balance) },
      ]}
    />
  );
}

/**
 * §11.5 — "the moment the growth band becomes visibly thick is the most
 * motivating chart in the app."
 *
 * Stacked, so the top of the stack is the balance and the upper band is
 * unambiguously the part you did not pay in. Profit compounds into the same
 * account as the principal, so this derived split is the only way to see what
 * the money actually earned — and it is derived from the two running totals,
 * never from the balance (§6).
 */
export function ContributionsVsGrowth({
  data,
  /** Non-zero when something that is neither a contribution nor profit moved
   *  the account — a hand-booked adjustment, a fee. Drawn rather than folded. */
  showOther,
}: {
  data: CyclePoint[];
  showOther: boolean;
}) {
  const last = data[data.length - 1];
  const earned = last?.profit ?? 0;

  return (
    <ChartFrame
      title="Contributions vs growth"
      hint="The lower band is money you moved in. The upper band is profit the account earned — it compounds into the same balance, so this split only exists because the two are counted separately."
      legend={
        <Legend
          items={[
            { key: "principal", name: "You put in", color: PRINCIPAL, value: exactMoney(last?.principal ?? 0) },
            { key: "profit", name: "It earned", color: PROFIT, value: exactMoney(earned) },
            ...(showOther
              ? [{ key: "other", name: "Adjustments", color: CHART.axis, value: exactMoney(last?.other ?? 0) }]
              : []),
          ]}
        />
      }
      table={
        <ChartTable
          columns={["Cycle", "Put in", "Earned", "Balance"]}
          rows={data.map((p) => [
            p.partial ? `${p.label} (so far)` : p.label,
            exactMoney(p.principal),
            exactMoney(p.profit),
            exactMoney(p.balance),
          ])}
        />
      }
      height={170}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={PLOT_MARGIN}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={data.length > 8 ? 1 : 0} />
          <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
          <Tooltip content={<GrowthTooltip />} cursor={{ stroke: CHART.grid }} />
          <Area
            type="monotone"
            dataKey="principal"
            stackId="balance"
            stroke={PRINCIPAL}
            fill={PRINCIPAL}
            fillOpacity={0.85}
          />
          <Area
            type="monotone"
            dataKey="profit"
            stackId="balance"
            stroke={PROFIT}
            fill={PROFIT}
            fillOpacity={0.85}
          />
          {showOther && (
            <Area
              type="monotone"
              dataKey="other"
              stackId="balance"
              stroke={CHART.axis}
              fill={CHART.axis}
              fillOpacity={0.5}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------ 2. net contribution */

const HATCH_NET = "savings-hatch-net";

function NetTooltip({ active, payload }: { active?: boolean; payload?: { payload: CyclePoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.label}
      note={p.partial ? "cycle still in progress" : undefined}
      rows={[
        { label: "In", value: exactMoney(p.deposits), color: CHART.in },
        { label: "Out", value: exactMoney(p.withdrawals), color: CHART.out },
        { label: "Net", value: exactMoney(p.net) },
      ]}
    />
  );
}

/**
 * §11.5 — "shown as a bar chart, not a progress ring."
 *
 * Two reasons, both stated there: net contribution **can be negative** (a cycle
 * where you drew savings down to cover spending is a real and valid result, not
 * a bug), and with no routine the interesting signal is the *variability*. A
 * ring shows neither — it cannot render a negative at all, and it implies a
 * target that does not exist.
 */
export function NetContribution({ data }: { data: CyclePoint[] }) {
  const total = data.reduce((sum, p) => sum + p.net, 0);
  const negatives = data.filter((p) => p.net < 0).length;

  return (
    <ChartFrame
      title="Net contribution per cycle"
      hint={
        negatives > 0
          ? `Deposits minus withdrawals. ${negatives} of these ${data.length} cycles went the other way — drawing savings down to cover a month is a real result, not an error.`
          : "Deposits minus withdrawals, per cycle. There is no target here: transfers in and out follow no routine, so the shape is the finding."
      }
      legend={
        <Legend
          items={[
            { key: "in", name: "Added", color: CHART.in },
            { key: "out", name: "Drawn down", color: CHART.out },
            { key: "sum", name: "Over the window", color: CHART.ink, value: exactMoney(total) },
          ]}
        />
      }
      table={
        <ChartTable
          columns={["Cycle", "In", "Out", "Net"]}
          rows={data.map((p) => [
            p.partial ? `${p.label} (so far)` : p.label,
            exactMoney(p.deposits),
            exactMoney(p.withdrawals),
            exactMoney(p.net),
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={PLOT_MARGIN}>
          <HatchDefs id={HATCH_NET} color={CHART.in} />
          <XAxis dataKey="label" {...AXIS} interval={data.length > 8 ? 1 : 0} />
          <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
          <Tooltip content={<NetTooltip />} cursor={{ fill: CHART.grid }} />
          <ReferenceLine y={0} stroke={CHART.axis} />
          <Bar dataKey="net" radius={[4, 4, 0, 0]} maxBarSize={20}>
            {data.map((p) => (
              <Cell
                key={p.cycle}
                // §5.3 — a cycle in progress is hatched. A part-month bar beside
                // whole ones reads as a collapse that has not happened.
                fill={p.partial ? `url(#${HATCH_NET})` : p.net >= 0 ? CHART.in : CHART.out}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------------- 3. realized yield */

function YieldTooltip({ active, payload }: { active?: boolean; payload?: { payload: CyclePoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.label}
      note={p.partial ? "cycle still in progress" : undefined}
      rows={[
        { label: "This cycle", value: percent(p.realizedYield), color: PROFIT },
        { label: "3-cycle average", value: percent(p.trailingYield), color: CHART.ink },
        { label: "Profit", value: exactMoney(p.profit) },
        { label: "Avg daily balance", value: exactMoney(p.averageDailyBalance) },
      ]}
    />
  );
}

/**
 * §11.5 — "the only meaningful rate measure when profit is variable."
 *
 * `(profit ÷ average DAILY balance) × 12`. The daily part is the whole point:
 * a large deposit halfway through a cycle earns for half of it, and dividing by
 * the closing balance would report a rate near zero for a month that performed
 * normally. `lib/savings.ts` computes both and the verification script asserts
 * they differ — this chart is only ever handed the average-daily one.
 *
 * The trailing three-cycle line is what should be read; a single cycle of a
 * variable rate tells you nothing.
 */
export function RealizedYield({ data }: { data: CyclePoint[] }) {
  const latest = [...data].reverse().find((p) => p.trailingYield !== null);

  return (
    <ChartFrame
      title="Realized yield"
      hint="Profit against the average daily balance, annualised. Read the average — one cycle of a variable rate is noise."
      legend={
        <Legend
          items={[
            { key: "cycle", name: "Per cycle", color: PROFIT },
            {
              key: "avg",
              name: "3-cycle average",
              color: CHART.ink,
              value: percent(latest?.trailingYield ?? null),
            },
          ]}
        />
      }
      table={
        <ChartTable
          columns={["Cycle", "Profit", "Avg daily balance", "Yield", "3-cycle"]}
          rows={data.map((p) => [
            p.partial ? `${p.label} (so far)` : p.label,
            exactMoney(p.profit),
            exactMoney(p.averageDailyBalance),
            percent(p.realizedYield),
            percent(p.trailingYield),
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={PLOT_MARGIN}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={data.length > 8 ? 1 : 0} />
          <YAxis
            {...AXIS}
            width={38}
            tickCount={4}
            tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
          />
          <Tooltip content={<YieldTooltip />} cursor={{ stroke: CHART.grid }} />
          <Bar dataKey="realizedYield" fill={PROFIT} radius={[3, 3, 0, 0]} maxBarSize={14} />
          <Line
            type="monotone"
            dataKey="trailingYield"
            stroke={CHART.ink}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ---------------------------------------------------- 4. passive coverage */

/**
 * §11.5 — "your savings currently pays for 2% of your life."
 *
 * Home shows this cycle's figure; here it gets its trend, which is the half
 * that makes it feel like something moving rather than a small number. The
 * denominator is what the whole cycle cost, across every account — coverage
 * measured against this account's own spending would be a ratio of savings to
 * savings.
 */
function CoverageTooltip({ active, payload }: { active?: boolean; payload?: { payload: CyclePoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.label}
      rows={[
        { label: "Covers", value: percent(p.coverage, 1), color: PROFIT },
        { label: "Profit", value: exactMoney(p.profit) },
      ]}
    />
  );
}

export function PassiveCoverage({ data }: { data: CyclePoint[] }) {
  const measured = data.filter((p) => p.coverage !== null);
  const latest = measured[measured.length - 1];

  return (
    <ChartFrame
      title="What your savings pays for"
      hint="Profit as a share of everything the cycle cost. Small now; the shape is what matters."
      legend={
        <Legend
          items={[
            {
              key: "coverage",
              name: "Share of a cycle's spending",
              color: PROFIT,
              value: percent(latest?.coverage ?? null, 1),
            },
          ]}
        />
      }
      table={
        <ChartTable
          columns={["Cycle", "Profit", "Covers"]}
          rows={data.map((p) => [p.label, exactMoney(p.profit), percent(p.coverage, 1)])}
        />
      }
      height={120}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={PLOT_MARGIN}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={data.length > 8 ? 1 : 0} />
          <YAxis
            {...AXIS}
            width={38}
            tickCount={3}
            tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
          />
          <Tooltip content={<CoverageTooltip />} cursor={{ stroke: CHART.grid }} />
          <Area
            type="monotone"
            dataKey="coverage"
            stroke={PROFIT}
            fill={PROFIT}
            fillOpacity={0.3}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
