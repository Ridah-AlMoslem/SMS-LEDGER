"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getDb, schema } from "@/db";

/**
 * Dismiss an alert (SPEC §11.6).
 *
 * Writes `dismissed_at` rather than deleting the row. An alert is a record that
 * a condition was detected and when — the reconciliation drift that fired last
 * Tuesday is evidence even after you have acknowledged it — and a table whose
 * rows disappear on acknowledgement cannot answer "how often does this happen",
 * which is the question that decides whether the rule that raised it is any
 * good.
 *
 * Guarded on `dismissed_at IS NULL` so a double tap, or two tabs open on the
 * same banner, does not overwrite the moment it was first dismissed.
 */
export async function dismissAlert(id: string): Promise<void> {
  if (!id || id.startsWith("derived:")) return;

  await getDb()
    .update(schema.alerts)
    .set({ dismissedAt: sql`now()` })
    .where(and(eq(schema.alerts.id, id), isNull(schema.alerts.dismissedAt)));

  revalidatePath("/");
  revalidatePath("/review");
}
