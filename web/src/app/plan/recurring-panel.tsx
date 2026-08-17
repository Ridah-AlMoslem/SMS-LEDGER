"use client";

/**
 * Recurring charges and the bills calendar — SPEC §11.3.
 *
 * Four sections, in the order that matters:
 *
 *   1. **Price changes.** §11.3 — "silent annual price bumps are the main thing
 *      this catches" — so they lead, and they are the only thing on this screen
 *      worth an alert-shaped box. Never shown for a profit series: its amount
 *      varies every cycle, and a drift warning there fires monthly and means
 *      nothing.
 *   2. **Upcoming bills, grouped by week.** With the days away, because "in 3
 *      days" is the part you act on and "28 Aug" is the part you look up.
 *      Overdue charges sit above the weeks rather than being folded into one:
 *      an expected date that has passed is a fact, and moving it forward to keep
 *      the list tidy would hide the only thing worth noticing.
 *   3. **Dormant prompts.** "No charge from X in 3 months — cancelled?"
 *   4. **Everything detected**, with its confidence and its actions, and the
 *      silenced ones behind a disclosure so a dismissal stays reversible.
 *
 * A profit series prints "amount varies" rather than an average. §11.3 detects
 * it on cadence only, and an average dressed up as a prediction is exactly the
 * kind of confident wrong number that discredits a calendar.
 */

import { useOptimistic, useState, useTransition } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import type { SeriesRow } from "@/db/plan";
import type { SeriesAction } from "@/db/recurring";
import {
  CONFIDENCE_FLOOR,
  daysAway,
  expectedAmount,
  isDormant,
  isRecentPriceChange,
} from "@/lib/recurring";
import { type CivilDate, civilShort, periodLabel, weekStart } from "@/lib/periods";

import { updateSeries } from "./actions";

