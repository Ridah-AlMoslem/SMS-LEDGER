/**
 * "Am I getting richer?" — the second question Home answers, and the app's only
 * entry point to the savings view (SPEC §11.5).
 *
 * Savings deliberately has no tab: the four fixed tabs are a decision, and
 * position five belongs to Review or to nothing. This strip is how §11.5 is
 * reached instead, which makes the tap target a **primary affordance** — full
 * width, with a chevron — rather than a detail someone has to discover.
 *
 * Two figures here are easy to get wrong and are not computed locally:
 *
 *   - **Net worth** comes from `toView()` in `lib/accounts.ts`, which reads a
 *     card's `available_credit` as spendable headroom and books `limit −
 *     available` as debt. Reading the stored figure as the debt turns a 3,411
 *     liability into a 10,588 asset (§3.3a).
 *   - **Δ this cycle is `income − expense`**, the master invariant of §6, not a
 *     difference of two balances. If the two ever disagree, one of §6's
 *     classification rules is being applied wrongly — which is exactly what the
 *     health panel checks and what the tests assert.
 */

import Link from "next/link";

import { Money } from "@/components/ui/money";
import { Sparkline } from "@/components/ui/sparkline";
import type { NetWorthPoint } from "@/lib/net-worth";

export function NetWorthStrip({
  netWorth,
  assets,
  debt,
  delta,
  series,
  passiveCoverage,
  passiveAmount,
  href,
  cycleLabel,
  savingsName,
}: {
  netWorth: number;
  assets: number;
  debt: number;
  /** income − expense over the cycle. Signed. */
  delta: number;
  series: NetWorthPoint[];
  /** §11.5 — cycle profit ÷ cycle expenses. null when nothing was spent, which
   *  would make the ratio a division by zero rather than an infinite coverage. */
  passiveCoverage: number | null;
  passiveAmount: number;
  /** The savings account detail, or the account list when none is marked
   *  profit-bearing yet. The strip is always tappable; where it lands is what
   *  varies. */
  href: string;
  cycleLabel: string;
  savingsName: string | null;
}) {
  const values = series.map((p) => p.value);

  // §11.5 — "your savings currently pays for 2% of your life." Small now,
  // compounds visibly, and it only does its job if it is seen daily, which is
  // why it lives here rather than inside the account detail it links to.
  const coverage =
    passiveCoverage === null
      ? null
      : passiveCoverage >= 0.1
        ? `${Math.round(passiveCoverage * 100)}%`
        : `${(passiveCoverage * 100).toFixed(1)}%`;

  return (
    <Link
      href={href}
      className="mt-3 block rounded-2xl border border-black/10 p-4 transition-colors
                 hover:bg-black/[0.02] dark:border-white/15 dark:hover:bg-white/[0.03]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide uppercase opacity-60">Net worth</p>
          <p className="mt-1 text-3xl leading-none font-semibold tracking-tight">
            <Money value={netWorth} currency />
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <Sparkline
              values={values}
              width={72}
              height={22}
              label={`Net worth across ${cycleLabel}`}
              className={delta < 0 ? "text-rose-500" : "text-emerald-500"}
            />
            <p className="mt-0.5 text-xs">
              <Money value={delta} sign="always" tone="auto" />
            </p>
          </div>
          <span aria-hidden="true" className="text-lg opacity-30">
            ›
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <span>
          <span className="opacity-55">Assets </span>
          <Money value={assets} />
        </span>
        <span>
          <span className="opacity-55">Owed </span>
          <Money value={debt} />
        </span>
        <span className="opacity-55">this cycle · {cycleLabel}</span>
      </div>

      <p className="mt-2.5 border-t border-black/5 pt-2.5 text-sm dark:border-white/10">
        {coverage === null ? (
          <span className="opacity-60">
            Nothing spent this cycle yet, so there is no coverage figure to give.
          </span>
        ) : (
          <>
            Your savings pays for <span className="font-semibold tabular">{coverage}</span> of your
            life
            <span className="opacity-55">
              {" "}
              — <Money value={passiveAmount} /> of profit against this cycle&rsquo;s spending
            </span>
          </>
        )}
      </p>

      <p className="mt-1.5 text-xs opacity-50">
        {savingsName
          ? `Tap for ${savingsName} — contributions, growth and realized yield`
          : "Tap for accounts — no savings account is marked profit-bearing yet"}
      </p>
    </Link>
  );
}
