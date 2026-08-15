/**
 * Merchant leaderboard (SPEC §11.1 chart 9).
 *
 * "An unglamorous table that is consistently the most actionable thing on
 * screen." It stays a table for that reason — a treemap or a donut of the same
 * eight rows would be prettier and would answer the question worse, because the
 * question is "how much, to whom, how many times", and all three are numbers.
 *
 * Every row drills through to the transactions behind it.
 */

import Link from "next/link";

import { Money } from "@/components/ui/money";
import type { MerchantRow } from "@/db/home";

export function MerchantTable({
  rows,
  total,
  hrefFor,
}: {
  rows: MerchantRow[];
  /** Period expense, for the share column. */
  total: number;
  hrefFor: (merchant: string) => string;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Where it went</h2>

      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-xs opacity-55 dark:border-white/15">
            <th className="py-1.5 font-medium">Merchant</th>
            <th className="py-1.5 text-right font-medium">Spent</th>
            <th className="w-12 py-1.5 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/5 dark:divide-white/10">
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="py-2">
                <Link href={hrefFor(row.name)} className="block hover:underline">
                  <span className="sms-body line-clamp-1">{row.name}</span>
                  <span className="text-xs opacity-50">
                    {row.count} transaction{row.count === 1 ? "" : "s"}
                  </span>
                </Link>
              </td>
              <td className="py-2 text-right align-top">
                <Money value={row.total} />
              </td>
              <td className="tabular py-2 text-right align-top text-xs opacity-55">
                {total > 0 ? `${Math.round((row.total / total) * 100)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
