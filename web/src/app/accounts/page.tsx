import { asc, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";

import type { EditRecord } from "@/app/accounts/account-editor";
import { AccountsOverview } from "@/components/accounts-overview";
import { EmptyState } from "@/components/ui/empty-state";
import { getDb, schema } from "@/db";
import { recentEdits } from "@/db/account-edit";
import { type AccountRow, type Alert, groupByInstitution } from "@/lib/accounts";

export const dynamic = "force-dynamic";

/**
 * Balances, per institution.
 *
 * No period header state is used here on purpose: a balance is a fact about
 * right now, not about a reporting window, and showing it under a "week"
 * selector would imply it could be scoped to one. Card *spending* is reported
 * in salary cycles like everything else (§5.5) and lives in the ledger.
 */
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
      statementDay: schema.accounts.statementDay,
      dueDay: schema.accounts.dueDay,
      profitPayoutDay: schema.accounts.profitPayoutDay,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true))
    .orderBy(asc(schema.accounts.sortOrder))) as AccountRow[];

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

  // Grouped here rather than queried per row: the sheet for every account is
  // rendered with the list, and one query for all of them beats one per
  // account on a screen that already runs two.
  const edits: Record<string, EditRecord[]> = {};
  for (const row of await recentEdits(db)) {
    const record: EditRecord = {
      id: row.id,
      accountId: row.account_id,
      changed: row.changed,
      note: row.note,
      adjustmentTransactionId: row.adjustment_transaction_id,
      createdAt: row.created_at,
    };
    (edits[row.account_id] ??= []).push(record);
  }

  return { accounts, alerts, edits };
}

export default async function AccountsPage() {
  let data: Awaited<ReturnType<typeof load>>;

  try {
    data = await load();
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Accounts</h1>
        <div className="mt-6">
          <EmptyState
            title="Can't reach the database"
            body={err instanceof Error ? err.message : String(err)}
          />
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
          <AccountsOverview groups={groups} alerts={data.alerts} edits={data.edits} />
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
