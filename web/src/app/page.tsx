import { asc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";

import { PeriodHeader } from "@/components/period-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { StatCard } from "@/components/ui/stat-card";
import { getDb, schema } from "@/db";
import { periodTotals } from "@/db/aggregates";
import { type AccountRow, groupByInstitution, totals } from "@/lib/accounts";
import { readSelection } from "@/lib/period-params";
import { daysElapsed, daysInPeriod, periodLabel, today } from "@/lib/periods";

export const dynamic = "force-dynamic";

async function load(grain: "week" | "cycle", period: string) {
  const db = getDb();

  const accounts = (await db
    .select({
      id: schema.accounts.id,
      slug: schema.accounts.slug,
      name: schema.accounts.name,
      institution: schema.accounts.institution,
      type: schema.accounts.type,
      isLiability: schema.accounts.isLiability,
      balanceSemantics: schema.accounts.balanceSemantics,
      reconcilable: schema.accounts.reconcilable,
      currentBalance: schema.accounts.currentBalance,
      creditLimit: schema.accounts.creditLimit,
      isProfitBearing: schema.accounts.isProfitBearing,
      balanceAsOf: schema.accounts.balanceAsOf,
      sortOrder: schema.accounts.sortOrder,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true))
    .orderBy(asc(schema.accounts.sortOrder))) as AccountRow[];

  const [parked] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.rawMessages)
    .where(inArray(schema.rawMessages.status, ["needs_review", "failed"]));

  return {
    accounts,
    parked: parked?.count ?? 0,
    totals: await periodTotals(grain, period),
  };
}

export default async function Page(props: PageProps<"/">) {
  const { grain, period } = readSelection(await props.searchParams);

  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(grain, period);
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Home</h1>
        <div className="mt-6">
          <EmptyState
            title="Can't reach the database"
            body={err instanceof Error ? err.message : String(err)}
          />
        </div>
      </main>
    );
  }

  const { netWorth, assets, debt } = totals(groupByInstitution(data.accounts));
  const t = data.totals;

  const total = daysInPeriod(grain, period);
  const elapsed = daysElapsed(grain, period, today());
  const through = Math.round((elapsed / total) * 100);

  const net = t.income - t.expense;

  // §11.5 — a negative savings rate is a valid result, not a bug: it means the
  // period was funded out of savings. Never clamped to zero.
  //
  // It is suppressed, though, once the denominator stops carrying information.
  // Early in a cycle, before the salary lands, income can be a few riyals of
  // profit — and (1.81 − 130) / 1.81 renders as "−7082%", which reads as a
  // broken page rather than as a fact. Past ±500% the ratio says nothing the
  // plain shortfall does not say better, so show that instead. The underlying
  // figure is untouched; this is a display rule, not a clamp.
  const savingsRate = t.income > 0 ? net / t.income : null;
  const rateIsMeaningful = savingsRate !== null && Math.abs(savingsRate) <= 5;

  const netHint = rateIsMeaningful ? (
    `savings rate ${Math.round(savingsRate * 100)}%`
  ) : t.income === 0 ? (
    "no income recorded yet this " + grain
  ) : (
    <>
      spent <Money value={t.expense - t.income} /> more than came in
    </>
  );

  return (
    <main>
      <PeriodHeader />
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Home</h1>
        <p className="text-xs opacity-50">{periodLabel(grain, period)}</p>
      </div>

      <section className="mt-5 rounded-xl border border-black/10 p-5 dark:border-white/15">
        <p className="text-xs tracking-wide uppercase opacity-60">Net worth</p>
        <p className="mt-1 text-3xl font-semibold">
          <Money value={netWorth} currency />
        </p>
        <div className="mt-3 flex gap-5 text-sm">
          <span>
            <span className="opacity-60">Assets </span>
            <Money value={assets} tone="auto" />
          </span>
          <span>
            <span className="opacity-60">Owed </span>
            <Money value={-debt} tone="auto" />
          </span>
        </div>
      </section>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <StatCard
          label="Spent"
          value={<Money value={t.expense} />}
          hint={`${through}% through the ${grain} · day ${elapsed} of ${total}`}
        />
        <StatCard
          label="Income"
          value={<Money value={t.income} />}
          hint={
            t.passive > 0 ? (
              <>
                earned <Money value={t.earned} /> · passive <Money value={t.passive} />
              </>
            ) : (
              "salary and profit"
            )
          }
        />
        <StatCard
          label="Net"
          value={<Money value={net} sign="always" />}
          tone={net < 0 ? "negative" : "default"}
          hint={netHint}
        />
        <StatCard
          label="Uncategorized"
          value={<Money value={t.uncategorized} />}
          tone={t.uncategorizedCount > 0 ? "warn" : "default"}
          hint={`${t.uncategorizedCount} of ${t.transactions} transactions`}
        />
      </div>

      {/* §11.6 — alerts are in-app only in v1: a badge and a dashboard banner. */}
      {data.parked > 0 && (
        <Link
          href="/review"
          className="mt-4 flex items-center justify-between rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm"
        >
          <span className="text-amber-700 dark:text-amber-400">
            {data.parked} message{data.parked === 1 ? "" : "s"} the parser couldn&rsquo;t read
          </span>
          <span className="opacity-40">›</span>
        </Link>
      )}

      {t.transactions === 0 && (
        <div className="mt-4">
          <EmptyState
            title="Nothing in this period yet"
            body={
              data.accounts.length === 0
                ? "No accounts exist. Run npm run db:seed to create them."
                : "Either nothing was spent, or no message has arrived. The Review tab and the health panel tell you which."
            }
          />
        </div>
      )}

      <p className="mt-8 text-xs opacity-50">
        Spending excludes internal transfers, card payments and loan principal — moving your own
        money is not an expense, and counting a card purchase and its payment inflates spending by
        up to 2×. A cycle runs the 25th to the 24th, so this is not a calendar month.
      </p>
    </main>
  );
}
