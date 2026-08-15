/**
 * Where the budget is going, five rows at a time (SPEC §11.2).
 *
 * Ranked by **share of budget consumed**, not by amount: a 300 grocery bill
 * against a 2,000 budget is not news, and a 300 coffee habit against a 250
 * budget is. Categories without a budget can only be ranked by size, so they
 * sort below the budgeted ones and say plainly that they are unbudgeted rather
 * than rendering an empty bar that reads as "nothing spent".
 *
 * `base` and `carry` are printed as two numbers wherever carry is non-zero.
 * §11.2 asks for exactly this: a category with a 2,000 base and a −1,800 carry
 * has 200 left, and showing only the 200 makes an emergency look like a policy.
 */

import Link from "next/link";

import { Money } from "@/components/ui/money";
import type { CategoryPace as Row } from "@/db/home";

function Bar({ share, over }: { share: number; over: boolean }) {
  const width = Math.min(Math.max(share, 0), 1) * 100;
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.10]">
      <div
        className={`h-full rounded-full ${over ? "bg-rose-500" : "bg-foreground/60"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function CategoryPaceList({ rows, cycleLabel }: { rows: Row[]; cycleLabel: string }) {
  if (rows.length === 0) return null;

  return (
    <section className="mt-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Categories</h2>
        <p className="text-xs opacity-50">{cycleLabel}</p>
      </div>

      <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
        {rows.map((row) => {
          const budgeted = row.effective !== null;
          const over = budgeted && row.spent > (row.effective ?? 0);
          // §11.2 — "projected end-of-cycle spend per category from current run
          // rate". Amber, not red: it has not happened yet.
          const projectedOver = budgeted && !over && row.projected > (row.effective ?? 0);

          return (
            <li key={row.categoryId ?? "uncategorized"}>
              <Link
                href={row.categoryId ? `/categories/${row.categoryId}` : "/ledger?uncategorized=1"}
                className="block py-2.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {row.icon && <span aria-hidden="true">{row.icon} </span>}
                    <span className="sms-body">{row.name}</span>
                  </p>
                  <p
                    className={`shrink-0 text-sm ${
                      over ? "text-rose-600 dark:text-rose-400" : ""
                    }`}
                  >
                    <Money value={row.spent} />
                    {budgeted && (
                      <span className="opacity-50">
                        {" / "}
                        <Money value={row.effective ?? 0} />
                      </span>
                    )}
                  </p>
                </div>

                {budgeted ? (
                  <>
                    <Bar share={row.share ?? 0} over={over} />
                    <p className="mt-1 text-xs opacity-55">
                      {row.carry !== 0 && (
                        <>
                          base <Money value={row.base ?? 0} />
                          {row.carry > 0 ? " + carry " : " − carry "}
                          <Money value={Math.abs(row.carry)} />
                          {" · "}
                        </>
                      )}
                      <span className={projectedOver ? "text-amber-600 dark:text-amber-400" : ""}>
                        heading for <Money value={row.projected} />
                      </span>
                      {over && (
                        <span className="text-rose-600 dark:text-rose-400">
                          {" · "}
                          <Money value={row.spent - (row.effective ?? 0)} /> over
                        </span>
                      )}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-xs opacity-55">
                    No budget · heading for <Money value={row.projected} /> by the end of the cycle
                  </p>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
