"use client";

/**
 * What this account's balance has actually been said to be.
 *
 * Not a derived series. Every point is a `balance_snapshots` row — either the
 * bank printing a figure in a message, or a person typing one in (§3.3b). The
 * two are drawn differently and named in the legend, because they are different
 * kinds of claim: one is independent verification, the other is you. An account
 * whose line is entirely your own points has no verification at all, and that
 * has to be visible rather than inferred.
 *
 * Balances are carried forward between points — a bank that has gone quiet has
 * not lost your money. Interpolating instead would invent movements no message
 * recorded, which is the same reasoning `lib/net-worth.ts` gives for the
 * dashboard's own series.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AXIS, PLOT_MARGIN, TooltipCard, compactMoney, exactMoney } from "@/components/home/chart-bits";
import { ChartFrame, ChartTable } from "@/components/home/chart-frame";
import { CHART, seriesColorAt } from "@/lib/chart-theme";
import { type CivilDate, civilShort } from "@/lib/periods";

export type BalancePoint = {
  day: CivilDate;
  balance: number;
  source: "sms" | "manual" | "computed";
};

const SOURCE_LABEL: Record<BalancePoint["source"], string> = {
  sms: "stated by the bank",
  manual: "entered by hand",
  computed: "derived from the ledger",
};

type Row = { day: CivilDate; label: string; balance: number; source: BalancePoint["source"] };

function BalanceTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <TooltipCard
      title={p.label}
      note={SOURCE_LABEL[p.source]}
      rows={[{ label: "Balance", value: exactMoney(p.balance) }]}
    />
  );
}

export function BalanceHistory({
  points,
  /** What the ledger makes the balance right now, for the reference note. */
  current,
}: {
  points: BalancePoint[];
  current: number;
}) {
  const rows: Row[] = points.map((p) => ({
    day: p.day,
    label: civilShort(p.day),
    balance: p.balance,
    source: p.source,
  }));

  const manual = rows.filter((r) => r.source === "manual").length;
  const line = seriesColorAt(0);

  // Every other tick past six points: eight "9 Aug"-style labels do not fit
  // across 390px, and rotating them costs more height than the chart has.
  const interval = rows.length > 6 ? Math.ceil(rows.length / 5) - 1 : 0;

  return (
    <ChartFrame
      title="Balance history"
      hint={
        manual === rows.length && rows.length > 0
          ? "Every point here is a balance you entered by hand — this bank states none of its own."
          : "Each point is a balance that was actually stated. The line between them carries forward; a quiet bank is not a movement."
      }
      legend={
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: line }} />
            <span className="opacity-70">Stated by the bank</span>
          </li>
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-full border-2"
              style={{ borderColor: line }}
            />
            <span className="opacity-70">Entered by hand</span>
          </li>
          <li className="opacity-50">
            ledger says <span className="tabular">{exactMoney(current)}</span> now
          </li>
        </ul>
      }
      table={
        <ChartTable
          columns={["Day", "Balance", "Source"]}
          rows={rows.map((r) => [r.label, exactMoney(r.balance), SOURCE_LABEL[r.source]])}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={PLOT_MARGIN}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={interval} />
          <YAxis {...AXIS} tickFormatter={compactMoney} width={38} tickCount={4} />
          <Tooltip content={<BalanceTooltip />} cursor={{ stroke: CHART.grid }} />
          <Line
            type="stepAfter"
            dataKey="balance"
            stroke={line}
            strokeWidth={2}
            // A hand-entered point is hollow. Identity is never colour alone,
            // and here the distinction is the point of the chart.
            dot={(props: { cx?: number; cy?: number; payload?: Row; index?: number }) => (
              <circle
                key={props.payload?.day ?? props.index}
                cx={props.cx}
                cy={props.cy}
                r={3}
                fill={props.payload?.source === "manual" ? "var(--background)" : line}
                stroke={line}
                strokeWidth={2}
              />
            )}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
