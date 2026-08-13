import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { periodTransactions } from "@/db/aggregates";
import { readSelection } from "@/lib/period-params";
import { periodLabel } from "@/lib/periods";

export const dynamic = "force-dynamic";

const WHEN = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Riyadh",
});

/**
 * Every transaction in the selected period.
 *
 * Scoped through `v_categorized_amounts`, the same view the totals on Home
 * read, so the list and the summary can never disagree about which
 * transactions belong to "this month".
 *
 * Filters, search, editing and splits are milestone 8 (§12); this is the list
 * they will hang off.
 */
export default async function LedgerPage(props: PageProps<"/ledger">) {
  const { grain, period } = readSelection(await props.searchParams);

  let rows: Awaited<ReturnType<typeof periodTransactions>>;
  try {
    rows = await periodTransactions(grain, period);
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Ledger</h1>
        <div className="mt-6">
          <EmptyState
            title="Can't reach the database"
            body={err instanceof Error ? err.message : String(err)}
          />
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Ledger</h1>
        <p className="text-xs opacity-50">
          {rows.length > 0 ? `${rows.length} shown` : periodLabel(grain, period)}
        </p>
      </div>

      <div className="mt-5">
        {rows.length === 0 ? (
          <EmptyState
            title={`Nothing in this ${grain}`}
            body={
              <>
                {periodLabel(grain, period)} has no transactions. Step back with the arrows above,
                or switch grain.
              </>
            }
          />
        ) : (
          <ul className="divide-y divide-black/10 dark:divide-white/10">
            {rows.map((t) => {
              const credit = t.direction === "credit";
              // Can be an Arabic biller name or a Latin merchant string;
              // .sms-body isolates the bidi run so a right-to-left name cannot
              // reorder the row around it.
              const label = t.merchant ?? t.biller ?? t.type;

              return (
                <li key={t.id} className="flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="sms-body truncate font-medium">{label}</p>
                    <p className="mt-0.5 truncate text-xs opacity-60">
                      {WHEN.format(t.postedAt)} · {t.accountName}
                      {t.categoryName ? ` · ${t.categoryName}` : ""}
                      {t.isInternal ? " · internal" : ""}
                    </p>
                  </div>
                  <Money
                    value={credit ? Number(t.amount) : -Number(t.amount)}
                    tone={credit ? "auto" : "none"}
                    sign={credit ? "always" : "auto"}
                    className="shrink-0 text-sm"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-8 text-xs opacity-50">
        Internal transfers are listed but excluded from spending totals. A transaction marked
        &ldquo;Split&rdquo; is divided across several categories; it counts once here and once in
        total, split across categories in the breakdowns.
      </p>
    </main>
  );
}