const CADENCE_LABELS: Record<SeriesRow["cadence"], string> = {
  weekly: "every week",
  biweekly: "every 2 weeks",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

const KIND_LABELS: Record<SeriesRow["kind"], string> = {
  subscription: "Subscription",
  bill: "Bill",
  salary: "Salary",
  profit: "Profit",
};

/** How far ahead the bills calendar looks. Six weeks covers "the rest of this
 *  cycle and the next", which is the horizon a monthly budget is planned over. */
const HORIZON_DAYS = 42;

export function RecurringPanel({ series, now }: { series: SeriesRow[]; now: CivilDate }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [showSilenced, setShowSilenced] = useState(false);
  const [pending, startTransition] = useTransition();

  const [optimistic, patch] = useOptimistic(
    series,
    (current: SeriesRow[], change: Partial<SeriesRow> & { id: string }) =>
      current.map((s) => (s.id === change.id ? { ...s, ...change } : s)),
  );

  const act = (id: string, action: SeriesAction, optimisticPatch: Partial<SeriesRow>) => {
    setFailure(null);
    startTransition(async () => {
      patch({ id, ...optimisticPatch });
      const result = await updateSeries(id, action);
      if (!result.ok) setFailure(result.error ?? "That change was refused.");
    });
  };

  const visible = optimistic.filter((s) => !s.dismissed);
  const silenced = optimistic.filter((s) => s.dismissed);

  // A series below the confidence floor is a guess, and a guess does not belong
  // in a bills calendar — unless a person has confirmed it, which is what
  // confirming is for.
  const isTrusted = (s: SeriesRow) =>
    s.confirmed || (s.confidence !== null && s.confidence >= CONFIDENCE_FLOOR);

  const trusted = visible.filter(isTrusted);
  const possible = visible.filter((s) => !isTrusted(s));

  const isQuiet = (s: SeriesRow) =>
    s.status === "active" &&
    s.lastSeen !== null &&
    s.intervalDays !== null &&
    isDormant({ lastSeen: s.lastSeen, intervalDays: s.intervalDays }, now);

  const dormant = trusted.filter(isQuiet);

  // Rises only, and recent ones. A cut is shown on the series row rather than
  // raised here, and a rise from three years ago is history — the window is a
  // year because §11.3's target is the *annual* bump, and anything shorter would
  // retire a yearly subscription's rise before its next charge arrived.
  const priced = trusted.filter(
    (s) =>
      s.kind !== "profit" &&
      s.amountPrev !== null &&
      s.amountLast !== null &&
      s.amountLast > s.amountPrev &&
      isRecentPriceChange(s.priceChangeAt, now),
  );

  const upcoming = trusted.filter(
    (s) =>
      s.status === "active" &&
      s.nextExpectedAt !== null &&
      !isQuiet(s) &&
      daysAway(s.nextExpectedAt, now) <= HORIZON_DAYS,
  );

  if (optimistic.length === 0) {
    return (
      <EmptyState
        title="Nothing detected yet"
        body="Series are found by the nightly pass, from three or more charges with a steady rhythm — weekly, fortnightly, monthly, quarterly or yearly. Savings transfers are never included: they follow no routine, and a predicted transfer would put money in this calendar that was never leaving."
      />
    );
  }

  return (
    <section className="space-y-6">
      {failure && (
        <p
          role="alert"
          className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {failure}
        </p>
      )}

      {priced.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Price increases
          </h2>
          <ul className="mt-2 space-y-2">
            {priced.map((s) => (
              <li
                key={s.id}
                className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-sm"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate font-medium">
                    <span className="sms-body">{s.label}</span>
                  </p>
                  <p>
                    <Money value={s.amountPrev ?? 0} />
                    <span className="opacity-50"> → </span>
                    <Money value={s.amountLast ?? 0} />
                  </p>
                </div>
                <p className="mt-1 text-xs opacity-70">
                  Up <Money value={(s.amountLast ?? 0) - (s.amountPrev ?? 0)} /> (
                  <span className="tabular">
                    {Math.round((((s.amountLast ?? 0) - (s.amountPrev ?? 0)) / (s.amountPrev || 1)) * 100)}
                    %
                  </span>
                  ){s.priceChangeAt && ` from ${civilShort(s.priceChangeAt)}`} ·{" "}
                  {CADENCE_LABELS[s.cadence]}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Upcoming</h2>
        {upcoming.length === 0 ? (
          <p className="mt-2 text-xs opacity-55">
            Nothing expected in the next {HORIZON_DAYS} days.
          </p>
        ) : (
          <UpcomingByWeek rows={upcoming} now={now} />
        )}
      </div>

      {dormant.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Gone quiet
          </h2>
          <ul className="mt-2 space-y-2">
            {dormant.map((s) => (
              <li key={s.id} className="rounded-xl bg-black/[0.03] p-3 text-sm dark:bg-white/[0.06]">
                <p className="font-medium">
                  <span className="sms-body">{s.label}</span>
                </p>
                <p className="mt-1 text-xs opacity-65">
                  No charge since {s.lastSeen ? civilShort(s.lastSeen) : "—"} — that is{" "}
                  <span className="tabular">
                    {s.lastSeen ? Math.abs(daysAway(s.lastSeen, now)) : 0}
                  </span>{" "}
                  days on a {CADENCE_LABELS[s.cadence]} charge. Cancelled?
                </p>
                <div className="mt-2 flex flex-wrap gap-3">
                  <Action
                    label="Mark cancelled"
                    onClick={() => act(s.id, "cancel", { status: "cancelled" })}
                  />
                  <Action
                    label="Still active"
                    onClick={() => act(s.id, "confirm", { confirmed: true })}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Detected</h2>
        <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
          {trusted.map((s) => (
            <SeriesLine key={s.id} s={s} now={now} pending={pending} act={act} />
          ))}
        </ul>
      </div>

      {possible.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Possible series
          </h2>
          <p className="mt-1 text-xs opacity-55">
            Below the confidence floor, so they are kept out of the calendar above. Confirming one
            puts it in and keeps it there through a missed charge.
          </p>
          <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
            {possible.map((s) => (
              <SeriesLine key={s.id} s={s} now={now} pending={pending} act={act} />
            ))}
          </ul>
        </div>
      )}

      {silenced.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSilenced((v) => !v)}
            className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
          >
            {showSilenced ? "Hide" : "Show"} {silenced.length} silenced{" "}
            {silenced.length === 1 ? "series" : "series"}
          </button>
          {showSilenced && (
            <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
              {silenced.map((s) => (
                <SeriesLine key={s.id} s={s} now={now} pending={pending} act={act} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- upcoming */

/**
 * §11.3 — "Upcoming bills calendar with next expected date and amount", grouped
 * by week.
 *
 * Weeks here are the app's weeks: Sunday-based (§5.2), so a Thursday–Saturday
 * run of charges lands in one group rather than being split across two. Overdue
 * items are not grouped at all — they belong to no future week.
 */
function UpcomingByWeek({ rows, now }: { rows: SeriesRow[]; now: CivilDate }) {
  const overdue = rows.filter((s) => daysAway(s.nextExpectedAt!, now) < 0);
  const ahead = rows.filter((s) => daysAway(s.nextExpectedAt!, now) >= 0);

  const weeks = new Map<CivilDate, SeriesRow[]>();
  for (const s of ahead) {
    const key = weekStart(s.nextExpectedAt!);
    const bucket = weeks.get(key);
    if (bucket) bucket.push(s);
    else weeks.set(key, [s]);
  }

  const ordered = [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = (list: SeriesRow[]) =>
    list.reduce((sum, s) => sum + (expectedAmount(s) ?? 0), 0);

  /** A week of nothing but profit payouts has no total to print — "0.00 + varies"
   *  reads as a figure, and the figure would be wrong. */
  const weekTotal = (list: SeriesRow[]) => {
    const known = list.filter((s) => expectedAmount(s) !== null);
    const varies = known.length < list.length;
    return { amount: known.length > 0 ? total(known) : null, varies };
  };

  return (
    <div className="mt-2 space-y-4">
      {overdue.length > 0 && (
        <div>
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Overdue</p>
          <ul className="mt-1 divide-y divide-black/5 dark:divide-white/10">
            {overdue.map((s) => (
              <BillLine key={s.id} s={s} now={now} />
            ))}
          </ul>
        </div>
      )}

      {ordered.map(([week, list]) => (
        <div key={week}>
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-medium opacity-70">{periodLabel("week", week)}</p>
            <p className="text-xs opacity-55">
              {(() => {
                const { amount, varies } = weekTotal(list);
                if (amount === null) return "amount varies";
                return (
                  <>
                    <Money value={amount} />
                    {varies && " + varies"}
                  </>
                );
              })()}
            </p>
          </div>
          <ul className="mt-1 divide-y divide-black/5 dark:divide-white/10">
            {list.map((s) => (
              <BillLine key={s.id} s={s} now={now} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function BillLine({ s, now }: { s: SeriesRow; now: CivilDate }) {
  const away = daysAway(s.nextExpectedAt!, now);
  const amount = expectedAmount(s);
  const incoming = s.kind === "salary" || s.kind === "profit";

  return (
    <li className="flex items-baseline justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="truncate">
          <span className="sms-body">{s.label}</span>
        </p>
        <p className="text-xs opacity-55">
          {civilShort(s.nextExpectedAt!)} ·{" "}
          {away < 0
            ? `${Math.abs(away)} days late`
            : away === 0
              ? "today"
              : away === 1
                ? "tomorrow"
                : `in ${away} days`}
          {s.accountName && ` · ${s.accountName}`}
        </p>
      </div>
      <p className="shrink-0">
        {amount === null ? (
          <span className="text-xs opacity-50">amount varies</span>
        ) : (
          <Money value={incoming ? amount : -amount} tone="auto" sign="always" />
        )}
      </p>
    </li>
  );
}

/* ----------------------------------------------------------------- a series */

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
    >
      {label}
    </button>
  );
}

function SeriesLine({
  s,
  now,
  pending,
  act,
}: {
  s: SeriesRow;
  now: CivilDate;
  pending: boolean;
  act: (id: string, action: SeriesAction, patch: Partial<SeriesRow>) => void;
}) {
  const amount = expectedAmount(s);

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">
          <span className="sms-body">{s.label}</span>
          {s.confirmed && (
            <span className="ml-1.5 text-[11px] font-normal opacity-55">confirmed</span>
          )}
          {s.status !== "active" && (
            <span className="ml-1.5 text-[11px] font-normal opacity-55">{s.status}</span>
          )}
          {s.excludedFromDetection && (
            <span className="ml-1.5 text-[11px] font-normal opacity-55">excluded</span>
          )}
        </p>
        <p className="shrink-0 text-sm">
          {amount === null ? (
            <span className="text-xs opacity-50">varies</span>
          ) : (
            <Money value={amount} />
          )}
        </p>
      </div>

      <p className="mt-1 text-xs opacity-55">
        {KIND_LABELS[s.kind]} · {CADENCE_LABELS[s.cadence]}
        {s.kind === "profit" && " (cadence only — the amount is expected to vary)"}
        {" · "}
        <span className="tabular">{s.occurrenceCount}</span> charges
        {s.confidence !== null && (
          <>
            {" · "}
            <span className="tabular">{Math.round(s.confidence * 100)}%</span> confidence
          </>
        )}
        {s.lastSeen && ` · last ${civilShort(s.lastSeen)}`}
        {s.nextExpectedAt && s.status === "active" && (
          <>
            {" · next "}
            {civilShort(s.nextExpectedAt)} ({daysAway(s.nextExpectedAt, now)} days)
          </>
        )}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {!s.confirmed && (
          <Action label="Confirm" onClick={() => act(s.id, "confirm", { confirmed: true })} />
        )}
        {s.status === "active" ? (
          <Action label="Pause" onClick={() => act(s.id, "pause", { status: "paused" })} />
        ) : s.status === "paused" ? (
          <Action label="Resume" onClick={() => act(s.id, "resume", { status: "active" })} />
        ) : null}
        {s.status !== "cancelled" && (
          <Action
            label="Mark cancelled"
            onClick={() => act(s.id, "cancel", { status: "cancelled" })}
          />
        )}
        {s.dismissed ? (
          <Action label="Restore" onClick={() => act(s.id, "restore", { dismissed: false })} />
        ) : (
          <Action
            label="Dismiss as noise"
            onClick={() => act(s.id, "dismiss", { dismissed: true, confirmed: false })}
          />
        )}
        {s.excludedFromDetection ? (
          <Action
            label="Detect again"
            onClick={() => act(s.id, "include", { excludedFromDetection: false, dismissed: false })}
          />
        ) : (
          <Action
            label="Exclude from detection"
            onClick={() => act(s.id, "exclude", { excludedFromDetection: true, dismissed: true })}
          />
        )}
        {pending && <Loader size={14} variant="arrows" label={`Updating ${s.label}`} />}
      </div>
    </li>
  );
}
