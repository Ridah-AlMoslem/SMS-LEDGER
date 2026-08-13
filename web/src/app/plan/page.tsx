import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { StatCard } from "@/components/ui/stat-card";
import { periodTotals } from "@/db/aggregates";
import { readSelection } from "@/lib/period-params";
import {
  daysElapsed,
  daysInPeriod,
  periodBounds,
  periodLabel,
  today,
  weekBucketsInCycle,
} from "@/lib/periods";

export const dynamic = "force-dynamic";

/**
 * Budgets and goals.
 *
 * The budgets, goals and rules tables exist (§4) but nothing writes to them
 * yet — that is milestone 10 (§12), and §11.2's pacing arithmetic is only
 * meaningful once there is a budget to pace against. What is real on this
 * screen today is the pacing denominator: the actual length of the period, and
 * the actual week structure inside it, both of which the rest of the app will
 * divide by.
 */
export default async function PlanPage(props: PageProps<"/plan">) {
  const { grain, period } = readSelection(await props.searchParams);

  let spent = 0;
  let reachable = true;
  try {
    spent = (await periodTotals(grain, period)).expense;
  } catch {
    reachable = false;
  }

  const total = daysInPeriod(grain, period);
  const elapsed = daysElapsed(grain, period, today());
  const remaining = total - elapsed;

  // §5.3 — a cycle averages 4.43 weeks and starts mid-week, so it never
  // contains a whole number of them. The two stubs are why `cycle_budget / 4`
  // understates the weekly allowance by ~10%.
  const cycleAnchor = grain === "cycle" ? period : periodBounds("cycle", period).start;
  const weeks = weekBucketsInCycle(cycleAnchor);
  const partials = weeks.filter((w) => w.partial).length;

  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Plan</h1>
        <p className="text-xs opacity-50">{periodLabel(grain, period)}</p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5">
        <StatCard
          label="Spent so far"
          value={reachable ? <Money value={spent} /> : <span className="opacity-40">—</span>}
          hint={`${elapsed} of ${total} days elapsed`}
        />
        <StatCard
          label="Days left"
          value={<span className="tabular">{remaining}</span>}
          hint={
            reachable && remaining > 0 ? (
              <>
                <Money value={spent / Math.max(elapsed, 1)} /> per day so far
              </>
            ) : (
              "period closed"
            )
          }
        />
      </div>

      <div className="mt-4">
        <EmptyState
          title="No budgets set"
          body={
            <>
              Per-category cycle budgets, rollover and goal tracking land with milestone 10. The
              pacing they need is already here: this cycle is <strong>{total} days</strong>, not 30,
              and pacing that assumes otherwise is wrong twice a year.
            </>
          }
        />
      </div>

      <section className="mt-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Weeks in this cycle
        </h2>
        <p className="mt-1 text-xs opacity-55">
          Weeks do not tile cycles. {weeks.length} buckets, {partials} of them partial — so a weekly
          budget is derived by weighting days, never by dividing the cycle by four.
        </p>

        <ul className="mt-3 space-y-1.5">
          {weeks.map((w) => (
            <li key={w.weekStart} className="flex items-center gap-3 text-sm">
              <span className="tabular w-44 shrink-0 text-xs opacity-60">
                {w.start} – {w.end}
              </span>
              <span
                className={`h-2 rounded-full ${
                  w.partial
                    ? "bg-[repeating-linear-gradient(45deg,currentColor,currentColor_2px,transparent_2px,transparent_4px)] opacity-40"
                    : "bg-current opacity-25"
                }`}
                style={{ width: `${(w.days / 7) * 100}%`, maxWidth: "45%" }}
              />
              <span className="tabular text-xs opacity-50">
                {w.partial ? `${w.days} of 7 days` : "7 days"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-xs opacity-50">
        Partial buckets are hatched. Never compare a partial week against a whole one — a 1-day bar
        beside 7-day bars reads as a spending collapse that never happened.
      </p>
    </main>
  );
}
