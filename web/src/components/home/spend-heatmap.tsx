/**
 * Daily-spend calendar (SPEC §11.1 chart 1 — "best information density on the
 * page").
 *
 * Grain-agnostic by construction: a day is a day at either grain, so this shows
 * the cycle it is looking at, padded out to whole weeks, and highlights the
 * selected week when the grain is weekly. **The rule on the 24/25 boundary is
 * the point** — it is the one place on the dashboard where you can see that the
 * month this app reports is not the month on the wall.
 *
 * Not recharts. A calendar is a grid of links, and every cell drills through to
 * the transactions on that day (§11.1: every figure drills through — that is
 * the trust mechanism for a ledger built out of parsed SMS). recharts would
 * make each cell an SVG rect with a synthetic click handler and no href.
 */

import Link from "next/link";

import { HEAT_EMPTY, WEEKDAY_INITIALS, heatColor } from "@/lib/chart-theme";
import { money } from "@/lib/accounts";
import { type CivilDate, addDays, diffDays } from "@/lib/periods";

export function SpendHeatmap({
  from,
  to,
  spend,
  cycleStart,
  cycleEnd,
  selectedWeek,
  today,
  hrefFor,
}: {
  /** Padded to whole weeks by the caller, so the grid has no ragged edge. */
  from: CivilDate;
  to: CivilDate;
  spend: Map<CivilDate, number>;
  cycleStart: CivilDate;
  cycleEnd: CivilDate;
  /** Highlighted at week grain; null at cycle grain. */
  selectedWeek: CivilDate | null;
  today: CivilDate;
  hrefFor: (day: CivilDate) => string;
}) {
  const days: CivilDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

  // The ramp is anchored on the largest day in the window. A fixed anchor would
  // make a quiet cycle look empty and a heavy one look uniform; the question
  // this chart answers is "which days were the big ones", which is relative.
  const max = Math.max(0, ...days.map((d) => spend.get(d) ?? 0));

  const rows: CivilDate[][] = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));

  return (
    <div className="h-full">
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAY_INITIALS.map((initial, i) => (
          <div key={i} className="text-[10px] opacity-40" aria-hidden="true">
            {initial}
          </div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1">
        {rows.flatMap((row) =>
          row.map((day) => {
            const amount = spend.get(day) ?? 0;
            const inCycle = day >= cycleStart && day <= cycleEnd;
            const inWeek = selectedWeek !== null && diffDays(selectedWeek, day) >= 0 && diffDays(selectedWeek, day) < 7;
            // The cycle turns over on the anchor day: everything from this cell
            // rightwards and downwards is next cycle's money.
            const opensCycle = day === cycleStart || day === addDays(cycleEnd, 1);

            return (
              <Link
                key={day}
                href={hrefFor(day)}
                title={`${day} · ${amount > 0 ? `SAR ${money(amount)}` : "nothing spent"}`}
                aria-label={`${day}, ${amount > 0 ? `${money(amount)} riyals spent` : "nothing spent"}`}
                className={`relative aspect-square rounded-[3px] ${
                  inCycle ? "" : "opacity-30"
                } ${inWeek ? "ring-1 ring-foreground/40" : ""} ${
                  day === today ? "outline outline-1 outline-offset-1 outline-foreground/50" : ""
                } ${opensCycle ? "border-l-2 border-foreground/60" : ""}`}
                style={{ backgroundColor: amount > 0 ? heatColor(amount, max) : HEAT_EMPTY }}
              >
                {/* The date on the cells that carry the boundary, so the rule
                    reads as "the 25th" rather than as an arbitrary divider. */}
                {opensCycle && (
                  <span className="absolute inset-0 grid place-items-center text-[9px] font-semibold mix-blend-difference">
                    {Number(day.slice(8))}
                  </span>
                )}
              </Link>
            );
          }),
        )}
      </div>

      <p className="mt-2 flex items-center gap-1.5 text-[11px] opacity-55">
        <span className="border-l-2 border-foreground/60 pl-1">
          the {Number(cycleStart.slice(8))}th opens the cycle
        </span>
        <span className="ml-auto flex items-center gap-1">
          less
          <span className="inline-flex gap-0.5">
            {[0.2, 0.45, 0.7, 0.95].map((f) => (
              <span
                key={f}
                className="inline-block size-2.5 rounded-[2px]"
                style={{ backgroundColor: heatColor(max * f, max) }}
              />
            ))}
          </span>
          more
        </span>
      </p>
    </div>
  );
}
