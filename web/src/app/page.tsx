import { desc, eq } from "drizzle-orm";

import { getDb, schema } from "@/db";

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

async function getTransactions() {
  const db = getDb();
  return db
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
    .limit(100);
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/15 p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-2 text-sm opacity-70">{body}</p>
    </div>
  );
}

export default async function Page() {
  let rows: Awaited<ReturnType<typeof getTransactions>>;

  try {
    rows = await getTransactions();
  } catch (err) {
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Ledger</h1>
        <div className="mt-6">
          <Empty
            title="Can't reach the database"
            body={err instanceof Error ? err.message : String(err)}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Ledger</h1>
        <span className="text-sm opacity-60">
          {rows.length} {rows.length === 1 ? "transaction" : "transactions"}
        </span>
      </header>

      <div className="mt-6">
        {rows.length === 0 ? (
          <Empty
            title="No transactions yet"
            body="Send a signed message to /api/ingest, then run the parse tick."
          />
        ) : (
          <ul className="divide-y divide-black/10 dark:divide-white/10">
            {rows.map((t) => {
              const credit = t.direction === "credit";
              // A description can be an Arabic biller name or a Latin merchant
              // string; .sms-body isolates the bidi run so a right-to-left name
              // cannot reorder the row around it.
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

      <p className="mt-8 text-xs opacity-50">
        Internal transfers are shown but excluded from spending totals — moving your own money
        is not an expense.
      </p>
    </main>
  );
}
