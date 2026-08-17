/**
 * This cycle's transactions on one account.
 *
 * Scoped by `cycle_start`, not by a date range over `posted_at` — the same rule
 * every period-scoped list in this app follows, and for the reason §5.6 gives:
 * an early salary belongs to the cycle it *funds*, so the August cycle contains
 * a 23 July transaction and a `BETWEEN` would silently drop it. A list that
 * disagrees with the totals you arrived from is worse than no list.
 *
 * Internal transfers are shown and marked rather than hidden. On a savings or
 * card account they are most of the activity, and a list that quietly omitted
 * them would leave the balance moving for reasons nothing on screen explains.
 */

import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import type { AccountTransaction } from "@/db/account-detail";
import { timeOfDay } from "@/lib/format";

const TYPE_LABEL: Record<string, string> = {
  card_payment: "Card payment",
  loan_payment: "Loan payment",
  adjustment: "Balance correction",
  profit: "Profit",
  income: "Income",
  refund: "Refund",
  fee: "Fee",
  bill_payment: "Bill",
  withdrawal: "Cash withdrawal",
  purchase: "Purchase",
};

/**
 * What to call a row.
 *
 * The fallback chain matters more here than in the ledger: a transfer carries
 * no merchant, no biller and usually no description, so without a name of its
 * own it renders as the bare enum value. On a savings account that is most of
 * the list — and "transfer" twelve times over says nothing that the amount's
 * own sign does not already say, where "Moved in" and "Moved out" do.
 */
function label(t: AccountTransaction): string {
  if (t.merchant ?? t.biller) return (t.merchant ?? t.biller)!;
  if (t.description) return t.description;

  if (t.type === "transfer") {
    return t.isInternal
      ? t.direction === "credit"
        ? "Moved in from another account"
        : "Moved out to another account"
      : t.direction === "credit"
        ? "Transfer in"
        : "Transfer out";
  }

  return TYPE_LABEL[t.type] ?? t.type.replace(/_/g, " ");
}

export function AccountTransactions({
  transactions,
  cycleLabel,
  /** The ledger, filtered to this account and this cycle. */
  href,
  /** True for a card: the note underneath explains why payments do not count. */
  isCard,
}: {
  transactions: AccountTransaction[];
  cycleLabel: string;
  href: string;
  isCard?: boolean;
}) {
  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          This cycle
        </h2>
        <Link href={href} className="shrink-0 text-xs opacity-55 underline underline-offset-2 hover:opacity-100">
          all in the ledger
        </Link>
      </div>
      <p className="mt-1 text-xs opacity-55">{cycleLabel}</p>

      {transactions.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="Nothing this cycle"
            body="Either nothing moved on this account, or no message has arrived for it. The Review tab and the health panel tell you which."
          />
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
          {transactions.map((t) => (
            <li key={t.id} className="flex items-baseline gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="sms-body truncate text-sm">{label(t)}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs opacity-55">
                  <span className="tabular">{timeOfDay(t.postedAt)}</span>
                  {t.categoryName && <span>{t.categoryName}</span>}
                  {t.isInternal && <span>internal transfer</span>}
                  {t.origin === "manual" && <span>entered by hand</span>}
                  {t.reportedBalance !== null && (
                    <span className="tabular">
                      bank said {t.reportedBalance.toFixed(2)}
                    </span>
                  )}
                </p>
              </div>

              <Money
                value={t.direction === "credit" ? t.amount : -t.amount}
                sign="always"
                tone="auto"
                className="shrink-0 text-sm"
              />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs opacity-50">
        {isCard
          ? "A payment to this card is an internal transfer, not spending — the purchases it settles were counted when they happened (§6)."
          : "Internal transfers are listed but never counted as income or spending: moving your own money between accounts you own changes nothing about what you are worth (§6)."}
      </p>
    </section>
  );
}
