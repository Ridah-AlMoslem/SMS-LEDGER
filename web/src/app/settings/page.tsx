import { inArray, sql } from "drizzle-orm";
import Link from "next/link";

import { getDb, schema } from "@/db";
import { loadSettings } from "@/db/settings";
import { periodBounds, periodLabel, today } from "@/lib/periods";

export const dynamic = "force-dynamic";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {note && <p className="mt-0.5 text-xs opacity-55">{note}</p>}
      </div>
      <p className="tabular shrink-0 text-sm opacity-80">{value}</p>
    </div>
  );
}

export default async function SettingsPage() {
  const settings = await loadSettings();

  let parked = 0;
  try {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.rawMessages)
      .where(inArray(schema.rawMessages.status, ["needs_review", "failed"]));
    parked = row?.count ?? 0;
  } catch {
    /* the anchors below are still worth showing */
  }

  const now = today(new Date(), settings);
  const cycle = periodBounds("cycle", now, settings);

  return (
    <main>
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="mt-5">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Period anchors</h2>
        <p className="mt-1 text-xs opacity-55">
          Read from the single <code>settings</code> row. Every bucket in the app derives from
          these three values; nothing inlines them.
        </p>

        <div className="mt-2 divide-y divide-black/8 dark:divide-white/10">
          <Row
            label="Cycle anchor day"
            value={settings.cycleAnchorDay}
            note="The salary cycle opens on this day. Every month has a 25th, unlike a 29th or 31st."
          />
          <Row
            label="Week starts"
            value={DOW[settings.weekStartDow] ?? settings.weekStartDow}
            note="Matches the Sun–Thu work week, so Fri–Sat spend lands in one bucket."
          />
          <Row
            label="Time zone"
            value={settings.timezone}
            note="Boundaries are evaluated here, not in UTC — a 01:00 purchase on the 25th belongs to the new cycle."
          />
          <Row label="Current cycle" value={periodLabel("cycle", now, settings)} />
          <Row
            label="Cycle length"
            value={`${
              Math.round(
                (Date.parse(cycle.end) - Date.parse(cycle.start)) / 86_400_000,
              ) + 1
            } days`}
            note="28 to 31. Pacing uses the actual length, never a hardcoded 30."
          />
        </div>

        <p className="mt-3 text-xs opacity-50">
          Changing an anchor is a migration, not a toggle: the SQL period functions hardcode these
          values because an index expression must be immutable, and altering them redefines every
          historical aggregate.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Data</h2>

        {/* The Review tab is conditional; this route is not. When the queue is
            empty the tab disappears and this stays the way in. */}
        <div className="mt-2 divide-y divide-black/8 dark:divide-white/10">
          <Link href="/review" className="flex items-baseline justify-between gap-4 py-3">
            <div>
              <p className="text-sm">Review queue &amp; health</p>
              <p className="mt-0.5 text-xs opacity-55">
                Parked messages, parse rate, last message received.
              </p>
            </div>
            <span className="shrink-0 text-sm">
              {parked > 0 ? (
                <span className="tabular text-amber-600 dark:text-amber-400">{parked}</span>
              ) : (
                <span className="opacity-40">empty</span>
              )}
              <span className="ml-2 opacity-40">›</span>
            </span>
          </Link>
        </div>
      </section>
    </main>
  );
}
