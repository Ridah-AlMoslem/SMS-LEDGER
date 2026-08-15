/**
 * The week in review, on Sundays (SPEC §11.1).
 *
 * "This is the piece you'll actually read week to week." It appears only on
 * Sunday and only for the week that has **closed** — the week starting today is
 * one day old, and reviewing it would compare a Sunday against seven days
 * (§5.3). Weeks start Sunday here (§5.2), so "the week that just ended" is
 * always the seven days before this morning.
 */

import Link from "next/link";

import { Money } from "@/components/ui/money";
import type { Digest } from "@/db/home";
import type { Pace } from "@/lib/pace";

export function WeeklyDigest({
  digest,
  pace,
  weekLabel,
  href,
}: {
  digest: Digest;
  /** The cycle's pace, for the "still on track?" line. */
  pace: Pace;
  weekLabel: string;
  href: string;
}) {
  const { spend, fourWeekAverage, top, biggest } = digest;
  const delta = fourWeekAverage === null ? null : spend - fourWeekAverage;

  return (
    <section className="mt-6 rounded-2xl border border-black/10 p-4 dark:border-white/15">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Week in review</h2>
        <p className="text-xs opacity-50">{weekLabel}</p>
      </div>

      <Link href={href} className="mt-2 block">
        <p className="text-2xl font-semibold tracking-tight">
          <Money value={spend} currency />
        </p>
      </Link>

      <p className="mt-1 text-sm opacity-70">
        {delta === null ? (
          "No earlier weeks to compare against yet."
        ) : (
          <>
            <Money value={Math.abs(delta)} />{" "}
            {delta > 0 ? "more" : "less"} than the 4-week average of{" "}
            <Money value={fourWeekAverage ?? 0} />.
          </>
        )}
      </p>

      {top.length > 0 && (
        <p className="mt-2 text-sm">
          <span className="opacity-55">Top: </span>
          {top.map((c, i) => (
            <span key={c.name} className="sms-body">
              {i > 0 && <span className="opacity-40"> · </span>}
              {c.name} <Money value={c.total} />
            </span>
          ))}
        </p>
      )}

      {biggest && (
        <p className="mt-1 text-sm">
          <span className="opacity-55">Biggest single: </span>
          <span className="sms-body">{biggest.label}</span> <Money value={biggest.total} />
          <span className="opacity-55"> on {biggest.day}</span>
        </p>
      )}

      <p className="mt-2 text-sm">
        <span className="opacity-55">Pacing: </span>
        {pace.budget === null ? (
          "no budget set for this cycle"
        ) : pace.remainingPace === null ? (
          "the cycle closes today"
        ) : pace.remainingPace >= 0 ? (
          <>
            <Money value={pace.remainingPace} />
            <span className="opacity-55">/week still available</span>
          </>
        ) : (
          <span className="text-rose-600 dark:text-rose-400">
            <Money value={pace.spent - pace.budget} /> over the cycle budget already
          </span>
        )}
      </p>
    </section>
  );
}
