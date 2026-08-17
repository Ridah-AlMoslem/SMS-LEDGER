/**
 * The savings account — SPEC §11.5 in full.
 *
 * "The profit-bearing savings account is the only thing in the ledger that
 * *makes* money, so it gets its own view rather than sitting as one more row in
 * the account list." It is also reached straight from Home by tapping the net
 * worth strip — savings has no tab by design — so this reads as a screen in its
 * own right rather than as a sub-page of the account list.
 *
 * Two facts from §11.5 govern everything below, and both are the reason a
 * figure is *absent* somewhere you might expect one:
 *
 *   - **Profit varies month to month.** No expected amount is stored, derived
 *     or alerted on. The payout tracker watches the cadence and never the size.
 *   - **Transfers follow no routine.** So there is no target, no ring and no
 *     "on track" anywhere on this screen. Net contribution is a signed bar,
 *     because the honest answer some months is that it went the other way.
 *
 * The arithmetic is all in `lib/savings.ts`, under test. This file arranges it.
 */

import { StatCard } from "@/components/ui/stat-card";
import type { AccountDetail } from "@/db/account-detail";
import type { AccountView } from "@/lib/accounts";
import {
  type CycleSavings,
  YIELD_WINDOW,
  payoutStatus,
  residual,
  savingsByCycle,
} from "@/lib/savings";
import { type CivilDate, civilShort, periodLabel } from "@/lib/periods";

import { Projection } from "./projection";
import {
  ContributionsVsGrowth,
  type CyclePoint,
  NetContribution,
  PassiveCoverage,
  RealizedYield,
} from "./savings-charts";

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percent = (v: number | null, digits = 1) =>
  v === null ? "—" : `${(v * 100).toFixed(digits)}%`;

/** §11.5 — "your savings currently pays for 2% of your life." Below 0.1% the
 *  rounded figure is 0% and the sentence stops being true. */
