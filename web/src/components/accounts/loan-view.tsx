/**
 * A loan — SPEC §11.4, §4 ("amortization is computed, not stored") and §6's
 * split.
 *
 * **Only the interest is spending.** A 2,000 payment with 300 of interest is
 * 300 of expense and 1,700 of debt reduction; the principal moves net worth and
 * must never reach the expense figure. `IS_EXPENSE` in `db/predicates.ts`
 * excludes `loan_payment` for exactly that reason, and every row of the table
 * below shows the two halves separately so the rule is visible rather than
 * asserted.
 *
 * The schedule is derived on every render from the APR and the balance. The
 * balance used is the **account's**, not `loans.current_balance`: the account
 * figure is derived from the posted legs by `recompute_balances`, so it follows
 * every payment automatically, while the stored copy is written by nothing.
 *
 * §14 resolves loans as "none" for v1 — no message source exists yet — so the
 * first thing this component has to do well is the case where the terms are not
 * known.
 */

import { StatCard } from "@/components/ui/stat-card";
import type { LoanTerms } from "@/db/account-detail";
import type { AccountView } from "@/lib/accounts";
import { amortize, normaliseApr } from "@/lib/liabilities";
import { type CivilDate, addMonths, civilShort, periodStart } from "@/lib/periods";

import { ExtraPaymentSimulator } from "./extra-payment";

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function LoanView({
  view,
  loan,
  today,
}: {
  view: AccountView;
  loan: LoanTerms | null;
  today: CivilDate;
}) {
  const debt = view.debt ?? 0;

  if (!loan || !loan.apr || !loan.paymentAmount) {
    return (
      <div className="mt-5 space-y-5">
        <Owed debt={debt} />
        <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Amortization
          </h2>
          <p className="mt-2 text-sm opacity-70">
            {loan
              ? "This loan has no rate or payment amount recorded, and both are needed to split a payment into interest and principal."
              : "No loan terms are on record for this account."}{" "}
            The schedule is computed from the rate and the balance rather than stored (§4), so
            without a rate there is nothing to compute — the balance above is still real, it is
            derived from the payments that have actually posted.
          </p>
          <p className="mt-2 text-xs opacity-50">
            Add a row to <code>loans</code> named <code>{view.slug}</code> with an{" "}
            <code>apr</code> and a <code>payment_amount</code> to turn this on.
          </p>
        </section>
      </div>
    );
  }

  // The next payment falls in the month the payment day next occurs. Anchored
  // on the cycle start rather than on today so the schedule does not shuffle by
  // a month each time the page is opened either side of the payment date.
  const from = addMonths(periodStart(today), 1);

  const schedule = amortize({ balance: debt, apr: loan.apr, payment: loan.paymentAmount, from });
  const apr = normaliseApr(loan.apr);

  if (schedule.underwater) {
    return (
      <div className="mt-5 space-y-5">
        <Owed debt={debt} />
        <section className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-4">
          <p className="text-sm font-medium text-rose-700 dark:text-rose-400">
            This payment never clears the balance
          </p>
          <p className="mt-1 text-sm opacity-80">
            At {(apr * 100).toFixed(2)}% a year, one month&rsquo;s interest on{" "}
            <span className="tabular">{money.format(debt)}</span> is{" "}
            <span className="tabular">{money.format((debt * apr) / 12)}</span> — more than the{" "}
            <span className="tabular">{money.format(loan.paymentAmount)}</span> payment on record.
            The debt grows with every payment made.
          </p>
        </section>
      </div>
    );
  }

  const upcoming = schedule.rows.slice(0, 12);

  return (
    <div className="mt-5 space-y-5">
      <Owed debt={debt} />

      <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <div className="grid grid-cols-3 gap-2.5">
          <StatCard
            label="Paid off"
            value={schedule.payoffDate ? civilShort(schedule.payoffDate) : "—"}
            hint={schedule.months !== null ? `${schedule.months} payments` : undefined}
          />
          <StatCard
            label="Interest left"
            value={<span className="tabular">{money.format(schedule.totalInterest)}</span>}
            hint="the only part that is spending"
            tone="negative"
          />
          <StatCard
            label="Rate"
            value={`${(apr * 100).toFixed(2)}%`}
            hint={`${money.format(loan.paymentAmount)} a month`}
          />
        </div>
      </section>

      <ExtraPaymentSimulator
        balance={debt}
        apr={loan.apr}
        payment={loan.paymentAmount}
        from={from}
      />

      <section>
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Next {upcoming.length} payments
        </h2>
        <p className="mt-1 text-xs opacity-55">
          Computed from the rate and today&rsquo;s balance, never stored — a saved schedule stops
          being true the first time a payment is early, late or larger.
        </p>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs opacity-60 dark:border-white/15">
                <th className="py-1.5 font-medium">Due</th>
                <th className="py-1.5 text-right font-medium">Payment</th>
                <th className="py-1.5 text-right font-medium">Interest</th>
                <th className="py-1.5 text-right font-medium">Principal</th>
                <th className="py-1.5 text-right font-medium">Left</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 dark:divide-white/10">
              {upcoming.map((r) => (
                <tr key={r.n}>
                  <td className="py-1.5">{civilShort(r.due)}</td>
                  <td className="tabular py-1.5 text-right">{money.format(r.payment)}</td>
                  <td className="tabular py-1.5 text-right text-rose-600 dark:text-rose-400">
                    {money.format(r.interest)}
                  </td>
                  <td className="tabular py-1.5 text-right opacity-70">
                    {money.format(r.principal)}
                  </td>
                  <td className="tabular py-1.5 text-right">{money.format(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs opacity-50">
          The interest column is spending. The principal column is not — it moves money from your
          account to your debt, which changes net worth by nothing and must stay out of the expense
          figure. Counting the whole payment would report the principal twice: once as spending and
          again as debt reduction (§6).
        </p>
      </section>
    </div>
  );
}

function Owed({ debt }: { debt: number }) {
  return (
    <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
      <p className="text-xs tracking-wide uppercase opacity-60">You owe</p>
      <p className="tabular mt-1 text-3xl font-semibold text-rose-600 dark:text-rose-400">
        {money.format(debt)}
      </p>
      <p className="mt-1.5 text-xs opacity-55">
        Derived from the payments that have posted, not from a stored schedule.
      </p>
    </section>
  );
}
