/**
 * Home — SPEC §11.1, §11.2, §11.5.
 *
 * This page answers exactly two questions, in this order:
 *
 *   1. **Am I on pace?** — the pace hero.
 *   2. **Am I getting richer?** — the net worth strip.
 *
 * Everything else scrolls below the fold. That ordering is the whole design:
 * both answers have to be readable on a 390px screen without scrolling, so
 * anything that competes for that space has to earn it, and nothing on this
 * page does except the alert banner — which is present only when there is
 * something to say.
 *
 * The accounts overview that used to live here moves to /accounts (Prompt 4).
 * Home does not render an account list: "am I getting richer" is one number and
 * a delta, and a list of balances answers a different question.
 */

import Link from "next/link";

import { AlertBanner } from "@/components/home/alert-banner";
import { CashFlow, type FlowPoint } from "@/components/home/cash-flow";
import { CategoryPaceList } from "@/components/home/category-pace";
import { CategoryTrends, type TrendPoint, type TrendSeries } from "@/components/home/category-trends";
import { ChartFrame } from "@/components/home/chart-frame";
import { CycleFlowList } from "@/components/home/cycle-flow";
import { MerchantTable } from "@/components/home/merchant-table";
import { NetWorthStrip } from "@/components/home/net-worth-strip";
import { PaceHero } from "@/components/home/pace-hero";
import { SpendHeatmap } from "@/components/home/spend-heatmap";
import { WeekOverWeek, type ComparisonRow } from "@/components/home/week-over-week";
import { WeekdayProfile } from "@/components/home/weekday-profile";
import { WeeklyDigest } from "@/components/home/weekly-digest";
import { PeriodHeader } from "@/components/period-header";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { type HomeData, loadHome } from "@/db/home";
import { reason } from "@/lib/errors";
import { groupByInstitution, totals as accountTotals } from "@/lib/accounts";
import { rankAlerts, reviewQueueAlert } from "@/lib/alerts";
import { OTHER_COLOR, WEEKDAY_INITIALS, foldToOther, seriesColorAt } from "@/lib/chart-theme";
import { hasShape, netWorthSeries } from "@/lib/net-worth";
import { pace } from "@/lib/pace";
import { readSelection, withSelection } from "@/lib/period-params";
import {
  type CivilDate,
  type Grain,
  addDays,
  daysElapsed,
  daysInPeriod,
  diffDays,
  periodBounds,
  periodLabel,
  shortLabel,
  stepPeriod,
  today,
} from "@/lib/periods";

export const dynamic = "force-dynamic";

/** How many buckets the trend and flow charts carry. Six cycles matches §11.2's
 *  carry cap; eight weeks is what the day-of-week profile averages over. */
const CYCLES_BACK = 6;
const WEEKS_BACK = 8;

const UNCATEGORIZED = "uncategorized";

function Gear() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.25" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.09A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.47 1z" />
    </svg>
  );
}

/** The buckets a trend chart covers, oldest first, ending at the one on screen.
 *  Stepping back through history moves the window rather than pinning it to
 *  today — otherwise browsing last March would draw this March's chart. */
function bucketsEndingAt(grain: Grain, period: CivilDate, count: number): CivilDate[] {
  const out: CivilDate[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(stepPeriod(grain, period, -i));
  return out;
}

/** §5.4 — a rolling mean over the trailing `window` buckets, series by series.
 *  Raw weekly swings wildly on one large purchase; the average is what the
 *  chart shows by default and the raw series is a tap away. */
function rollingMean(points: TrendPoint[], keys: string[], window = 4): TrendPoint[] {
  return points.map((point, i) => {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1);
    const smoothed: TrendPoint = { bucket: point.bucket, label: point.label };
    for (const key of keys) {
      smoothed[key] = slice.reduce((s, p) => s + Number(p[key] ?? 0), 0) / slice.length;
    }
    return smoothed;
  });
}

