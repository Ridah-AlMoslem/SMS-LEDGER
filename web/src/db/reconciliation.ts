/**
 * Closing a drift alert by hand (SPEC §3.3).
 *
 * A reconciliation alert says the ledger and the bank disagree, and §3.3 calls
 * that "the feature that makes the dashboard trustworthy rather than
 * decorative". So closing one is a claim — *I know why these two figures
 * differ* — and it is recorded as such rather than dismissed.
 *
 * Two consequences follow, and the UI states both:
 *
 *   - **A note is required.** An alert closed with no reason is
 *     indistinguishable six weeks later from one closed by a mis-tap, and the
 *     thing it was hiding is a missed message.
 *   - **Closing does not fix the drift.** `reconcile()` in `api/db.py` raises a
 *     fresh alert on the next tick if the balances still disagree, because they
 *     still do. The way to *end* a drift is to correct the balance, which books
 *     an adjustment (`db/account-edit.ts`) and closes the alert as a side
 *     effect of the ledger now adding up.
 *
 * Takes the db as an argument and imports nothing from `next/*`, so
 * `npm run test:account-detail` runs this function rather than a copy of it.
 */

import { and, eq, isNull } from "drizzle-orm";

import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- the handle is
 * structural for the same reason as in `db/account-edit.ts`: the app runs on
 * postgres-js and the test on PGlite, and naming either driver's type would
 * mean the tested path and the shipped path are not the same function. */
type Db = { update: (table: any) => any };

export type ResolveResult =
  | { ok: true; resolved: number }
  | { ok: false; error: string };

export async function resolveDrift(
  db: Db,
  input: { alertId: string; note: string; at?: Date },
): Promise<ResolveResult> {
  const note = input.note.trim();
  if (!note) {
    return {
      ok: false,
      error:
        "Say what explains the difference. An alert closed without a reason is indistinguishable from one closed by accident, and the difference it was reporting is usually a message that never arrived.",
    };
  }

  const at = input.at ?? new Date();

  const updated = (await db
    .update(schema.reconciliationAlerts)
    .set({ resolvedAt: at, resolutionNote: note })
    .where(
      and(
        eq(schema.reconciliationAlerts.id, input.alertId),
        // Only an open one. Re-closing a closed alert would overwrite the note
        // that explained it the first time.
        isNull(schema.reconciliationAlerts.resolvedAt),
      ),
    )
    .returning({ id: schema.reconciliationAlerts.id })) as { id: string }[];

  if (updated.length === 0) {
    return { ok: false, error: "That alert is already closed, or no longer exists." };
  }

  return { ok: true, resolved: updated.length };
}

/**
 * Whether the drift an alert describes is still true.
 *
 * Computed rather than queried — the detail page already holds both figures,
 * and this is the difference between a resolve button that claims to fix
 * something and one that says plainly that the next reconciliation pass will
 * raise the same alert again. 0.01 is `reconcile()`'s own tolerance.
 */
export function driftPersists(currentBalance: number, reportedBalance: number): boolean {
  return Math.abs(currentBalance - reportedBalance) > 0.01;
}
