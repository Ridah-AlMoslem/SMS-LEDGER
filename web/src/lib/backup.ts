/**
 * When the raw store was last exported, and whether that is long enough ago to
 * say something about it (SPEC §11.6).
 *
 * "The raw store is the irreplaceable asset, since everything else can be
 * re-derived from it (§3.1). You're on a free tier that pauses on inactivity
 * and offers no restore guarantees; treat your own export as the backup. A
 * scheduled monthly export reminder is worth the two lines it costs."
 *
 * **Only the raw dump clears the reminder.** A filtered ledger export is a
 * document, not a backup: it holds what a screen was showing, in a shape
 * derived by a parser that will change. `raw_messages` is the only file from
 * which the whole ledger can be rebuilt, so it is the only one that answers
 * "am I backed up".
 *
 * Pure, so the nightly pass and the panel agree about the answer without
 * either of them being the definition.
 */

export const EXPORT_INTERVAL_DAYS = 30;

export type BackupState = {
  lastExportAt: Date | null;
  /** Whole days since the last dump. null when there has never been one. */
  days: number | null;
  due: boolean;
  /** True when nothing has ever been exported — a different, worse state. */
  never: boolean;
  title: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function backupState(lastExportAt: Date | null, now = new Date()): BackupState {
  if (!lastExportAt) {
    return {
      lastExportAt: null,
      days: null,
      due: true,
      never: true,
      title:
        "The raw messages have never been exported — nothing outside this database can rebuild the ledger",
    };
  }

  const days = Math.floor((now.getTime() - lastExportAt.getTime()) / DAY_MS);

  return {
    lastExportAt,
    days,
    due: days >= EXPORT_INTERVAL_DAYS,
    never: false,
    title: `The raw messages were last exported ${days} day${days === 1 ? "" : "s"} ago — take a fresh backup`,
  };
}
