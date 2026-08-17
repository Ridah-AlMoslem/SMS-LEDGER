/**
 * The cashback wallet — SPEC §11.5's two-stage flow.
 *
 * AlRajhi sends two unrelated-looking messages and only one of them is income:
 *
 *   استرجاع نقدي            7.59  → **accrual**: credit to this wallet,
 *                                   `income_class='passive'`. Net worth rises;
 *                                   this is the moment the money is earned.
 *   استرداد نقدي إلى البطاقة 215.00 → **redemption**: an internal transfer,
 *                                   wallet → card. Net worth unchanged.
 *
 * "Booking both as income double-counts. Booking only the redemption
 * understates income and delays it by however long the balance sits
 * unredeemed." So the two legs are shown as two columns that do different
 * things, and the wallet balance between them is the amount earned and not yet
 * moved — which is precisely the figure that goes missing under either mistake.
 */

import { StatCard } from "@/components/ui/stat-card";
import type { DetailLeg } from "@/db/account-detail";
import type { AccountView } from "@/lib/accounts";
import { classify } from "@/lib/savings";
import { timeOfDay } from "@/lib/format";

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function CashbackView({
  view,
  legs,
  cycles,
}: {
  view: AccountView;
  legs: DetailLeg[];
  /** How many cycles the window below covers, for the caption. */
  cycles: number;
}) {
  // The same §6 classification the savings fold uses — an internal transfer out
  // is the redemption, a passive credit is the accrual. One rule, one place.
  const accruals = legs.filter((l) => classify(l) === "profit");
  const redemptions = legs.filter((l) => classify(l) === "withdrawal");

  const earned = accruals.reduce((sum, l) => sum + l.amount, 0);
  const redeemed = redemptions.reduce((sum, l) => sum + l.amount, 0);

  const recent = [...legs]
    .filter((l) => classify(l) === "profit" || classify(l) === "withdrawal")
    .reverse()
    .slice(0, 12);

  return (
    <div className="mt-5 space-y-5">
      <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <p className="text-xs tracking-wide uppercase opacity-60">Sitting in the wallet</p>
        <p className="tabular mt-1 text-3xl font-semibold">{money.format(view.net)}</p>
        <p className="mt-1.5 text-xs opacity-55">
          Earned and not yet moved to the card. It is already yours — it counted as income the day
          it accrued, not the day you redeem it.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <StatCard
            label="Earned"
            value={<span className="tabular">{money.format(earned)}</span>}
            hint={`${accruals.length} accruals · counts as income`}
            tone="positive"
          />
          <StatCard
            label="Redeemed to the card"
            value={<span className="tabular">{money.format(redeemed)}</span>}
            hint={`${redemptions.length} transfers · not income`}
          />
        </div>
      </section>

      <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Two events, not one
        </h2>

        <dl className="mt-3 space-y-3 text-sm">
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
            <dt className="font-medium text-emerald-700 dark:text-emerald-400">
              Accrual — passive income
            </dt>
            <dd className="mt-1 opacity-80">
              Cashback credited to this wallet. Net worth rises: this is money arriving from
              outside, and it is counted as income on the day it lands.
            </dd>
          </div>

          <div className="rounded-lg border border-black/10 p-3 dark:border-white/15">
            <dt className="font-medium">Redemption — internal transfer</dt>
            <dd className="mt-1 opacity-80">
              The same money moving from this wallet to the card. Net worth unchanged, and not
              income — it was already counted when it accrued.
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs opacity-50">
          Counting both would report the same riyal as income twice. Counting only the redemption
          would understate income and delay it by however long the balance sat here unredeemed —
          which on this wallet can be months (§11.5).
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Recent activity
        </h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">
            Nothing has accrued or been redeemed in the last {cycles} cycles.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
            {recent.map((l, i) => {
              const accrual = classify(l) === "profit";
              return (
                <li key={`${l.postedAt.toISOString()}-${i}`} className="flex items-baseline gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">
                      {accrual ? "Cashback earned" : "Redeemed to the card"}
                    </span>
                    <span className="block text-xs opacity-55">
                      {timeOfDay(l.postedAt)} ·{" "}
                      {accrual ? "passive income" : "internal transfer — not income"}
                    </span>
                  </span>
                  <span
                    className={`tabular shrink-0 text-sm ${
                      accrual ? "text-emerald-600 dark:text-emerald-400" : "opacity-70"
                    }`}
                  >
                    {accrual ? "+" : "−"}
                    {money.format(l.amount)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
