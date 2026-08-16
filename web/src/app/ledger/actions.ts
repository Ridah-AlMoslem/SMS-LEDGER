"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db";
import {
  type BulkPatch,
  type ManualInput,
  type SplitInput,
  type TransactionPatch,
  bulkEdit,
  convertToManual,
  createManual,
  deleteTransaction,
  editTransaction,
  saveSplits,
  setCycleOverride,
  unlockField,
} from "@/db/ledger-mutations";
import { type RulePreview, applyRule, createRule, previewRule } from "@/db/rules";
import { type Condition, type RuleActions, type RuleDraft, validateDraft } from "@/lib/rules";
import { addMonths, periodStart } from "@/lib/periods";

/**
 * Thin on purpose, exactly like `accounts/actions.ts`.
 *
 * Arguments in, `db/ledger-mutations.ts` out. A server action cannot be called
 * from a test file without a Next runtime around it, so anything that lives
 * here is effectively unverified — and the rules these calls enforce (§9.4) are
 * the ones that must not be. The only logic here is the cache invalidation,
 * which is the one thing that genuinely belongs to the framework.
 *
 * Every mutation revalidates `/` as well as `/ledger`: an edited amount, a new
 * manual entry or a deleted transaction all move the totals on Home, and a
 * dashboard that disagrees with the ledger it is drawn from is the failure §5.1
 * spends a page warning about.
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

function refresh(): void {
  revalidatePath("/ledger");
  revalidatePath("/");
  revalidatePath("/plan");
}

/** Anything thrown by the driver becomes a message the sheet can render. An
 *  unhandled rejection in an action is a blank screen with a digest id in it. */
async function guard<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function saveTransaction(id: string, patch: TransactionPatch) {
  return guard(async () => {
    const result = await editTransaction(getDb(), { id, patch });
    if (result.ok) refresh();
    return result;
  });
}

export async function unlockTransactionField(id: string, column: string) {
  return guard(async () => {
    const result = await unlockField(getDb(), { id, column });
    if (result.ok) refresh();
    return result;
  });
}

export async function saveTransactionSplits(id: string, splits: SplitInput[]) {
  return guard(async () => {
    const result = await saveSplits(getDb(), { transactionId: id, splits });
    if (result.ok) refresh();
    return result;
  });
}

/**
 * Reassign to a neighbouring cycle (§5.6).
 *
 * The neighbours are computed here from the transaction's own posting date
 * rather than taken from the client, so a hand-made request cannot file a
 * transaction under a cycle six months away. `period_start` is the same
 * function every bucket in the app is derived from.
 */
export async function moveCycle(id: string, postedDay: string, cycleStart: string | null) {
  return guard(async () => {
    const here = periodStart(postedDay);
    const neighbours = [addMonths(here, -1), addMonths(here, 1)];

    const result = await setCycleOverride(getDb(), { id, cycleStart, neighbours });
    if (result.ok) refresh();
    return result;
  });
}

export async function removeTransaction(id: string) {
  return guard(async () => {
    const result = await deleteTransaction(getDb(), { id });
    if (result.ok) {
      refresh();
      // The message it came from is now `ignored`, which changes the review
      // queue's badge in the layout.
      revalidatePath("/review");
    }
    return result;
  });
}

export async function bulkApply(ids: string[], patch: BulkPatch) {
  return guard(async () => {
    const result = await bulkEdit(getDb(), { ids, patch });
    if (result.ok) refresh();
    return result;
  });
}

export async function addManual(input: ManualInput) {
  return guard(async () => {
    const result = await createManual(getDb(), input);
    if (result.ok) {
      refresh();
      // A manual entry moves a balance the moment it is written (§3.3).
      revalidatePath("/accounts");
    }
    return result;
  });
}

export async function toManual(id: string) {
  return guard(async () => {
    const result = await convertToManual(getDb(), { id });
    if (result.ok) refresh();
    return result;
  });
}

/* ----------------------------------------------------------------- rules */

export type SavedRule = { ruleId: string; preview: RulePreview };

/**
 * Write the rule, then dry-run it (§11.1).
 *
 * In that order, deliberately. The rule exists from this moment on and will
 * categorize everything that arrives from now on; what the preview is asking
 * about is the separate, much larger question of what to do with the history
 * that already exists. Applying is `runRule`, behind its own confirm — §11.1:
 * "apply to N matching historical transactions", never silently.
 */
export async function saveRule(draft: RuleDraft): Promise<ActionResult<SavedRule>> {
  return guard(async () => {
    const invalid = validateDraft(draft);
    if (invalid) return { ok: false, error: invalid };

    const db = getDb();
    const created = await createRule(db, draft);
    if (!created.ok) return created;

    const preview = await previewRule(db, { match: draft.match, actions: draft.actions });
    if (!preview.ok) return preview;

    refresh();
    return { ok: true, value: { ruleId: created.value.id, preview: preview.value } };
  });
}

/** The dry run on its own, for a rule that already exists. */
export async function previewConditions(match: Condition[], actions: RuleActions) {
  return guard(async () => previewRule(getDb(), { match, actions }));
}

export async function runRule(ruleId: string) {
  return guard(async () => {
    const result = await applyRule(getDb(), { ruleId });
    if (result.ok) refresh();
    return result;
  });
}
