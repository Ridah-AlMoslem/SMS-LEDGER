/**
 * Review — SPEC §10.6, §10.7, §11.6.
 *
 * Two screens in one, and the order down the page is the argument for putting
 * them together:
 *
 *   1. **Is the pipeline alive?** The health panel, the alerts, the
 *      reconciliation. Everything that says whether the numbers on every other
 *      screen can be believed.
 *   2. **What does it need from me?** The parked queue, grouped by shape, where
 *      hand-processing one message resolves the other forty (§10.7).
 *   3. **Do I have a copy?** Export, because the answer to (1) is eventually
 *      "no" and the raw store is the only thing that cannot be rebuilt (§3.1).
 *
 * **This page is never empty.** The Review tab hides itself when nothing is
 * parked (`components/tab-bar.tsx`), so the route is reached by URL or from
 * Settings on exactly the days when the queue is clear — and the health panel,
 * the invariant check and the backup are the reasons to come here on those
 * days. A route whose only content was the queue would render a blank screen
 * for anyone who followed a permanent link to it.
 *
 * One `loadReview` for everything after settings — never a `Promise.all`. A
 * fan-out of independent statements onto Supabase's transaction pooler stalls
 * permanently rather than failing (`db/index.ts`), and this is the screen a
 * person leaves open and refreshes.
 */

import Link from "next/link";

import { loadReview } from "@/db/review";
import { loadSettings } from "@/db/settings";
import { rankAlerts, reviewQueueAlert } from "@/lib/alerts";
import { reason } from "@/lib/errors";
import { fromLocalInput, timeOfDay } from "@/lib/format";
import { masterInvariant } from "@/lib/invariant";
import { periodBounds, periodLabel, today } from "@/lib/periods";
import type { PeriodSettings } from "@/lib/settings";
import { type ShapeGroup, groupByShape, llmStatus } from "@/lib/review";

import { AlertList } from "./alert-list";
import { DriftList } from "./drift-list";
import { ExportPanel } from "./export-panel";
import { HealthPanel } from "./health-panel";
import { dismissGroup, restoreGroup, retryGroup } from "./actions";
import { DeriveForm } from "./derive-form";

export const dynamic = "force-dynamic";

/**
 * The calendar month the LLM quota is measured in, as an instant.
 *
 * A calendar month, not the salary cycle — §2's cap is a billing figure and
 * Google resets it on the 1st. Built through `fromLocalInput` so the boundary
 * lands in the configured zone rather than UTC; §5.5 forbids naming that zone
 * anywhere outside `settings`, which is also why this is not a
 * `date_trunc('month', now())` in the query.
 */
function monthWindow(now: Date, settings: PeriodSettings) {
  const day = today(now, settings); // YYYY-MM-DD in the configured zone
  const [year, month] = day.split("-").map(Number);

  const start = fromLocalInput(`${day.slice(0, 7)}-01T00:00`, settings) ?? new Date(0);
  // Day 0 of the next month is the last day of this one — the JS idiom, and it
  // is right for February in both leap and non-leap years.
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return { start, days };
}