function coverageText(v: number | null): string {
  if (v === null) return "—";
  return v >= 0.1 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`;
}

export function SavingsView({
  detail,
  view,
  today,
}: {
  detail: AccountDetail;
  view: AccountView;
  today: CivilDate;
}) {
  const rows = savingsByCycle({
    openingBalance: detail.openingBalance,
    legs: detail.legs,
    cycles: detail.cycles,
    expenseByCycle: detail.expenseByCycle,
    today,
  });

  const current = rows[rows.length - 1];
  const points: CyclePoint[] = rows.map((r) => ({
    cycle: r.cycle,
    label: r.label,
    principal: r.cumulativePrincipal,
    profit: r.cumulativeProfit,
    other: r.cumulativeOther,
    net: r.net,
    deposits: r.deposits,
    withdrawals: r.withdrawals,
    balance: r.closingBalance,
    averageDailyBalance: r.averageDailyBalance,
    realizedYield: r.realizedYield,
    trailingYield: r.trailingYield,
    closingYield: r.closingYield,
    coverage: r.passiveCoverage,
    partial: r.partial,
  }));

  // The check that the two running totals still describe the account (§6). It
  // holds by construction, so a non-zero here means a leg was classified into a
  // bucket it does not belong in — and the growth band above would be claiming
  // money this account did not earn. Stated rather than swallowed.
  const drift = current ? residual(current) : 0;

  const payout = payoutStatus(detail.payoutDays, today);

  // Trailing-average contribution, over the same window as the yield: the
  // projection compounds a rate and a habit, and reading the habit from one
  // cycle would make the forecast swing on a single large transfer.
  const recent = rows.slice(-YIELD_WINDOW);
  const contribution =
    recent.length > 0 ? recent.reduce((sum, r) => sum + r.net, 0) / recent.length : 0;

  const yields = rows.map((r) => r.realizedYield);
  const anyProfit = rows.some((r) => r.profit > 0);

  return (
    <div className="mt-5 space-y-5">
      <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <p className="text-xs tracking-wide uppercase opacity-60">Balance</p>
        <p className="tabular mt-1 text-3xl font-semibold">{money.format(view.net)}</p>

        {/* The split, in words, above the chart that draws it. Profit
            compounds into the same balance, so without this the headline is
            just a number that went up for unstated reasons. */}
        <p className="mt-2 text-sm opacity-70">
          <span className="tabular">{money.format(current?.cumulativePrincipal ?? 0)}</span> is
          money you moved in.{" "}
          <span className="tabular font-medium text-emerald-600 dark:text-emerald-400">
            {money.format(current?.cumulativeProfit ?? 0)}
          </span>{" "}
          is profit it earned.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <StatCard
            label="Pays for"
            value={coverageText(current?.passiveCoverage ?? null)}
            hint="of what this cycle cost you"
            tone={current?.passiveCoverage ? "positive" : "default"}
          />
          <StatCard
            label={`Yield (${YIELD_WINDOW}-cycle avg)`}
            value={percent(current?.trailingYield ?? null, 2)}
            hint="on the average daily balance"
          />
        </div>

        {drift !== 0 && Math.abs(drift) > 0.01 && (
          <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-500">
            Contributions and profit come to{" "}
            <span className="tabular">{money.format(Math.abs(drift))}</span>{" "}
            {drift > 0 ? "more" : "less"} than the balance. Something on this account is neither a
            transfer nor profit — the split below is describing less than the whole account.
          </p>
        )}
      </section>

      <PayoutTracker status={payout} anyProfit={anyProfit} />

      <ContributionsVsGrowth data={points} showOther={points.some((p) => p.other !== 0)} />

      <NetContribution data={points} />

      {anyProfit ? (
        <>
          <RealizedYield data={points} />
          <PassiveCoverage data={points} />
          <Projection balance={view.net} yields={yields} contribution={contribution} />
        </>
      ) : (
        <section className="mt-6 rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Realized yield
          </h2>
          <p className="mt-2 opacity-70">
            No profit has been credited to this account in the last {rows.length} cycles, so there
            is no rate to measure and nothing to project from. A profit message is what starts
            this — until one arrives, the balance here is only what you put in.
          </p>
        </section>
      )}

      <ContributionLedger rows={rows} />
    </div>
  );
}

/**
 * §11.5 — "a late or missing payout is worth an alert; a smaller-than-usual one
 * is not."
 *
 * `payoutStatus` is handed dates and nothing else, so the second half of that
 * rule is enforced by the type rather than by remembering it here.
 */
function PayoutTracker({ status, anyProfit }: { status: ReturnType<typeof payoutStatus>; anyProfit: boolean }) {
  if (status.state === "unknown" && !anyProfit) return null;

  const tone =
    status.state === "missing"
      ? "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400"
      : status.state === "late"
        ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-500"
        : "border-black/10 dark:border-white/15";

  const title =
    status.state === "missing"
      ? "A profit payout is missing"
      : status.state === "late"
        ? "Profit is late"
        : status.state === "on-time"
          ? "Profit is arriving on schedule"
          : "Not enough payouts to judge yet";

  return (
    <section className={`rounded-xl border p-4 ${tone}`}>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm opacity-80">{status.detail}</p>
      {status.state !== "unknown" && (
        <p className="mt-2 text-xs opacity-60">
          The amount is never checked — it varies every cycle by nature, and a warning that fired
          on a smaller-than-usual payout would fire most months and bury the one that never came.
        </p>
      )}
    </section>
  );
}

/** The transfers and payouts themselves, per cycle. The charts show the shape;
 *  this is where a figure can be traced back to something that happened. */
function ContributionLedger({ rows }: { rows: CycleSavings[] }) {
  const recent = [...rows].reverse().slice(0, 6);

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">By cycle</h2>
      {/* Four columns, not five: at 390px, "In" and "Out" as separate money
          columns leave the figures touching each other, and a 5,000.00 abutting
          a 166,635.86 is unreadable in the exact way a table is supposed to
          fix. Net carries both, signed — and the sign is the interesting half
          anyway, since a cycle can legitimately go the other way (§11.5). */}
      <div className="mt-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/10 text-left text-xs opacity-60 dark:border-white/15">
              <th className="py-1.5 pr-2 font-medium">Cycle</th>
              <th className="py-1.5 pl-3 text-right font-medium">Net in</th>
              <th className="py-1.5 pl-3 text-right font-medium">Profit</th>
              <th className="py-1.5 pl-3 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5 dark:divide-white/10">
            {recent.map((r) => (
              <tr key={r.cycle}>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  <span title={periodLabel("cycle", r.cycle)}>{r.label}</span>
                  {r.partial && <span className="ml-1 text-[11px] opacity-50">so far</span>}
                </td>
                <td
                  className={`tabular py-1.5 pl-3 text-right whitespace-nowrap ${
                    r.net < 0 ? "text-rose-600 dark:text-rose-400" : ""
                  }`}
                >
                  {r.net === 0 ? (
                    <span className="opacity-30">—</span>
                  ) : (
                    <>
                      {r.net < 0 ? "−" : ""}
                      {money.format(Math.abs(r.net))}
                    </>
                  )}
                </td>
                <td className="tabular py-1.5 pl-3 text-right whitespace-nowrap text-emerald-600 dark:text-emerald-400">
                  {r.profit > 0 ? money.format(r.profit) : <span className="opacity-30">—</span>}
                </td>
                <td className="tabular py-1.5 pl-3 text-right whitespace-nowrap">
                  {money.format(r.closingBalance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs opacity-50">
        A deposit here is an internal transfer, not income — moving your own money does not make
        you richer (§6). Profit is income, and it is the only column above that moves net worth.
        They land in the same account and only the bank&rsquo;s wording separates them, which is
        why they are counted apart rather than split out of the balance.
      </p>

      {rows.length > 0 && (
        <p className="mt-2 text-xs opacity-40">
          Measured from {civilShort(rows[0].cycle)} over {rows.length} cycles.
        </p>
      )}
    </section>
  );
}
