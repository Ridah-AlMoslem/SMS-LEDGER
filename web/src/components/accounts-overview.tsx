import { AccountEditor, type EditRecord } from "@/app/accounts/account-editor";
import {
  type AccountView,
  type Alert,
  type Group,
  TYPE_LABELS,
  asOf,
  money,
  totals,
} from "@/lib/accounts";

function Badge({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warn" | "danger";
}) {
  const tones = {
    muted: "bg-black/5 dark:bg-white/10 text-current/70",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    danger: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] leading-none ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Credit cards get their own row: the headline is what you OWE, and the
 *  reported figure is demoted to a subtitle. See §3.3a. */
function CreditCardRow({ a, drifted }: { a: AccountView; drifted: boolean }) {
  const pct = a.utilisation === null ? null : Math.round(a.utilisation * 100);

  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="sms-body truncate font-medium">{a.name}</p>
          <AccountMeta a={a} drifted={drifted} />
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular text-base font-semibold text-rose-600 dark:text-rose-400">
            {money(a.debt ?? 0)}
          </p>
          <p className="text-[11px] opacity-60">owed</p>
        </div>
      </div>

      {a.limit !== null && (
        <div className="mt-2.5">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
            role="img"
            aria-label={`${pct}% of credit limit used`}
          >
            <div
              className={`h-full rounded-full ${
                (pct ?? 0) >= 80 ? "bg-rose-500" : (pct ?? 0) >= 50 ? "bg-amber-500" : "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs opacity-60">
            <span className="tabular">{money(a.available ?? 0)}</span> available of{" "}
            <span className="tabular">{money(a.limit)}</span>
            {pct !== null && <> · {pct}% used</>}
          </p>
        </div>
      )}
    </div>
  );
}

/** Shared subtitle. §3.3b is emphatic that "unverifiable" must never look like
 *  "verified", so the absence of reconciliation is stated rather than implied
 *  by the absence of a badge. */
function AccountMeta({ a, drifted }: { a: AccountView; drifted: boolean }) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs opacity-60">
      <span>{TYPE_LABELS[a.type] ?? a.type}</span>
      {a.isProfitBearing && <Badge>profit-bearing</Badge>}
      {!a.reconcilable && <Badge tone="warn">no balance in SMS</Badge>}
      {drifted && <Badge tone="danger">doesn&rsquo;t match bank</Badge>}
    </p>
  );
}

function AccountRowView({ a, drifted }: { a: AccountView; drifted: boolean }) {
  if (a.type === "credit_card") return <CreditCardRow a={a} drifted={drifted} />;

  const zero = a.net === 0;

  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="sms-body truncate font-medium">{a.name}</p>
        <AccountMeta a={a} drifted={drifted} />
      </div>

      <p className={`tabular shrink-0 text-base ${zero ? "opacity-40" : "font-medium"}`}>
        {money(a.net)}
      </p>
    </div>
  );
}

/** The subset of a row the edit sheet is allowed to change. Picked explicitly
 *  rather than passed whole: `AccountView` carries derived figures (`net`,
 *  `debt`, `utilisation`) that are conclusions, not settings, and putting a
 *  conclusion in a form is how it becomes an input. */
function editable(a: AccountView) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    institution: a.institution,
    type: a.type,
    balanceSemantics: a.balanceSemantics,
    reconcilable: a.reconcilable,
    currentBalance: a.currentBalance,
    creditLimit: a.creditLimit,
    statementDay: a.statementDay,
    dueDay: a.dueDay,
    isProfitBearing: a.isProfitBearing,
    profitPayoutDay: a.profitPayoutDay,
  };
}

function GroupCard({
  group,
  drifted,
  edits,
}: {
  group: Group;
  drifted: Set<string>;
  edits: Record<string, EditRecord[]>;
}) {
  const negative = group.net < 0;

  return (
    <section className="rounded-xl border border-black/10 dark:border-white/15">
      <header className="flex items-baseline justify-between gap-4 border-b border-black/10 px-4 py-2.5 dark:border-white/10">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">{group.label}</h2>
        <p
          className={`tabular text-sm font-medium ${
            negative ? "text-rose-600 dark:text-rose-400" : ""
          }`}
        >
          {negative && "−"}
          {money(group.net)}
        </p>
      </header>

      <div className="divide-y divide-black/5 px-4 dark:divide-white/5">
        {group.accounts.map((a) => (
          <AccountEditor key={a.id} account={editable(a)} history={edits[a.id] ?? []}>
            <AccountRowView a={a} drifted={drifted.has(a.id)} />
          </AccountEditor>
        ))}
      </div>
    </section>
  );
}

export function AccountsOverview({
  groups,
  alerts,
  edits,
}: {
  groups: Group[];
  alerts: Alert[];
  /** Account id → its recent hand edits, newest first. */
  edits: Record<string, EditRecord[]>;
}) {
  const { assets, debt, netWorth } = totals(groups);
  const drifted = new Set(alerts.map((a) => a.accountId));
  const byId = new Map(groups.flatMap((g) => g.accounts).map((a) => [a.id, a]));

  const stale = groups
    .flatMap((g) => g.accounts)
    .map((a) => a.balanceAsOf)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <p className="text-xs tracking-wide uppercase opacity-60">Net worth</p>
        <p className="tabular mt-1 text-3xl font-semibold">{money(netWorth)}</p>

        <div className="mt-3 flex gap-5 text-sm">
          <span>
            <span className="opacity-60">Assets </span>
            <span className="tabular text-emerald-600 dark:text-emerald-400">{money(assets)}</span>
          </span>
          <span>
            <span className="opacity-60">Owed </span>
            <span className="tabular text-rose-600 dark:text-rose-400">{money(debt)}</span>
          </span>
        </div>

        {stale && (
          <p className="mt-3 text-xs opacity-50">
            Opening balances set {asOf(stale)}. Figures move as messages are parsed.
          </p>
        )}
      </section>

      {/* §3.3 — drift means a message was missed, double-counted or misparsed.
          Surfacing it is the whole point; a dashboard that hides this is
          decorative. */}
      {alerts.length > 0 && (
        <section className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-4">
          <p className="text-sm font-medium text-rose-700 dark:text-rose-400">
            {alerts.length === 1
              ? "One account doesn't match the bank"
              : `${alerts.length} accounts don't match the bank`}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {alerts.map((al) => {
              const acct = byId.get(al.accountId);
              const off = Number(al.delta);
              return (
                <li key={al.accountId} className="opacity-80">
                  <span className="font-medium">{acct?.name ?? "Unknown account"}</span>{" "}
                  — we calculate <span className="tabular">{money(Number(al.computedBalance))}</span>,
                  the bank reports <span className="tabular">{money(Number(al.reportedBalance))}</span>{" "}
                  ({off > 0 ? "over" : "under"} by{" "}
                  <span className="tabular">{money(off)}</span>)
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs opacity-60">
            Usually a message that never arrived. It clears itself once the missing one is
            parsed.
          </p>
        </section>
      )}

      {groups.map((g) => (
        <GroupCard key={g.institution} group={g} drifted={drifted} edits={edits} />
      ))}

      <p className="text-xs opacity-50">
        Tap an account to edit it. A corrected balance is booked to the ledger as an adjustment —
        it is a dated entry you can find later, not an overwrite, and it counts as neither income
        nor spending.
      </p>
    </div>
  );
}