export default async function Page(props: PageProps<"/">) {
  const params = await props.searchParams;
  const { grain, period } = readSelection(params);
  const now = today();

  let data: HomeData;
  try {
    data = await loadHome(grain, period, now);
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Home</h1>
        <div className="mt-6">
          <EmptyState
            title="Can't reach the database"
            body={reason(err)}
          />
        </div>
      </main>
    );
  }

  /* ------------------------------------------------------------ selection */

  const span = periodBounds(grain, period);
  const cycleSpan = periodBounds("cycle", data.cycle);
  const cycleLabel = periodLabel("cycle", data.cycle);

  // Links carry the grain and period forward, so a drill-through lands on the
  // same period you were looking at rather than resetting to now.
  const withPeriod = (path: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams(withSelection(params, grain, period));
    for (const [k, v] of Object.entries(extra)) query.set(k, v);
    return `${path}?${query.toString()}`;
  };

  /* ---------------------------------------------------------------- pace */

  // §11.2 — fair_share is weighted by the days of the week that actually fall
  // inside the cycle. At a cycle edge a "week" may be one day, and weighting it
  // as seven is how a stub week is made to look like an underspend.
  const weekDaysInCycle =
    grain === "week"
      ? Math.max(
          0,
          Math.min(diffDays(span.start, cycleSpan.end), 6) -
            Math.max(diffDays(span.start, cycleSpan.start), 0) +
            1,
        )
      : 7;

  const cyclePace = pace({
    budget: data.cycleBudget,
    spent: data.cycleTotals.expense,
    elapsed: data.cycleElapsed,
    total: data.cycleDays,
    daysInWeek: weekDaysInCycle,
  });

  const weekElapsed = daysElapsed("week", period, now);
  // §5.3 — a week that has not finished is not comparable to one that has.
  const weekInProgress = grain === "week" && weekElapsed > 0 && weekElapsed < 7;

  /* ----------------------------------------------------------- net worth */

  const groups = groupByInstitution(data.accounts);
  const { netWorth, assets, debt } = accountTotals(groups);

  // The headline and the sparkline come from two different places on purpose.
  // The headline is `current_balance`, which `recompute_balances` derives from
  // every posted leg on each parser tick (§3.3). The line is what the banks
  // actually *said*, snapshot by snapshot — and on accounts that never state a
  // balance (SAIB, §3.3b) they say nothing at all.
  //
  // The last point is deliberately NOT forced onto the headline figure. Doing
  // that draws a vertical cliff on the final day wherever the reporting
  // accounts are only part of the picture, which is an artefact of the join
  // rather than a movement of money. A sparkline has no axis: it carries shape,
  // and the caller states the magnitude beside it.
  const series = netWorthSeries(
    data.accounts,
    data.snapshots,
    data.netWorthWindow.from,
    data.netWorthWindow.to,
  );

  const savings = data.accounts.find((a) => a.isProfitBearing);

  // §11.5 — profit as a share of what the cycle cost. Negative is impossible
  // here (profit is a credit) but a zero denominator is not, and dividing by it
  // would print "Infinity% of your life".
  const passiveCoverage =
    data.cycleTotals.expense > 0 ? data.cycleTotals.passive / data.cycleTotals.expense : null;

  /* -------------------------------------------------------------- charts */

  const buckets = bucketsEndingAt(grain, period, grain === "cycle" ? CYCLES_BACK : WEEKS_BACK);
  const flowIndex = new Map(data.flows.map((f) => [f.bucket, f]));

  const flowPoints: FlowPoint[] = buckets.map((bucket) => {
    const f = flowIndex.get(bucket);
    const income = (f?.earned ?? 0) + (f?.passive ?? 0);
    const expense = f?.expense ?? 0;
    const fullDays = daysInPeriod(grain, bucket);
    const elapsed = daysElapsed(grain, bucket, now);

    return {
      bucket,
      label: shortLabel(grain, bucket),
      income,
      expense,
      net: income - expense,
      // §5.3 — the bucket in progress is hatched and labelled, never drawn as
      // though it were a whole one.
      partial: elapsed > 0 && elapsed < fullDays,
      days: elapsed,
      fullDays,
    };
  });

  /* trends: top five categories over the window, everything else folded */

  const windowTotals = new Map<string, number>();
  for (const t of data.trends) {
    const key = t.categoryId ?? UNCATEGORIZED;
    windowTotals.set(key, (windowTotals.get(key) ?? 0) + t.total);
  }

  const { kept, otherTotal } = foldToOther(
    [...windowTotals].map(([key, total]) => ({ key, total })),
    5,
  );
  const keptKeys = new Set(kept.map((k) => k.key));

  // Slots in order, largest band first. `foldToOther` already sorted them, so
  // the stack's neighbours are the palette's neighbours — the pairs the palette
  // was validated on.
  const trendSeries: TrendSeries[] = kept.map((k, i) => ({
    key: k.key,
    name:
      k.key === UNCATEGORIZED ? "Uncategorized" : (data.categoryNames.get(k.key)?.name ?? "Other"),
    color: seriesColorAt(i),
  }));
  if (otherTotal > 0) {
    // Grey on purpose: a residual is not a category, and giving it a hue would
    // invite reading it as one.
    trendSeries.push({ key: "__other", name: "Other", color: OTHER_COLOR });
  }

  const seriesKeys = trendSeries.map((s) => s.key);
  const trendIndex = new Map<string, TrendPoint>();
  for (const bucket of buckets) {
    const point: TrendPoint = { bucket, label: shortLabel(grain, bucket) };
    for (const key of seriesKeys) point[key] = 0;
    trendIndex.set(bucket, point);
  }
  for (const t of data.trends) {
    const point = trendIndex.get(t.bucket);
    if (!point) continue;
    const key = t.categoryId ?? UNCATEGORIZED;
    const slot = keptKeys.has(key) ? key : "__other";
    if (slot in point) point[slot] = Number(point[slot] ?? 0) + t.total;
  }
  const trendPoints = buckets.map((b) => trendIndex.get(b)!);

  const seriesTotals: Record<string, number> = {};
  for (const key of seriesKeys) {
    seriesTotals[key] = trendPoints.reduce((s, p) => s + Number(p[key] ?? 0), 0);
  }

  /* week-over-week: literal week ranges, no cycle involved (§5.6) */

  let comparison: ComparisonRow[] = [];
  if (grain === "week") {
    const previous = addDays(period, -7);
    const averageWindow = buckets.filter((b) => b < period).slice(-4);

    const byKey = new Map<string, { current: number; previous: number; sum: number }>();
    for (const t of data.trends) {
      const key = t.categoryId ?? UNCATEGORIZED;
      const row = byKey.get(key) ?? { current: 0, previous: 0, sum: 0 };
      if (t.bucket === period) row.current += t.total;
      if (t.bucket === previous) row.previous += t.total;
      if (averageWindow.includes(t.bucket)) row.sum += t.total;
      byKey.set(key, row);
    }

    comparison = [...byKey]
      .map(([key, row]) => ({
        categoryId: key === UNCATEGORIZED ? null : key,
        name: key === UNCATEGORIZED ? "Uncategorized" : (data.categoryNames.get(key)?.name ?? key),
        current: row.current,
        previous: row.previous,
        average: averageWindow.length > 0 ? row.sum / averageWindow.length : 0,
      }))
      .filter((r) => r.current > 0 || r.previous > 0)
      .sort((a, b) => Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous))
      .slice(0, 6);
  }

  /* ---------------------------------------------------------- pace rows */

  // Budgeted categories first, ranked by how much of their budget is gone;
  // unbudgeted ones after, by size, since there is nothing to pace them
  // against. Five rows — the sixth is a scroll on a phone.
  const paceRows = [...data.categories]
    .sort((a, b) => {
      if (a.share !== null && b.share !== null) return b.share - a.share;
      if (a.share !== null) return -1;
      if (b.share !== null) return 1;
      return b.spent - a.spent;
    })
    .slice(0, 5);

  const alerts = rankAlerts(data.alerts, reviewQueueAlert(data.parked));

  const spendByDay = new Map(data.daily.map((d) => [d.day, d.total]));

  return (
    <PullToRefresh>
      <main>
        <PeriodHeader />

        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Home</h1>
          <Link
            href="/settings"
            aria-label="Settings"
            className="-mr-2 rounded-lg p-2 opacity-55 hover:opacity-100"
          >
            <Gear />
          </Link>
        </div>

        <div className="mt-3">
          <AlertBanner alerts={alerts} />

          <PaceHero
            grain={grain}
            pace={cyclePace}
            weekSpend={data.totals.expense}
            cycleLabel={cycleLabel}
            partialWeek={weekInProgress}
            weekDaysElapsed={weekElapsed}
            href={withPeriod("/ledger")}
            planHref={withPeriod("/plan")}
          />

          <NetWorthStrip
            netWorth={netWorth}
            assets={assets}
            debt={debt}
            delta={data.cycleTotals.income - data.cycleTotals.expense}
            series={hasShape(series) ? series : []}
            passiveCoverage={passiveCoverage}
            passiveAmount={data.cycleTotals.passive}
            href={savings ? `/accounts/${savings.slug}` : "/accounts"}
            cycleLabel={cycleLabel}
            savingsName={savings?.name ?? null}
          />
        </div>

        <CategoryPaceList rows={paceRows} cycleLabel={cycleLabel} />

        {/* §11.2 — "Uncategorized is a first-class category… shown prominently
            on the dashboard with a count. Hiding this makes every other number
            quietly wrong." Always rendered, including at zero. */}
        <div className="mt-4">
          <Chip href={withPeriod("/ledger", { uncategorized: "1" })} count={data.totals.uncategorizedCount}>
            Uncategorized
          </Chip>
        </div>

        {data.totals.transactions === 0 && (
          <div className="mt-4">
            <EmptyState
              title={`Nothing in this ${grain}`}
              body={
                data.accounts.length === 0
                  ? "No accounts exist. Run npm run db:seed to create them."
                  : "Either nothing was spent, or no message has arrived. The Review tab and the health panel tell you which."
              }
            />
          </div>
        )}

        {/* ---------------------------------------------- below the fold --- */}

        <ChartFrame
          title="Daily spend"
          hint="Each cell is a day; the rule marks the 25th, where the cycle turns over. Tap a day for its transactions."
          height="auto"
          expandedHeight="auto"
          tapToExpand={false}
        >
          <SpendHeatmap
            from={data.heatWindow.from}
            to={data.heatWindow.to}
            spend={spendByDay}
            cycleStart={cycleSpan.start}
            cycleEnd={cycleSpan.end}
            selectedWeek={grain === "week" ? span.start : null}
            today={now}
            hrefFor={(day) => withPeriod("/ledger", { day })}
          />
        </ChartFrame>

        <CashFlow
          grain={grain}
          data={flowPoints}
          weeklyIncomeReference={
            grain === "week" && data.cycleDays > 0
              ? data.cycleTotals.income / (data.cycleDays / 7)
              : null
          }
        />

        <CategoryTrends
          grain={grain}
          raw={trendPoints}
          smoothed={grain === "week" ? rollingMean(trendPoints, seriesKeys) : null}
          series={trendSeries}
          totals={seriesTotals}
        />

        <MerchantTable
          rows={data.merchants}
          total={data.totals.expense}
          hrefFor={(merchant) => withPeriod("/ledger", { merchant })}
        />

        {grain === "week" && data.weekday.length > 0 && (
          <WeekdayProfile
            data={data.weekday.map((d) => ({
              dow: d.dow,
              label: WEEKDAY_INITIALS[d.dow],
              average: d.average,
              total: d.total,
            }))}
            weeks={WEEKS_BACK}
          />
        )}

        {grain === "week" && (
          <WeekOverWeek
            rows={comparison}
            suppressed={weekInProgress}
            reason={
              weekInProgress
                ? `This week is ${weekElapsed} of 7 days in. Comparing it against a whole week would report a collapse that has not happened — the comparison returns when the week closes.`
                : undefined
            }
          />
        )}

        {grain === "cycle" && data.flow && (
          <CycleFlowList flow={data.flow} cycleLabel={cycleLabel} />
        )}

        {data.digest && (
          <WeeklyDigest
            digest={data.digest}
            pace={cyclePace}
            weekLabel={periodLabel("week", data.digest.week)}
            href={`/ledger?grain=week&period=${data.digest.week}`}
          />
        )}

        <p className="mt-8 text-xs opacity-50">
          Spending excludes internal transfers, card payments and loan principal — moving your own
          money is not an expense, and counting a card purchase and its payment inflates spending
          by up to 2×. Profit counts as income. A cycle runs the 25th to the 24th, so this is not
          a calendar month, and pacing divides by this cycle&rsquo;s actual{" "}
          <span className="tabular">{data.cycleDays}</span> days.
        </p>
      </main>
    </PullToRefresh>
  );
}