function GroupCard({
  group,
  accounts,
  dismissed,
}: {
  group: ShapeGroup;
  accounts: { slug: string; name: string }[];
  dismissed?: boolean;
}) {
  const retry = retryGroup.bind(null, group.ids);
  const dismiss = dismissGroup.bind(null, group.ids);
  const restore = restoreGroup.bind(null, group.ids);

  return (
    <section className="rounded-xl border border-black/10 dark:border-white/15">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/10 px-4 py-2.5 dark:border-white/10">
        <div className="min-w-0">
          <p className="font-medium">
            {group.sender}
            {group.count > 1 && (
              <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-xs font-normal dark:bg-white/10">
                {group.count} messages
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs opacity-60">{group.reason}</p>
        </div>
        <p className="text-xs opacity-50">
          {group.count > 1
            ? `${timeOfDay(group.oldest)} – ${timeOfDay(group.newest)}`
            : timeOfDay(group.newest)}
        </p>
      </header>

      <div className="px-4 py-3">
        {/* Raw body verbatim. .sms-body isolates the bidi run so a right-to-left
            message cannot reorder the UI around it, and pre-wrap keeps the
            line structure the templates are written against. */}
        <pre className="sms-body overflow-x-auto rounded-lg bg-black/[0.03] p-3 text-xs leading-relaxed dark:bg-white/[0.06]">
          {group.sample.body}
        </pre>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {dismissed ? (
            <form action={restore}>
              <button
                type="submit"
                className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
              >
                Put back in the queue
              </button>
            </form>
          ) : (
            <>
              <form action={retry}>
                <button
                  type="submit"
                  className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Retry {group.count > 1 ? `all ${group.count}` : ""}
                </button>
              </form>
              <DeriveForm messageId={group.sample.id} accounts={accounts} />
              <form action={dismiss}>
                <button
                  type="submit"
                  className="rounded-lg px-3 py-1.5 text-sm opacity-70 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  Not a transaction
                </button>
              </form>
            </>
          )}

          {group.shapeHash && (
            <code className="ml-auto text-[11px] opacity-40">{group.shapeHash}</code>
          )}
        </div>
      </div>
    </section>
  );
}

export default async function ReviewPage() {
  const now = new Date();
  const settings = await loadSettings();
  const cycle = periodBounds("cycle", today(now, settings), settings).start;
  const month = monthWindow(now, settings);

  let data: Awaited<ReturnType<typeof loadReview>>;
  try {
    data = await loadReview({ cycle, monthStart: month.start });
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="mt-4 text-sm opacity-70">{reason(err)}</p>
      </main>
    );
  }

  const groups = groupByShape(data.parked);
  const dismissedGroups = groupByShape(data.dismissed);

  // Every account, not just the active ones — see `accountsQuery` in
  // `db/review.ts`. Both sides of the invariant must see one universe of rows,
  // or a filter reads as a classification error.
  const invariant = masterInvariant({
    accounts: data.accounts,
    movements: data.movements,
    income: data.income,
    expense: data.expense,
  });

  const parked = data.health.needsReview + data.health.failed;
  const alerts = rankAlerts(data.alerts, reviewQueueAlert(parked));

  const accountsForForm = data.accounts
    .filter((a) => a.isActive)
    .map((a) => ({ slug: a.slug, name: a.name }));

  return (
    <main>
      <h1 className="text-xl font-semibold">Review</h1>

      <HealthPanel
        health={data.health}
        accounts={data.accounts.filter((a) => a.isActive)}
        invariant={invariant}
        llm={llmStatus(data.health.llmThisMonth, month.days)}
        cycleLabel={periodLabel("cycle", cycle, settings)}
        now={now}
      />

      <AlertList alerts={alerts} />

      <DriftList rows={data.drift} />

      <section className="mt-10" aria-labelledby="queue-heading">
        <h2
          id="queue-heading"
          className="text-sm font-semibold tracking-wide uppercase opacity-70"
        >
          Messages the parser couldn&rsquo;t read
        </h2>
        <p className="mt-1 text-xs opacity-50">
          Grouped by format, because failures arrive in format-shaped clusters — hand-process one
          and the rest resolve themselves (§10.7).
        </p>

        <div className="mt-3 space-y-4">
          {groups.length === 0 ? (
            <div className="rounded-xl border border-black/10 p-8 text-center dark:border-white/15">
              <p className="font-medium">Nothing waiting</p>
              <p className="mt-2 text-sm opacity-70">
                Every message either parsed or was correctly ignored. The Review tab is hidden
                while this is true —{" "}
                <Link href="/settings" className="underline underline-offset-2">
                  Settings
                </Link>{" "}
                is the permanent way back to this page.
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <GroupCard key={g.key} group={g} accounts={accountsForForm} />
            ))
          )}
        </div>

        {dismissedGroups.length > 0 && (
          <section className="mt-6">
            <h3 className="text-sm font-semibold tracking-wide uppercase opacity-70">
              Dismissed by you
            </h3>
            <p className="mt-1 text-xs opacity-50">
              Kept, never deleted — raw messages are append-only, so a mistake here is always
              recoverable.
            </p>
            <div className="mt-3 space-y-4">
              {dismissedGroups.map((g) => (
                <GroupCard key={g.key} group={g} accounts={accountsForForm} dismissed />
              ))}
            </div>
          </section>
        )}

        <p className="mt-4 text-xs opacity-50">
          &ldquo;Teach the parser&rdquo; turns one message into a template and reparses every
          message sharing its format. Note that a format with different merchant names produces
          different groups — free text is not generalised in the shape hash.
        </p>
      </section>

      <ExportPanel lastExportAt={data.lastExportAt} now={now} />
    </main>
  );
}
