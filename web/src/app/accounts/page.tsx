import Link from "next/link";

import { AccountsOverview } from "@/components/accounts-overview";
import { EmptyState } from "@/components/ui/empty-state";
import { type AccountsOverviewData, loadAccountsOverview } from "@/db/accounts";
import { groupByInstitution } from "@/lib/accounts";
import { reason } from "@/lib/errors";
import { today } from "@/lib/periods";

export const dynamic = "force-dynamic";

/**
 * Balances, per institution — SPEC §3.3, §11.4.
 *
 * No period header here on purpose: a balance is a fact about right now, not
 * about a reporting window, and showing it under a "week" selector would imply
 * it could be scoped to one. Card and account *spending* is reported in salary
 * cycles like everything else (§5.5), and lives one tap away on each account's
 * own page.
 *
 * Three things this screen must do that a list of balances would not:
 *
 *   1. **Split net worth into assets and liabilities.** They move for different
 *      reasons, and one net figure hides which.
 *   2. **State reconciliation per account** (§3.3b) — on every account, not as
 *      a badge on the exceptions. An account with nothing beside it reads as
 *      verified, and most of these are not verified, they are unchecked.
 *   3. **Offer manual balance entry on every account.** §3.3b makes it a v1
 *      requirement: it is the only anchor an account whose bank never states a
 *      balance will ever have.
 */
export default async function AccountsPage() {
  let data: AccountsOverviewData;

  try {
    data = await loadAccountsOverview(today());
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Accounts</h1>
        <div className="mt-6">
          <EmptyState title="Can't reach the database" body={reason(err)} />
        </div>
      </main>
    );
  }

  const groups = groupByInstitution(data.accounts);

  return (
    <main>
      <h1 className="text-xl font-semibold">Accounts</h1>

      <div className="mt-5">
        {groups.length === 0 ? (
          <EmptyState title="No accounts yet" body="Run npm run db:seed to create them." />
        ) : (
          <AccountsOverview groups={groups} alerts={data.alerts} coverage={data.coverage} />
        )}
      </div>

      <div className="mt-8">
        <Link
          href="/settings"
          className="flex items-center justify-between rounded-xl border border-black/10 px-4 py-3 text-sm hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/[0.06]"
        >
          <span>Settings</span>
          <span className="opacity-40">›</span>
        </Link>
      </div>
    </main>
  );
}
