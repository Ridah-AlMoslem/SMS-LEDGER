import { PeriodHeader } from "@/components/period-header";
import { EmptyState } from "@/components/ui/empty-state";
import { loadPlan } from "@/db/plan";
import { toView } from "@/lib/accounts";
import { reason } from "@/lib/errors";
import type { Goal } from "@/lib/goals";
import { readSelection } from "@/lib/period-params";
import { periodLabel, today } from "@/lib/periods";

import { type BudgetRowData, BudgetsPanel } from "./budgets-panel";
import { type GoalAccount, GoalsPanel } from "./goals-panel";
import { RecurringPanel } from "./recurring-panel";
import { PlanSegments } from "./segments";

export const dynamic = "force-dynamic";

/**
 * Plan — budgets, goals and recurring charges (SPEC §11.2, §11.3).
 *
 * One route, three content segments, one database round trip. The segments are
 * not navigation (`segments.tsx` explains why) and the period header above them
 * is the same global control every other period-scoped screen carries.
 *
 * **The budget rows are cycle-scoped at both grains.** §11.2: budgets are set
 * monthly and viewed at both grains, and the weekly figures — `fair_share` and
 * `remaining_pace` — are derived, never stored. So this page loads the enclosing
 * cycle whatever the grain is, hands the rows plus each week's spend to a client
 * component, and the grain toggle changes which arithmetic that component shows.
 * No second query, and no reload: the numbers for both grains are already
 * there.
 *
 * Every figure here is derived from something else. The carry is the one
 * exception, and it is stored precisely so that it *cannot* be re-derived —
 * §11.2's guarantee that a corrected old transaction does not cascade through
 * years of budgets.
 */
export default async function PlanPage(props: PageProps<"/plan">) {
  const { period } = readSelection(await props.searchParams);
  const now = today();

  let plan;
  try {
    plan = await loadPlan(period, now);
  } catch (err) {
    // The message, not an empty panel. "Cannot reach the database" and "no
    // budgets set" look identical otherwise, and only one of them is worth
    // getting out of bed for.
    return (
      <main>
        <PeriodHeader />
        <h1 className="text-xl font-semibold">Plan</h1>
        <EmptyState className="mt-5" title="Can't reach the database" body={reason(err)} />
      </main>
    );
  }

  const cycleLabel = periodLabel("cycle", plan.cycle);

  /* ---------------------------------------------------------- budget rows */

  // Spend for this cycle, per category, summed from the week groups — so the
  // cycle figure and the week figures are the same numbers added up two ways
  // rather than two queries that might disagree.
  const spentByCategory = new Map<string, number>();
  const weekSpendByCategory = new Map<string, Record<string, number>>();
  let uncategorizedTotal = 0;
  let uncategorizedCount = 0;

  for (const row of plan.weekSpend) {
    if (row.categoryId === null) {
      uncategorizedTotal += row.total;
      uncategorizedCount += row.count;
      continue;
    }

    spentByCategory.set(row.categoryId, (spentByCategory.get(row.categoryId) ?? 0) + row.total);

    const weeks = weekSpendByCategory.get(row.categoryId) ?? {};
    weeks[row.week] = (weeks[row.week] ?? 0) + row.total;
    weekSpendByCategory.set(row.categoryId, weeks);
  }

  const budgetsThisCycle = plan.budgets.filter((b) => b.cycleStart === plan.cycle);

  // Every category with a budget, plus every category that was spent in without
  // one. The second half is what keeps the screen honest: a category quietly
  // consuming 900 a cycle with no budget is exactly what a budget screen exists
  // to surface, and listing only the budgeted ones would hide it.
  const ids = new Set<string>([
    ...budgetsThisCycle.map((b) => b.categoryId),
    ...spentByCategory.keys(),
  ]);

  const rows: BudgetRowData[] = [...ids].map((id) => {
    const budget = budgetsThisCycle.find((b) => b.categoryId === id);
    const category = plan.categories.get(id);

    return {
      categoryId: id,
      name: category?.name ?? "Unknown category",
      icon: category?.icon ?? null,
      base: budget ? budget.base : null,
      carry: budget?.carryIn ?? 0,
      rollover: budget?.rollover ?? false,
      carrySettled: Boolean(budget?.carryClosedAt),
      spent: spentByCategory.get(id) ?? 0,
      weekSpend: weekSpendByCategory.get(id) ?? {},
    };
  });

  /* ---------------------------------------------------------------- goals */

  // A goal sits over an account that holds money. A liability is refused here as
  // well as in `db/goals.ts`: on a card the stored figure is available credit
  // (§3.3a), so a goal reading it as progress would fill up as the card was spent.
  const savingsAccounts: GoalAccount[] = plan.accounts
    .filter((a) => !a.isLiability)
    .map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      balance: toView(a).net,
      runRate: plan.runRates.get(a.id) ?? null,
    }));

  const goals: Goal[] = plan.goals.map((g) => ({
    id: g.id,
    name: g.name,
    targetAmount: g.targetAmount,
    targetDate: g.targetDate,
    accountId: g.accountId,
    allocation: g.allocation,
  }));

  /* ------------------------------------------------------------- segments */

  const activeSeries = plan.series.filter((s) => !s.dismissed && s.status === "active");

  return (
    <main>
      <PeriodHeader />

      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Plan</h1>
        <p className="text-xs opacity-50">{cycleLabel}</p>
      </div>

      <PlanSegments
        counts={{ budgets: rows.length, goals: goals.length, recurring: activeSeries.length }}
        budgets={
          <BudgetsPanel
            rows={rows}
            catalogue={[...plan.categories.values()].sort((a, b) => a.name.localeCompare(b.name))}
            uncategorized={{ total: uncategorizedTotal, count: uncategorizedCount }}
            cycle={plan.cycle}
            cycleDays={plan.cycleDays}
            cycleElapsed={plan.cycleElapsed}
            weeks={plan.weeks}
          />
        }
        goals={
          <GoalsPanel
            goals={goals}
            accounts={savingsAccounts}
            now={now}
            cycleLabel={cycleLabel}
          />
        }
        recurring={<RecurringPanel series={plan.series} now={now} />}
      />
    </main>
  );
}
