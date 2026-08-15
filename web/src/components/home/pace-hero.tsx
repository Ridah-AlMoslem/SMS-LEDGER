/**
 * "Am I on pace?" — the first question Home answers (SPEC §11.2).
 *
 * The headline is **percent of the effective budget spent against percent of
 * the cycle elapsed**, because a total on its own has never changed anyone's
 * behaviour: 4,200 spent is neither good nor bad until you know whether the
 * cycle is a third or two thirds gone.
 *
 * Under it, leading the smaller text, is `remaining_pace` — what you can still
 * spend per week without blowing the cycle. §11.2 is explicit that this is the
 * number that changes behaviour, because it absorbs the overspend you have
 * already committed, so it goes above `fair_share` rather than beside it.
 *
 * Everything here divides by the cycle's ACTUAL length and by fractional weeks.
 * See `lib/pace.ts` for why both matter and what a 30 or a 4 would cost.
 */

import Link from "next/link";

import { Money } from "@/components/ui/money";
import type { Pace, Verdict } from "@/lib/pace";
import type { CivilDate, Grain } from "@/lib/periods";

const VERDICT_TONE: Record<Verdict, string> = {
  "On pace": "bg-black/[0.06] dark:bg-white/[0.10]",
  Ahead: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  Over: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 4.3, never 4. The rounding is display only; the arithmetic stays fractional
 *  (§11.2 — a flat quarter-split understates the weekly allowance by ~10%). */
const weeks = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

function Bar({ spent, elapsed, over }: { spent: number; elapsed: number; over: boolean }) {
  return (
    <div
      className="relative mt-3 h-2 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]"
      role="presentation"
    >
      <div
        className={`h-full rounded-full ${over ? "bg-rose-500" : "bg-foreground/70"}`}
        style={{ width: `${Math.min(Math.max(spent, 0), 1) * 100}%` }}
      />
      {/* Where the calendar is. The bar is the budget; this tick is the date,
          and the gap between them is the entire message. */}
      <div
        className="absolute inset-y-0 w-0.5 bg-[var(--background)] mix-blend-normal"
        style={{ left: `${Math.min(Math.max(elapsed, 0), 1) * 100}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

export function PaceHero({
  grain,
  pace,
  weekSpend,
  cycleLabel,
  partialWeek,
  weekDaysElapsed,
  href,
  planHref,
}: {
  grain: Grain;
  pace: Pace;
  /** Spend in the selected week. Only read at week grain. */
  weekSpend: number;
  cycleLabel: string;
  /** §5.3 — the week in progress, or one clipped by the cycle. */
  partialWeek: boolean;
  weekDaysElapsed: number;
  /** Drill-through: every figure on this page opens the transactions behind it. */
  href: string;
  planHref: string;
  period?: CivilDate;
}) {
  const { budget, spent, spentShare, elapsedShare, verdict, remainingPace, fairShare, projected } =
    pace;

  const allowance = remainingPace;

  /* ------------------------------------------------------------ week grain */

  if (grain === "week") {
    // §11.2 — at week grain the question is not "how much of the cycle is
    // gone", it is "am I inside this week's allowance". The allowance is the
    // adaptive one; fair_share is shown under it as the static target.
    const overAllowance = allowance !== null && weekSpend > allowance;

    return (
      <section className="rounded-2xl border border-black/10 p-4 dark:border-white/15">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs tracking-wide uppercase opacity-60">This week</p>
          {allowance !== null && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                overAllowance ? VERDICT_TONE.Over : VERDICT_TONE["On pace"]
              }`}
            >
              {overAllowance ? "Over" : "Within pace"}
            </span>
          )}
        </div>

        <Link href={href} className="mt-1 block">
          <p className="text-4xl leading-none font-semibold tracking-tight">
            <Money value={weekSpend} currency />
          </p>
        </Link>

        {allowance === null ? (
          <p className="mt-2.5 text-sm opacity-70">
            No budget set for {cycleLabel}, so there is no weekly allowance to measure this
            against.{" "}
            <Link href={planHref} className="underline underline-offset-2">
              Set one
            </Link>
            .
          </p>
        ) : (
          <>
            <p className="mt-2.5 text-sm">
              <span className="opacity-60">Allowance </span>
              <Money value={Math.max(allowance, 0)} />
              <span className="opacity-60">/week for </span>
              <span className="tabular">{weeks(pace.weeksLeft)}</span>
              <span className="opacity-60"> weeks left in {cycleLabel}</span>
            </p>
            {fairShare !== null && (
              <p className="mt-1 text-xs opacity-55">
                Fair share of the cycle budget is <Money value={fairShare} /> a week — the
                allowance above absorbs what has already been spent.
              </p>
            )}
          </>
        )}

        {/* §5.3 — a partial week is stated, never silently compared. */}
        {partialWeek && (
          <p className="mt-2 text-xs opacity-55">
            <span className="tabular">{weekDaysElapsed}</span> of 7 days so far — comparisons
            against a whole week are suppressed until it closes.
          </p>
        )}
      </section>
    );
  }

  /* ----------------------------------------------------------- cycle grain */

  if (budget === null || spentShare === null || verdict === null) {
    // No budget is a real state, and it is the state this app starts in. The
    // pace question still has half an answer — the run rate — so give that
    // rather than an empty card.
    return (
      <section className="rounded-2xl border border-black/10 p-4 dark:border-white/15">
        <p className="text-xs tracking-wide uppercase opacity-60">Spent this cycle</p>

        <Link href={href} className="mt-1 block">
          <p className="text-4xl leading-none font-semibold tracking-tight">
            <Money value={spent} currency />
          </p>
        </Link>

        <p className="mt-2.5 text-sm opacity-70">
          <span className="tabular">{pct(elapsedShare)}</span> through the cycle — day{" "}
          <span className="tabular">{pace.elapsed}</span> of{" "}
          <span className="tabular">{pace.total}</span>. At this rate the cycle ends at{" "}
          <Money value={projected} />.
        </p>

        <p className="mt-2 text-xs opacity-55">
          <Link href={planHref} className="underline underline-offset-2">
            Set a budget
          </Link>{" "}
          to turn this into a pace rather than a total.
        </p>
      </section>
    );
  }

  const over = spentShare > 1;

  return (
    <section className="rounded-2xl border border-black/10 p-4 dark:border-white/15">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs tracking-wide uppercase opacity-60">Budget spent</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT_TONE[verdict]}`}>
          {verdict}
        </span>
      </div>

      <Link href={href} className="mt-1 flex items-baseline gap-2">
        <span
          className={`text-4xl leading-none font-semibold tracking-tight tabular ${
            over ? "text-rose-600 dark:text-rose-400" : ""
          }`}
        >
          {Number.isFinite(spentShare) ? pct(spentShare) : "—"}
        </span>
        <span className="text-sm opacity-60">
          of <Money value={budget} /> · <span className="tabular">{pct(elapsedShare)}</span> of the
          cycle gone
        </span>
      </Link>

      <Bar spent={spentShare} elapsed={elapsedShare} over={over} />

      {/* §11.2 — remaining_pace leads. fair_share is the static target and sits
          under it, because the adaptive number is the one that changes what you
          do next. */}
      <p className="mt-3 text-sm">
        {allowance === null ? (
          <span className="opacity-60">The cycle closes today — no weeks left to pace.</span>
        ) : allowance >= 0 ? (
          <>
            <Money value={allowance} />
            <span className="opacity-60">/week for </span>
            <span className="tabular">{weeks(pace.weeksLeft)}</span>
            <span className="opacity-60"> weeks left</span>
          </>
        ) : (
          <>
            <span className="text-rose-600 dark:text-rose-400">
              <Money value={spent - budget} /> over
            </span>
            <span className="opacity-60">
              {" "}
              with <span className="tabular">{weeks(pace.weeksLeft)}</span> weeks still to go
            </span>
          </>
        )}
      </p>

      <p className="mt-1 text-xs opacity-55">
        Fair share <Money value={fairShare ?? 0} />/week · at this rate the cycle ends at{" "}
        <Money value={projected} /> against <Money value={budget} />. Day{" "}
        <span className="tabular">{pace.elapsed}</span> of{" "}
        <span className="tabular">{pace.total}</span> — this cycle&rsquo;s actual length.
      </p>
    </section>
  );
}
