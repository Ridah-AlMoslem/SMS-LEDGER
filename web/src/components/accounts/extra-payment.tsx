"use client";

/**
 * The extra-payment simulator (§11.4).
 *
 * Client-side because the whole point is the slider. The arithmetic is
 * `lib/liabilities.ts`, which is pure and tested — this recomputes the schedule
 * on every change rather than interpolating between precomputed ones, because a
 * few hundred iterations of one multiply is nothing and an interpolated payoff
 * date is a wrong payoff date.
 *
 * It reports two things and not one: months saved persuades some people and
 * interest saved persuades others. The second is also the only half that was
 * ever spending (§6) — the principal you pay early was always yours to move.
 */

import { useState } from "react";

import { extraPayment } from "@/lib/liabilities";
import { type CivilDate, civilShort } from "@/lib/periods";

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function ExtraPaymentSimulator({
  balance,
  apr,
  payment,
  from,
}: {
  balance: number;
  apr: number;
  payment: number;
  from: CivilDate;
}) {
  const [extra, setExtra] = useState(0);

  const { base, withExtra, monthsSaved, interestSaved } = extraPayment({
    balance,
    apr,
    payment,
    extra,
    from,
  });

  const max = Math.max(500, Math.round((payment * 2) / 100) * 100);

  return (
    <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
      <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
        Pay a little more
      </h2>

      <label className="mt-3 block text-xs">
        <span className="flex items-baseline justify-between">
          <span className="opacity-70">Extra per payment</span>
          <span className="tabular font-medium">
            {extra === 0 ? "nothing extra" : `+${money.format(extra)}`}
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={max}
          step={50}
          value={extra}
          onChange={(e) => setExtra(Number(e.target.value))}
          className="mt-1.5 w-full accent-emerald-500"
          aria-label="Extra payment per month"
        />
      </label>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs opacity-60">Paid off</dt>
          <dd className="tabular mt-0.5 font-medium">
            {withExtra.payoffDate ? civilShort(withExtra.payoffDate) : "—"}
          </dd>
          <dd className="mt-0.5 text-xs opacity-55">
            {base.payoffDate ? `instead of ${civilShort(base.payoffDate)}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs opacity-60">Interest saved</dt>
          <dd className="tabular mt-0.5 font-medium text-emerald-600 dark:text-emerald-400">
            {money.format(Math.max(0, interestSaved))}
          </dd>
          <dd className="mt-0.5 text-xs opacity-55">
            {monthsSaved !== null && monthsSaved > 0
              ? `${monthsSaved} ${monthsSaved === 1 ? "payment" : "payments"} fewer`
              : "move the slider"}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs opacity-50">
        Every extra riyal goes straight to principal, so it removes that riyal&rsquo;s interest
        from every remaining month. Only the interest was ever spending — the principal moves net
        worth rather than the expense figure (§6).
      </p>
    </section>
  );
}
