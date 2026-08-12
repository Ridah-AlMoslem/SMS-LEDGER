import { asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import Link from "next/link";

import { AccountsOverview } from "@/components/accounts-overview";
import { getDb, schema } from "@/db";
import { type AccountRow, type Alert, groupByInstitution } from "@/lib/accounts";

// Ledger data changes on every parser tick, so never prerender this.
export const dynamic = "force-dynamic";

const SAR = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const WHEN = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Riyadh",
});

async function load() {
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

  const transactions = await db
    .select({
      id: schema.transactions.id,
      postedAt: schema.transactions.postedAt,
      amount: schema.transactions.amount,
      direction: schema.transactions.direction,
      type: schema.transactions.type,
      merchant: schema.transactions.merchantRaw,
      biller: schema.transactions.biller,
      isInternal: schema.transactions.isInternalTransfer,
      accountName: schema.accounts.name,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
    .orderBy(desc(schema.transactions.postedAt))
    .limit(50);

  const alerts = (await db
    .select({
      accountId: schema.reconciliationAlerts.accountId,
      computedBalance: schema.reconciliationAlerts.computedBalance,
      reportedBalance: schema.reconciliationAlerts.reportedBalance,
      delta: schema.reconciliationAlerts.delta,
      detectedAt: schema.reconciliationAlerts.detectedAt,
    })
    .from(schema.reconciliationAlerts)
    .where(isNull(schema.reconciliationAlerts.resolvedAt))
    .orderBy(desc(schema.reconciliationAlerts.detectedAt))) as Alert[];

  const [parked] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.rawMessages)
    .where(inArray(schema.rawMessages.status, ["needs_review", "failed"]));

  return { accounts, transactions, alerts, parked: parked?.count ?? 0 };
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-black/10 p-8 text-center dark:border-white/15">
      <p className="font-medium">{title}</p>
      <p className="mt-2 text-sm opacity-70">{body}</p>
    </div>
  );
}

export default async function Page() {
  let data: Awaited<ReturnType<typeof load>>;

  try {
    data = await load();
  } catch (err) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <h1 className="text-xl font-semibold">Ledger</h1>
        <div className="mt-6">
          <Notice
            title="Can't reach the database"
            body={err instanceof Error ? err.message : String(err)}
          />
        </div>
      </main>
    );
  }

  const groups = groupByInstitution(data.accounts);

  return (
    <main className="mx-auto w-full max-w-2xl p-6 pb-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Ledger</h1>
        <Link
          href="/review"
          className={`text-sm ${
            data.parked > 0
              ? "text-amber-600 dark:text-amber-400"
              : "opacity-60 hover:opacity-100"
          }`}
        >
          Review
          {data.parked > 0 && (
            <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs">
              {data.parked}
            </span>
          )}
        </Link>
      </div>

      <div className="mt-6">
        {groups.length === 0 ? (
          <Notice
            title="No accounts yet"
            body="Run npm run db:seed to create them."
          />
        ) : (
          <AccountsOverview groups={groups} alerts={data.alerts} />
        )}
      </div>

      <section className="mt-10">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Recent transactions
          </h2>
          {data.transactions.length > 0 && (
            <span className="text-xs opacity-50">{data.transactions.length} shown</span>
          )}
        </header>

        <div className="mt-3">
          {data.transactions.length === 0 ? (
            <Notice
              title="No transactions yet"
              body="Send a signed message to /api/ingest, then run the parse tick."
            />
          ) : (
            <ul className="divide-y divide-black/10 dark:divide-white/10">
              {data.transactions.map((t) => {
                const credit = t.direction === "credit";
                // A label can be an Arabic biller name or a Latin merchant
                // string; .sms-body isolates the bidi run so a right-to-left
                // name cannot reorder the row around it.
                const label = t.merchant ?? t.biller ?? t.type;

                return (
                  <li key={t.id} className="flex items-center gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="sms-body truncate font-medium">{label}</p>
                      <p className="mt-0.5 text-xs opacity-60">
                        {WHEN.format(t.postedAt)} · {t.accountName}
                        {t.isInternal ? " · internal" : ""}
                      </p>
                    </div>
                    <div
                      className={`tabular shrink-0 text-sm ${
                        credit ? "text-emerald-600 dark:text-emerald-400" : ""
                      }`}
                    >
                      {credit ? "+" : "−"}
                      {SAR.format(Number(t.amount))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <p className="mt-8 text-xs opacity-50">
        Internal transfers are shown but excluded from spending totals — moving your own money is
        not an expense. A credit card contributes its debt (limit − available) to net worth, not
        its reported balance.
      </p>
    </main>
  );
}
