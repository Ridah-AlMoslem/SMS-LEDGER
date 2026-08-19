import { notFound } from "next/navigation";

import { AccountEditor } from "@/app/accounts/account-editor";
import { BalanceEntry } from "@/app/accounts/balance-entry";
import { AccountTransactions } from "@/components/accounts/account-transactions";
import { BalanceHistory } from "@/components/accounts/balance-history";
import { CardView } from "@/components/accounts/card-view";
import { CashbackView } from "@/components/accounts/cashback-view";
import { LoanView } from "@/components/accounts/loan-view";
import { ReconciliationPanel } from "@/components/accounts/reconciliation";
import { SavingsView } from "@/components/accounts/savings-view";
import { EmptyState } from "@/components/ui/empty-state";
import { type AccountDetail, loadAccountDetail } from "@/db/account-detail";
import { driftPersists } from "@/db/reconciliation";
import { TYPE_LABELS, money, reconciliationOf, toView } from "@/lib/accounts";
import { reason } from "@/lib/errors";
import { dayMonthYear } from "@/lib/format";
import { periodBounds, periodLabel, shortLabel, today } from "@/lib/periods";
import { readSelection } from "@/lib/period-params";

import { BackLink } from "./back-link";
import { ResolveDrift } from "@/components/accounts/resolve-drift";

export const dynamic = "force-dynamic";

/**
 * One account — SPEC §3.3, §5.5, §6, §11.4, §11.5.
 *
 * The body varies by type because the question varies by type: a current
 * account is asking "does this balance hold up", a card is asking "what do I
 * owe and when is it due", a loan is asking "what is this costing me", and the
 * savings account is asking §11.5's whole question at once.
 *
 * **No period stepper.** A balance is a fact about now and stepping it would
 * imply otherwise, and web/CLAUDE.md's rule that there is only ever one date
 * scope on screen matters more here than anywhere: the card view already shows
 * a statement cycle beside a salary cycle, and a third control offering to move
 * one of them would make the pair unreadable. The `?period` in the URL is still
 * honoured, so a drill-through from Home lands on the cycle it came from.
 *
 * **This page stands alone.** §11.5's savings view is reached by tapping the
 * net worth strip on Home, not through the account list, so the title, the back
 * affordance and every explanation here assume no context from a parent screen.
 */
