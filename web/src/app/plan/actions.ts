"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db";
import { closeCycle, resetCarry, setBudget, setRollover } from "@/db/budgets";
import { deleteGoal, type GoalInput, saveGoal } from "@/db/goals";
import { type SeriesAction, actOnSeries } from "@/db/recurring";
import type { CivilDate } from "@/lib/periods";
import { today } from "@/lib/periods";

/**
 * Thin on purpose, exactly like `ledger/actions.ts` and `accounts/actions.ts`.
 *
 * Arguments in, `db/budgets.ts`, `db/goals.ts` and `db/recurring.ts` out. A
 * server action cannot be called from a test file without a Next runtime around
 * it, so anything that lives here is effectively unverified — and the rules
 * these calls enforce (a settled carry is never recomputed; the sum of goal
 * buckets never exceeds the balance) are exactly the ones that must not be. The
 * only logic here is cache invalidation, which genuinely belongs to the
 * framework.
 *
 * Everything revalidates `/` as well as `/plan`: Home carries the same pacing
 * rows and the same category budgets, and a dashboard that disagrees with the
 * screen the budget was set on is the failure §5.1 spends a page warning about.
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

function refresh(): void {
  revalidatePath("/plan");
  revalidatePath("/");
}

/** Anything thrown by the driver becomes a message the panel can render. An
 *  unhandled rejection in an action is a blank screen with a digest id in it. */
async function guard<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* --------------------------------------------------------------- budgets */

export async function saveBudget(
  categoryId: string,
  cycleStart: CivilDate,
  amount: string | null,
) {
  return guard(async () => {
    const result = await setBudget(getDb(), { categoryId, cycleStart, amount });
    if (result.ok) refresh();
    return result;
  });
}

export async function toggleRollover(
  categoryId: string,
  cycleStart: CivilDate,
  rollover: boolean,
) {
  return guard(async () => {
    const result = await setRollover(getDb(), { categoryId, cycleStart, rollover });
    if (result.ok) refresh();
    return result;
  });
}

/** §11.2's escape hatch, for a carry that has drifted so far negative it stops
 *  being informative. Zeroes it and marks it settled, so the next close does not
 *  put the drift back. */
export async function clearCarry(categoryId: string, cycleStart: CivilDate) {
  return guard(async () => {
    const result = await resetCarry(getDb(), { categoryId, cycleStart });
    if (result.ok) refresh();
    return result;
  });
}

/**
 * Close a cycle by hand.
 *
 * The nightly tick does this (`api/plan-tick`), and this exists for the case the
 * tick could not: a project that was paused, a boundary crossed while nothing
 * was running. `now` comes from the server rather than the client, so a phone
 * with a wrong clock cannot close a cycle that has not ended.
 */
export async function foldCycleForward(cycle: CivilDate) {
  return guard(async () => {
    const result = await closeCycle(getDb(), { cycle, now: today() });
    if (result.ok) refresh();
    return result;
  });
}

/* ----------------------------------------------------------------- goals */

export async function storeGoal(input: GoalInput) {
  return guard(async () => {
    const result = await saveGoal(getDb(), input);
    if (result.ok) refresh();
    return result;
  });
}

export async function removeGoal(id: string) {
  return guard(async () => {
    const result = await deleteGoal(getDb(), { id });
    if (result.ok) refresh();
    return result;
  });
}

/* ------------------------------------------------------------- recurring */

export async function updateSeries(id: string, action: SeriesAction) {
  return guard(async () => {
    const result = await actOnSeries(getDb(), { id, action });
    if (result.ok) refresh();
    return result;
  });
}
