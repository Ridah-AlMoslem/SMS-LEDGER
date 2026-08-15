/**
 * This week vs. last vs. the 4-week average, by category (SPEC §11.1 chart 7).
 *
 * **Week grain only, and suppressed entirely when either week is partial.**
 * §5.3: "Never compute week-over-week deltas against a partial week — suppress
 * the comparison instead." A week in progress is compared against a whole one
 * every time it is drawn, and the answer is always "spending has collapsed",
 * which is a statement about the calendar rather than about the spending.
 *
 * The page decides whether to render this at all; the guard here is a second
 * lock on the same door, because the cost of getting it wrong is a number that
 * is confidently, plausibly false.
 */

import { Money } from "@/components/ui/money";

export type ComparisonRow = {
  categoryId: string | null;
  name: string;
  current: number;
  previous: number;
  average: number;
};

export function WeekOverWeek({
  rows,
  suppressed,
  reason,
}: {
  rows: ComparisonRow[];
  suppressed: boolean;
  reason?: string;
}) {
  if (suppressed) {
    return (
      <section className="mt-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Week over week
        </h2>
        <p className="mt-1.5 text-xs opacity-55">
          {reason ??
            "Suppressed: one of the two weeks is partial, and a part-week compared against a whole one always reads as a collapse."}
        </p>
      </section>
    );
  }

  if (rows.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Week over week</h2>
      <p className="mt-1 text-xs opacity-55">
        This week against last, and against the 4-week average.
      </p>

      <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
        {rows.map((row) => {
          const delta = row.current - row.previous;
          const up = delta > 0;

          return (
            <li key={row.categoryId ?? "uncategorized"} className="flex items-baseline gap-3 py-2">
              <span className="sms-body min-w-0 flex-1 truncate text-sm">{row.name}</span>

              <span className="text-sm">
                <Money value={row.current} />
              </span>

              <span
                className={`w-24 shrink-0 text-right text-xs ${
                  up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {/* An arrow as well as a colour: up-is-worse is not something a
                    reader should have to infer from hue alone. */}
                <span aria-hidden="true">{up ? "▲" : "▼"}</span>{" "}
                <Money value={Math.abs(delta)} />
                <span className="sr-only">
                  {up ? "more than" : "less than"} last week
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs opacity-50">
        4-week averages:{" "}
        {rows
          .slice(0, 3)
          .map((r) => `${r.name} ${r.average.toFixed(0)}`)
          .join(" · ")}
      </p>
    </section>
  );
}