export default async function AccountPage(props: PageProps<"/accounts/[slug]">) {
  const { slug } = await props.params;
  const params = await props.searchParams;
  const { period } = readSelection(params);
  const now = today();

  let detail: AccountDetail | null;

  try {
    detail = await loadAccountDetail(slug, periodBounds("cycle", period).start, now);
  } catch (err) {
    return (
      <main>
        <BackLink />
        <h1 className="mt-1 text-xl font-semibold">Account</h1>
        <div className="mt-6">
          <EmptyState title="Can't reach the database" body={reason(err)} />
        </div>
      </main>
    );
  }

  if (!detail) notFound();

  const account = detail.account;
  const view = toView({ ...account, balanceAsOf: account.balanceAsOf });
  const reconciliation = reconciliationOf(account, detail.coverage);

  const cycle = detail.cycles[detail.cycles.length - 1];
  const cycleLabel = periodLabel("cycle", cycle);

  const open = detail.alerts.filter((a) => a.resolvedAt === null);
  const resolved = detail.alerts.filter((a) => a.resolvedAt !== null);

  const balanceTarget = {
    id: account.id,
    slug: account.slug,
    name: account.name,
    institution: account.institution,
    balanceSemantics: account.balanceSemantics,
    creditLimit: account.creditLimit,
    currentBalance: account.currentBalance,
    reconcilable: account.reconcilable,
  };

  const ledgerHref = `/ledger?account=${account.id}&grain=cycle&period=${cycle}`;

  const isCard = account.type === "credit_card";
  const isSavings = account.isProfitBearing;
  const isLoan = account.type === "loan";
  const isCashback = account.type === "cashback_wallet";

  return (
    <main>
      <BackLink />

      <header className="mt-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="sms-body truncate text-xl font-semibold">{account.name}</h1>
          <p className="mt-0.5 text-xs opacity-55">
            {account.institution} · {TYPE_LABELS[account.type] ?? account.type}
            {account.balanceAsOf && <> · as of {dayMonthYear(account.balanceAsOf)}</>}
          </p>
        </div>

        {/* The settings sheet, behind the row it edits everywhere else. It is
            the same component and the same server action; only the trigger
            differs. */}
        <AccountEditor
          account={{
            id: account.id,
            slug: account.slug,
            name: account.name,
            institution: account.institution,
            type: account.type,
            balanceSemantics: account.balanceSemantics,
            reconcilable: account.reconcilable,
            currentBalance: account.currentBalance,
            creditLimit: account.creditLimit,
            statementDay: account.statementDay,
            dueDay: account.dueDay,
            isProfitBearing: account.isProfitBearing,
            profitPayoutDay: account.profitPayoutDay,
          }}
          history={detail.edits}
        >
          <span className="block px-2 py-1 text-sm opacity-60">Settings</span>
        </AccountEditor>
      </header>

      {/* ------------------------------------------------------- the body */}

      {isSavings ? (
        <SavingsView detail={detail} view={view} today={now} />
      ) : isCard ? (
        <CardView
          view={view}
          statements={detail.statements}
          spendByCycle={detail.cycles.map((c) => ({
            cycle: c,
            label: shortLabel("cycle", c),
            expense: detail.flowByCycle.get(c)?.expense ?? 0,
          }))}
          cycleLabel={cycleLabel}
          today={now}
        />
      ) : isLoan ? (
        <LoanView view={view} loan={detail.loan} today={now} />
      ) : isCashback ? (
        <CashbackView view={view} legs={detail.legs} cycles={detail.cycles.length} />
      ) : (
        <CashView view={view} />
      )}

      {/* --------------------------------- reconciliation, on every account */}

      <div className="mt-6 space-y-3">
        <ReconciliationPanel r={reconciliation}>
          <BalanceEntry account={balanceTarget} variant="full" />
        </ReconciliationPanel>

        {open.map((alert) => (
          <section key={alert.id} className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-rose-700 dark:text-rose-400">
                  This account doesn&rsquo;t match the bank
                </p>
                <p className="mt-1 text-sm opacity-80">
                  We calculate <span className="tabular">{money(alert.computedBalance)}</span>, the
                  bank reported <span className="tabular">{money(alert.reportedBalance)}</span> —{" "}
                  {alert.delta > 0 ? "over" : "under"} by{" "}
                  <span className="tabular">{money(alert.delta)}</span>, seen{" "}
                  {dayMonthYear(alert.detectedAt)}.
                </p>
              </div>
              <ResolveDrift
                alertId={alert.id}
                slug={account.slug}
                delta={alert.delta}
                stillOff={driftPersists(Number(account.currentBalance), alert.reportedBalance)}
              />
            </div>
            <p className="mt-2 text-xs opacity-60">
              A difference means a message was missed, double-counted or misparsed. It clears
              itself once the missing one is parsed — or you can enter the balance the bank is
              showing, which books the difference to the ledger.
            </p>
          </section>
        ))}

        {resolved.length > 0 && (
          <details className="rounded-xl border border-black/10 p-4 dark:border-white/15">
            <summary className="cursor-pointer text-sm opacity-70">
              {resolved.length} earlier {resolved.length === 1 ? "difference" : "differences"},
              closed
            </summary>
            <ul className="mt-2 space-y-2 text-xs opacity-70">
              {resolved.map((alert) => (
                <li key={alert.id}>
                  <span className="tabular">{money(alert.delta)}</span> on{" "}
                  {dayMonthYear(alert.detectedAt)}
                  {alert.resolutionNote && <> — &ldquo;{alert.resolutionNote}&rdquo;</>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* ------------------------------ balance history and this cycle's rows */}

      {!isSavings && detail.snapshots.length > 0 && (
        <BalanceHistory points={detail.snapshots} current={Number(account.currentBalance)} />
      )}

      <AccountTransactions
        transactions={detail.transactions}
        cycleLabel={cycleLabel}
        href={ledgerHref}
        isCard={isCard}
      />
    </main>
  );
}

/** checking / wallet / cash — the plain case. One figure, and what it rests on. */
function CashView({ view }: { view: ReturnType<typeof toView> }) {
  return (
    <section className="mt-5 rounded-xl border border-black/10 p-5 dark:border-white/15">
      <p className="text-xs tracking-wide uppercase opacity-60">Balance</p>
      <p className={`tabular mt-1 text-3xl font-semibold ${view.net < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
        {view.net < 0 && "−"}
        {money(view.net)}
      </p>
      <p className="mt-1.5 text-xs opacity-55">
        Derived from every posted message on this account, not stored. Correcting it books an
        entry to the ledger rather than overwriting it, so the correction has a date you can find
        later.
      </p>
    </section>
  );
}
