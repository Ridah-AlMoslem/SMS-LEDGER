import {
  type AccountView,
  type Group,
  TYPE_LABELS,
  asOf,
  money,
  totals,
} from "@/lib/accounts";

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) {
  const tones = {
    muted: "bg-black/5 dark:bg-white/10 text-current/70",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] leading-none ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Credit cards get their own row: the headline is what you OWE, and the
 *  reported figure is demoted to a subtitle. See §3.3a. */
function CreditCardRow({ a }: { a: AccountView }) {
  const pct = a.utilisation === null ? null : Math.round(a.utilisation * 100);

  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="sms-body truncate font-medium">{a.name}</p>
          <p className="mt-0.5 text-xs opacity-60">{TYPE_LABELS[a.type] ?? a.type}</p>
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

function AccountRowView({ a }: { a: AccountView }) {
  if (a.type === "credit_card") return <CreditCardRow a={a} />;

  const zero = a.net === 0;

  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="sms-body truncate font-medium">{a.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs opacity-60">
          <span>{TYPE_LABELS[a.type] ?? a.type}</span>
          {a.isProfitBearing && <Badge>profit-bearing</Badge>}
          {/* §3.3b — "unverifiable" must never look like "verified". */}
          {!a.reconcilable && <Badge tone="warn">no balance in SMS</Badge>}
        </p>
      </div>

      <p className={`tabular shrink-0 text-base ${zero ? "opacity-40" : "font-medium"}`}>
        {money(a.net)}
      </p>
    </div>
  );
}

function GroupCard({ group }: { group: Group }) {
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
          <AccountRowView key={a.id} a={a} />
        ))}
      </div>
    </section>
  );
}

export function AccountsOverview({ groups }: { groups: Group[] }) {
  const { assets, debt, netWorth } = totals(groups);

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

      {groups.map((g) => (
        <GroupCard key={g.institution} group={g} />
      ))}
    </div>
  );
}
