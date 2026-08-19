/**
 * Export and backup — SPEC §11.6.
 *
 * "Export is a v1 feature, not a nicety. One click to CSV and JSON for
 * transactions, and a full dump of `raw_messages` — the raw store is the
 * irreplaceable asset, since everything else can be re-derived from it (§3.1).
 * You're on a free tier that pauses on inactivity and offers no restore
 * guarantees; treat your own export as the backup."
 *
 * Two groups, and the order between them is the point. The raw dump is first
 * because it is the one that cannot be regenerated: transactions are derived,
 * and a better parser can rebuild every one of them from the messages. Lose the
 * messages and no parser can rebuild anything. So the raw dump is the row that
 * carries the backup date, the reminder, and the warning — and the ledger export
 * below it is labelled as what it is, a document rather than a backup.
 *
 * Plain `<a download>` links, not buttons. A download started by script from a
 * blob fails differently in every browser and this has to work from a phone; a
 * link is also the only form of this control that survives the reader
 * long-pressing it to save somewhere specific, which is exactly what taking a
 * backup means.
 *
 * Rendered unconditionally, including when the queue is empty. The Review tab
 * hides itself when nothing is parked (see `components/tab-bar.tsx`), so this
 * page is reached by URL or from Settings on precisely the days when everything
 * is working — which are the days you should be taking a backup.
 */

import { type BackupState, EXPORT_INTERVAL_DAYS, backupState } from "@/lib/backup";
import { dayMonthYear } from "@/lib/format";

const RAW = "/api/raw-messages/export";
// `all=1` is `PARAM.allTime` — an export explicitly unscoped by date. Without
// it the route would honour the period stepper's default and hand back one
// cycle, which is a document about a month, not a copy of the ledger.
const LEDGER = "/api/ledger/export?all=1";

function Download({
  href,
  label,
  note,
  emphasis = false,
}: {
  href: string;
  label: string;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <a
      href={href}
      download
      className={`flex items-baseline justify-between gap-4 rounded-lg px-3 py-2.5 hover:bg-black/5 dark:hover:bg-white/10 ${
        emphasis ? "border border-black/15 dark:border-white/20" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="mt-0.5 block text-xs opacity-55">{note}</span>
      </span>
      <span className="shrink-0 text-xs opacity-40">↓</span>
    </a>
  );
}

function BackupLine({ state }: { state: BackupState }) {
  if (state.never || !state.lastExportAt) {
    return (
      <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
        The raw messages have never been exported. Everything in this app lives in one free-tier
        database that pauses after seven days idle and offers no restore guarantee — until you
        have a copy of the file below, there is no second place any of it exists.
      </p>
    );
  }

  return (
    <p className={`mt-2 text-xs ${state.due ? "text-amber-600 dark:text-amber-400" : "opacity-55"}`}>
      Last backed up {dayMonthYear(state.lastExportAt)}
      {state.days !== null && <> — {state.days} days ago</>}.
      {state.due
        ? ` Past the ${EXPORT_INTERVAL_DAYS}-day mark; a reminder is raised as an alert until you take a fresh one.`
        : ` The reminder fires again at ${EXPORT_INTERVAL_DAYS} days.`}
    </p>
  );
}

export function ExportPanel({ lastExportAt, now }: { lastExportAt: Date | null; now: Date }) {
  const state = backupState(lastExportAt, now);

  return (
    <section className="mt-10" aria-labelledby="export-heading">
      <h2 id="export-heading" className="text-sm font-semibold tracking-wide uppercase opacity-70">
        Export &amp; backup
      </h2>

      <div className="mt-3 rounded-xl border border-black/10 p-3.5 dark:border-white/15">
        <p className="text-sm font-medium">The raw messages</p>
        <p className="mt-1 text-xs opacity-55">
          Every SMS exactly as it arrived, with its parse status. This is the irreplaceable one:
          transactions are derived and can be rebuilt from these by a better parser than the one
          running today, which is the whole reason they are stored forever (§3.1). Downloading it
          is what clears the monthly reminder.
        </p>

        <BackupLine state={state} />

        <div className="mt-2 space-y-1">
          <Download
            href={`${RAW}?format=json`}
            label="raw_messages — JSON"
            note="Every column, nesting preserved. The one to keep if you keep only one."
            emphasis
          />
          <Download
            href={`${RAW}?format=csv`}
            label="raw_messages — CSV"
            note="Same rows, flattened. Opens in Excel with Arabic intact."
          />
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-black/10 p-3.5 dark:border-white/15">
        <p className="text-sm font-medium">The ledger</p>
        <p className="mt-1 text-xs opacity-55">
          Every transaction, all time, with its splits, category, account and the message it came
          from. A document rather than a backup — it holds what today&rsquo;s parser made of the
          messages — but it is the file to hand to a spreadsheet, and it does not clear the
          reminder above. For a filtered export, use the export control on the Ledger, which
          matches whatever that screen is showing.
        </p>

        <div className="mt-2 space-y-1">
          <Download
            href={`${LEDGER}&format=csv`}
            label="transactions — CSV"
            note="One row per split leg, so category totals add up."
          />
          <Download
            href={`${LEDGER}&format=json`}
            label="transactions — JSON"
            note="Same rows, same order."
          />
        </div>
      </div>
    </section>
  );
}
