"use server";

import { inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getDb, schema } from "@/db";

/**
 * Requeue a whole shape group (SPEC §10.7).
 *
 * The point of grouping: after adding a template for a format, one action
 * reprocesses every message that was parked waiting for it. Bank messages
 * repeat by nature, so a format you fix once should never cost you twice.
 *
 * `attempts` resets to zero because the previous failures were the system's
 * fault, not the message's — otherwise three old failures would park a
 * perfectly parseable message on its first retry.
 */
export async function retryGroup(ids: string[]) {
  if (ids.length === 0) return;

  const db = getDb();
  await db
    .update(schema.rawMessages)
    .set({ status: "pending", attempts: 0, lastError: null, processedAt: null })
    .where(inArray(schema.rawMessages.id, ids));

  revalidatePath("/review");
  revalidatePath("/");
}

/**
 * Mark a group as legitimately not-a-transaction.
 *
 * Sets status rather than deleting: raw_messages is append-only (§3.1), and a
 * message dismissed by mistake has to remain recoverable. `ignored_reason =
 * 'user'` distinguishes a human decision from an automatic OTP filter, so a
 * later classifier change can revisit these without second-guessing you.
 */
export async function dismissGroup(ids: string[]) {
  if (ids.length === 0) return;

  const db = getDb();
  await db
    .update(schema.rawMessages)
    .set({ status: "ignored", ignoredReason: "user", lastError: null })
    .where(inArray(schema.rawMessages.id, ids));

  revalidatePath("/review");
  revalidatePath("/");
}

/** Undo a dismissal — back into the queue for another look. */
export async function restoreGroup(ids: string[]) {
  if (ids.length === 0) return;

  const db = getDb();
  await db
    .update(schema.rawMessages)
    .set({ status: "pending", ignoredReason: null, attempts: 0, lastError: null })
    .where(inArray(schema.rawMessages.id, ids));

  revalidatePath("/review");
  revalidatePath("/");
}
