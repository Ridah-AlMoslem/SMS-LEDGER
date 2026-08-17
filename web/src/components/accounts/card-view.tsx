/**
 * The credit card — SPEC §11.4, and the two rules that make it readable.
 *
 * **§3.3a: the headline is what you OWE.** The bank's `رصيد` on this card is
 * *available credit*: purchases lower it, payments raise it. Reading it as debt
 * turns a 3,411 liability into a 10,588 asset — a ~14,000 error in net worth on
 * one account. `toView()` in `lib/accounts.ts` does that arithmetic and is the
 * only place allowed to; here the derived debt is the big figure and the
 * reported one is demoted to a subtitle that says what it means.
 *
 * **§5.5: this is the only screen where a statement cycle may exist.** A
 * statement runs on the bank's dates; everything else in this app runs 25th →
 * 24th. So two months genuinely appear here at once, and they are labelled as
 * two different things — *what the bank is asking you to pay* against *what the
 * card cost you this cycle*. Anywhere else that pairing would be a bug; the
 * failure mode being avoided is two unlabelled "this month" figures that
 * disagree.
 */

import { StatCard } from "@/components/ui/stat-card";
import type { CardStatement } from "@/db/account-detail";
import type { AccountView } from "@/lib/accounts";
import { balanceMeaning, minimumVsFull, statementState } from "@/lib/liabilities";
import { type CivilDate, civilShort } from "@/lib/periods";

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function CardView({
  view,
  statements,
  /** This account's own spend, per cycle, oldest first. Salary cycles (§5.5). */
  spendByCycle,
  cycleLabel,
  today,
}: {
  view: AccountView;
  statements: CardStatement[];
  spendByCycle: { cycle: CivilDate; label: string; expense: number }[];
  cycleLabel: string;
  today: CivilDate;
}) {
  const debt = view.debt ?? 0;
  const pct = view.utilisation === null ? null : Math.round(view.utilisation * 100);
  const latest = statements[0] ?? null;
  const state = latest ? statementState(latest, today) : null;

  const thisCycle = spendByCycle[spendByCycle.length - 1]?.expense ?? 0;
  const previous = spendByCycle.slice(0, -1);
  const average =
    previous.length > 0 ? previous.reduce((s, c) => s + c.expense, 0) / previous.length : null;

  const comparison = minimumVsFull({
    balance: debt,
    minimumDue: latest?.minimumDue ?? null,
    totalDue: latest?.totalDue ?? null,
  });

  return (
    <div className="mt-5 space-y-5">
      {/* --------------------------------------------- what you owe (§3.3a) */}
      <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <p className="text-xs tracking-wide uppercase opacity-60">You owe</p>
        <p className="tabular mt-1 text-3xl font-semibold text-rose-600 dark:text-rose-400">
          {money.format(debt)}
        </p>

        <p className="mt-1.5 text-xs opacity-55">
          The bank reports{" "}
          <span className="tabular">{money.format(Number(view.currentBalance))}</span>
          {view.balanceSemantics === "available_credit" ? " available" : ""}
          {view.limit !== null && (
            <>
              {" "}
              of a <span className="tabular">{money.format(view.limit)}</span> limit
            </>
          )}
          . {balanceMeaning(view.balanceSemantics)}
        </p>

        {view.limit !== null && (
          <div className="mt-4 flex items-center gap-4">
            <UtilisationRing pct={pct ?? 0} />
            <div className="min-w-0 text-sm">
              <p className="font-medium">
                <span className="tabular">{pct}%</span> of your limit is used
              </p>
              <p className="mt-0.5 text-xs opacity-60">
                <span className="tabular">{money.format(view.available ?? 0)}</span> still
                available
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------ the statement cycle (§5.5) */}
      <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Statement
          </h2>
          {latest && (
            <span className="text-xs opacity-55">{civilShort(latest.statementDate)}</span>
          )}
        </div>

        {!latest ? (
          <p className="mt-2 text-sm opacity-70">
            No statement message has ever arrived for this card, so there is nothing here to state
            a total, a minimum or a due date. The figure above is derived from the purchases and
            payments that <em>have</em> been parsed — it is what you owe, not what the bank has
            billed.
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              <StatCard
                label="Statement total"
                value={
                  <span className="tabular">
                    {latest.totalDue === null ? "—" : money.format(latest.totalDue)}
                  </span>
                }
              />
              <StatCard
                label="Minimum due"
                value={
                  <span className="tabular">
                    {latest.minimumDue === null ? "—" : money.format(latest.minimumDue)}
                  </span>
                }
              />
              <StatCard
                label={state?.paid ? "Settled" : "Due in"}
                value={
                  state?.paid ? (
                    "paid"
                  ) : state?.daysUntilDue == null ? (
                    "—"
                  ) : (
                    <span className="tabular">
                      {state.daysUntilDue < 0
                        ? `${-state.daysUntilDue}d late`
                        : `${state.daysUntilDue}d`}
                    </span>
                  )
                }
                tone={
                  state?.urgency === "overdue"
                    ? "negative"
                    : state?.urgency === "due-soon"
                      ? "warn"
                      : state?.urgency === "paid"
                        ? "positive"
                        : "default"
                }
              />
            </div>

            <p className="mt-2.5 text-xs opacity-60">{state?.detail}</p>

            {latest.dueDate && !state?.paid && (
              <p className="mt-1 text-xs opacity-45">
                Due {civilShort(latest.dueDate)}. This is the bank&rsquo;s own cycle, not the
                25th–24th one the rest of the app reports in.
              </p>
            )}
          </>
        )}
      </section>

      {/* ------------------------------- what the card cost, in SALARY cycles */}
      <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Spending on this card
        </h2>
        <p className="mt-1 text-xs opacity-55">{cycleLabel}</p>

        <p className="tabular mt-2 text-2xl font-semibold">{money.format(thisCycle)}</p>

        {average !== null && (
          <p className="mt-1 text-sm opacity-70">
            against <span className="tabular">{money.format(average)}</span> a cycle over the
            previous {previous.length}
          </p>
        )}

        {spendByCycle.length > 1 && (
          <ol className="mt-3 space-y-1.5">
            {spendByCycle.slice(-6).map((c) => {
              const max = Math.max(...spendByCycle.slice(-6).map((x) => x.expense), 1);
              return (
                <li key={c.cycle} className="flex items-center gap-2 text-xs">
                  <span className="w-8 shrink-0 opacity-60">{c.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.09]">
                    <span
                      className="block h-full rounded-full bg-rose-500/70"
                      style={{ width: `${Math.round((c.expense / max) * 100)}%` }}
                    />
                  </span>
                  <span className="tabular w-16 shrink-0 text-right opacity-70">
                    {whole.format(c.expense)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        <p className="mt-3 text-xs opacity-50">
          Reported in salary cycles like every other figure in this app, deliberately — the
          statement above runs on the bank&rsquo;s dates, and two unlabelled &ldquo;this
          month&rdquo; figures on one screen is the confusion this page exists to avoid. Paying
          the card is not counted here: the purchases were counted when they happened, and
          counting the payment too would inflate spending by up to 2× (§6).
        </p>
      </section>

      {/* --------------------------- minimum vs full, with the consequence */}
      {debt > 0 && (
        <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Pay it off, or pay the minimum
          </h2>

          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
              <p className="text-xs opacity-70">Pay it in full</p>
              <p className="tabular mt-0.5 text-xl font-semibold">{money.format(debt)}</p>
              <p className="mt-1 text-xs opacity-70">Once. No interest at all.</p>
            </div>

            <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3">
              <p className="text-xs opacity-70">Pay the minimum</p>
              <p className="tabular mt-0.5 text-xl font-semibold">
                {comparison.minimum.cleared
                  ? money.format(comparison.minimum.totalPaid)
                  : "never clears"}
              </p>
              <p className="mt-1 text-xs opacity-70">
                {comparison.minimum.cleared ? (
                  <>
                    over{" "}
                    <span className="tabular">{comparison.minimum.months}</span> months —{" "}
                    <span className="tabular font-medium">
                      {money.format(comparison.minimum.totalInterest)}
                    </span>{" "}
                    of it interest
                  </>
                ) : (
                  <>The minimum does not cover the interest, so the balance grows.</>
                )}
              </p>
            </div>
          </div>

          <p className="mt-3 text-xs opacity-50">
            At {(comparison.monthlyRate * 100).toFixed(2)}% a month, with the minimum taken as{" "}
            {(comparison.minimumShare * 100).toFixed(0)}% of the balance — this card&rsquo;s own
            ratio from the statement above. No message has ever stated a rate, so the rate is an
            assumption and is printed here rather than hidden inside the figure.
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * Utilisation, as a ring.
 *
 * A ring is right here and wrong on the savings screen for the same reason:
 * a credit limit **is** a target, fixed and imposed by someone else, so a
 * proportion of it is meaningful. A savings contribution has no such number.
 */
function UtilisationRing({ pct }: { pct: number }) {
  const size = 76;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, pct));

  const colour =
    clamped >= 80 ? "text-rose-500" : clamped >= 50 ? "text-amber-500" : "text-emerald-500";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${clamped}% of the credit limit used`}
      className="shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-black/10 dark:stroke-white/15"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className={`${colour} stroke-current`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-current text-sm font-semibold"
      >
        {clamped}%
      </text>
    </svg>
  );
}
