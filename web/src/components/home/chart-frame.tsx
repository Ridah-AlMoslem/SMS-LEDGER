"use client";

/**
 * The card every chart below the fold sits in, and the way each one opens full
 * screen.
 *
 * A 390px-wide chart is a summary. The detail — a longer window, the series
 * toggles, the numbers behind the marks — lives in the sheet this opens, which
 * is the same pattern the rest of the app uses for detail (`ui/sheet.tsx`: on a
 * phone, layers come up from the bottom, where the thumb is).
 *
 * `table` is not optional decoration. Three of the light-mode categorical steps
 * sit below 3:1 against white, and the colour method this app follows makes a
 * table view or visible labels the required relief for exactly that case. It is
 * also the only form of these charts a screen reader can read, so it renders in
 * the sheet for every chart that has more than one series.
 */

import { useState } from "react";

import { Sheet } from "@/components/ui/sheet";

export function ChartFrame({
  title,
  hint,
  filters,
  table,
  legend,
  height = 150,
  expandedHeight = 300,
  tapToExpand = true,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  /** Shown only in the sheet — a 390px card has no room for controls. */
  filters?: React.ReactNode;
  /** The same data as text. Required for multi-series charts; see above. */
  table?: React.ReactNode;
  /** Sits under the plot, outside its fixed height. A legend inside the plot
   *  box would either shrink the chart or overflow it. */
  legend?: React.ReactNode;
  /**
   * A recharts `ResponsiveContainer` has no size of its own and must be given
   * one. Anything that sizes itself — the calendar heatmap is a CSS grid of
   * square cells, so its height follows the viewport width — passes `"auto"`
   * and lays out normally. Giving that a fixed height clips six weeks of
   * calendar into the chart underneath it.
   */
  height?: number | "auto";
  expandedHeight?: number | "auto";
  /** False where the chart's own marks are the tap targets — a heatmap day
   *  opens the ledger for that day, and swallowing that into "expand" would
   *  take away the drill-through that makes the figure trustworthy. */
  tapToExpand?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">{title}</h2>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 text-xs opacity-55 underline underline-offset-2 hover:opacity-100"
          >
            expand
          </button>
        </div>

        {hint && <p className="mt-1 text-xs opacity-55">{hint}</p>}

        <div
          style={height === "auto" ? undefined : { height }}
          className="mt-2"
          // The whole plot is the tap target on a phone; the button above is
          // what keyboard and screen-reader users get, since a div with a click
          // handler is not a control.
          onClick={tapToExpand ? () => setOpen(true) : undefined}
        >
          {children}
        </div>

        {legend}
      </section>

      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        {filters && <div className="mb-3">{filters}</div>}
        <div style={expandedHeight === "auto" ? undefined : { height: expandedHeight }}>{children}</div>
        {legend}
        {table && <div className="mt-4">{table}</div>}
      </Sheet>
    </>
  );
}

/**
 * A plain table of what the chart above shows.
 *
 * Deliberately unstyled beyond alignment: this is the fallback reading of the
 * data, and a table that tries to look like a chart is neither.
 */
export function ChartTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: (React.ReactNode | string | number)[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-xs opacity-60 dark:border-white/15">
            {columns.map((c, i) => (
              <th key={c} className={`py-1.5 font-medium ${i === 0 ? "" : "text-right"}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-black/5 dark:divide-white/10">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={`py-1.5 ${j === 0 ? "" : "text-right tabular"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
