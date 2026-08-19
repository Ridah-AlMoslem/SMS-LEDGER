/**
 * The monthly export reminder, as a row in `alerts` (SPEC §11.6).
 *
 * §11.6 keeps alerts in-app only in v1 — "a badge and a dashboard banner, no
 * email or push" — but insists each one is a row, "so adding a delivery channel
 * later is a rendering change rather than a rewrite". This is the only writer of
 * that row for the backup reminder, and it runs from the nightly pass rather
 * than being computed when the page renders, for one reason: a reminder that
 * only exists while you are looking at the Review screen is a reminder that
 * reaches you exactly when you least need it. As a row it reaches Home's banner
 * too, and it is what a future channel would deliver.
 *
 * Takes the db as an argument and imports nothing from `next/*`, so the test
 * runs this function rather than a copy of it (web/CLAUDE.md).
 */

import { and, eq, isNull } from "drizzle-orm";

// Relative, like every other `db/` module a verification script runs directly:
// those scripts have no `@/` alias, and a module they cannot import is a module
// whose tested path and shipped path are two different things.
import { backupState } from "../lib/backup.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- structural for the same
 * reason as `db/account-edit.ts`: the app runs on postgres-js and the test on
 * PGlite, and naming either driver's type would mean the tested path and the
 * shipped path are not the same function. */
type Db = {
  select: (fields?: any) => any;
  insert: (table: any) => any;
  update: (table: any) => any;
};

export const EXPORT_REMINDER = "export_reminder";

export type ReminderResult = {
  /** Whether a backup is currently owed. */
  due: boolean;
  /** A new alert row was written. */
  raised: boolean;
  /** An open reminder was dismissed because a backup has since been taken. */
  cleared: boolean;
  days: number | null;
};

/**
 * Raise the reminder when a backup is owed, clear it when one has been taken.
 *
 * Both halves matter. Raising without clearing leaves a stale alert sitting on
 * Home after you have already exported, which teaches you that the alerts on
 * this dashboard are not worth reading — and that lesson generalises to the
 * reconciliation drift alerts, which are the ones that mean something.
 *
 * Only ever one open reminder at a time: the alert says "you have not backed
 * up", and thirty of those say the same thing thirty times. `dismissed_at` on
 * the old one is what a person acknowledging it writes, and this deliberately
 * does not re-raise on the next night — a dismissal is a decision, and the next
 * genuine prompt comes after the next export.
 */
export async function raiseExportReminder(
  db: Db,
  input: { now?: Date } = {},
): Promise<ReminderResult> {
  const now = input.now ?? new Date();

  const [row] = (await db
    .select({ lastExportAt: schema.settings.lastExportAt })
    .from(schema.settings)
    .limit(1)) as { lastExportAt: Date | null }[];

  const state = backupState(row?.lastExportAt ?? null, now);

  const open = (await db
    .select({ id: schema.alerts.id, createdAt: schema.alerts.createdAt })
    .from(schema.alerts)
    .where(
      and(eq(schema.alerts.type, EXPORT_REMINDER), isNull(schema.alerts.dismissedAt)),
    )
    .limit(1)) as { id: string; createdAt: Date }[];

  if (!state.due) {
    // Backed up since. Close the reminder rather than leaving it to be
    // dismissed by hand — it is answered, and an answered alert still on
    // screen is how a banner stops being read.
    if (open.length > 0) {
      await db
        .update(schema.alerts)
        .set({ dismissedAt: now })
        .where(eq(schema.alerts.id, open[0].id));
      return { due: false, raised: false, cleared: true, days: state.days };
    }
    return { due: false, raised: false, cleared: false, days: state.days };
  }

  if (open.length > 0) return { due: true, raised: false, cleared: false, days: state.days };

  await db.insert(schema.alerts).values({
    type: EXPORT_REMINDER,
    // Info, not warning. Nothing is broken and no money is wrong; this is
    // housekeeping, and spending a warning on it devalues the ones that are
    // telling you the ledger disagrees with your bank.
    severity: "info",
    payload: {
      days: state.days,
      never: state.never,
      lastExportAt: state.lastExportAt?.toISOString() ?? null,
    },
    createdAt: now,
  });

  return { due: true, raised: true, cleared: false, days: state.days };
}

/**
 * Record that the raw store was dumped, and close the reminder that asked for
 * it.
 *
 * Called by the export route as it serves the file. Serving it is the moment
 * the backup exists — there is no later confirmation to wait for, and asking
 * for one would mean a button that claims the backup happened and a checkbox
 * that decides whether it counted.
 *
 * The reminder is closed **here** rather than being left for the nightly pass,
 * which would also close it. The difference is up to twenty-four hours during
 * which a banner on Home says you have never backed up, immediately after you
 * did — and an alert that is visibly wrong about something the reader just did
 * is how the whole banner stops being read, including the drift alerts that
 * mean something.
 */
export async function stampExport(db: Db, at: Date = new Date()): Promise<void> {
  await db
    .update(schema.settings)
    .set({ lastExportAt: at })
    .where(eq(schema.settings.id, 1));

  await db
    .update(schema.alerts)
    .set({ dismissedAt: at })
    .where(
      and(eq(schema.alerts.type, EXPORT_REMINDER), isNull(schema.alerts.dismissedAt)),
    );
}
