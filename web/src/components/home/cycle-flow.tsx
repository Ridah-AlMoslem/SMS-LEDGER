/**
 * Where the cycle's money went — SPEC §11.1 chart 8, deliberately **not** a
 * Sankey.
 *
 * A Sankey is the right diagram for this data and the wrong one for this
 * screen. At 390px its links are two or three pixels wide, its labels collide,
 * and the crossings that make it readable at desktop width become noise. So the
 * same three stages are a three-column list — income sources → category totals
 * → what was saved — with amounts and share percentages, stacked vertically on
 * a phone and side by side when there is room.
 *
 * The three columns tie out by the master invariant, not by construction:
 * `income − expense == Δ net worth`, and that difference either moved into
 * savings or stayed where it was. If the columns ever fail to add up, one of
 * §6's classification rules is being applied wrongly.
 */

import Link from "next/link";

import { Money } from "@/components/ui/money";
import type { CycleFlow as Flow } from "@/db/home";

function Column({
  title,
  total,
  children,
}: {
  title: string;
  total: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between border-b border-black/10 pb-1 dark:border-white/15">
        <h3 className="text-xs font-medium tracking-wide uppercase opacity-60">{title}</h3>
        <p className="text-sm font-medium">{total}</p>
      </div>
      <ul className="mt-1.5 space-y-1">{children}</ul>
    </div>
  );
}

/**
 * Deliberately no colour swatch.
 *
 * The categories here are ranked by this cycle's spend; the trend chart above
 * ranks them over six cycles, and its palette slots are assigned in that order.
 * Two different orderings on one screen would put the same category in two
 * different colours, which is worse than no colour at all — and this list is
 * already legible as names and numbers.
 */
function Row({
  label,
  amount,
  share,
  href,
}: {
  label: string;
  amount: number;
  share: number | null;
  href?: string;
}) {
  const body = (
    <>
      <span className="sms-body min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0">
        <Money value={amount} />
      </span>
      <span className="tabular w-9 shrink-0 text-right text-xs opacity-50">
        {share === null ? "" : `${Math.round(share * 100)}%`}
      </span>
    </>
  );

  return (
    <li className="flex items-baseline gap-1.5 text-sm">
      {href ? (
        <Link href={href} className="flex flex-1 items-baseline gap-1.5 hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

export function CycleFlowList({ flow, cycleLabel }: { flow: Flow; cycleLabel: string }) {
  const { income, categories, toSavings, retained, incomeTotal, expenseTotal } = flow;

  if (incomeTotal === 0 && expenseTotal === 0) return null;

  const shareOfIncome = (n: number) => (incomeTotal > 0 ? n / incomeTotal : null);

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
        Where the cycle went
      </h2>
      <p className="mt-1 text-xs opacity-55">
        {cycleLabel} — in, out, and what was left. Shares are of income.
      </p>

      {/* Stacked on a phone, three columns from `sm` up. Never a Sankey: see
          the note at the top of this file. */}
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:gap-5">
        <Column title="In" total={<Money value={incomeTotal} />}>
          {income.length === 0 ? (
            <li className="text-xs opacity-50">Nothing arrived this cycle.</li>
          ) : (
            income.map((source) => (
              <Row
                key={`${source.source}-${source.incomeClass}`}
                label={
                  source.incomeClass === "passive" ? `${source.source} (profit)` : source.source
                }
                amount={source.total}
                share={shareOfIncome(source.total)}
              />
            ))
          )}
        </Column>

        <Column title="Out" total={<Money value={expenseTotal} />}>
          {categories.length === 0 ? (
            <li className="text-xs opacity-50">Nothing spent this cycle.</li>
          ) : (
            categories
              .slice(0, 8)
              .map((c) => (
                <Row
                  key={c.categoryId ?? "uncategorized"}
                  label={c.name}
                  amount={c.total}
                  share={shareOfIncome(c.total)}
                  href={
                    c.categoryId ? `/categories/${c.categoryId}` : "/ledger?uncategorized=1"
                  }
                />
              ))
          )}
        </Column>

        <Column title="Left" total={<Money value={incomeTotal - expenseTotal} sign="always" />}>
          <Row label="Moved to savings" amount={toSavings} share={shareOfIncome(toSavings)} />
          <Row
            label="Stayed put / paid down debt"
            amount={retained}
            share={shareOfIncome(retained)}
          />
        </Column>
      </div>

      <p className="mt-3 text-xs opacity-50">
        In minus out is the change in net worth for the cycle — the master invariant of §6. Card
        payments, loan principal and transfers between your own accounts appear in none of these
        columns: none of them is money entering or leaving.
      </p>
    </section>
  );
}
