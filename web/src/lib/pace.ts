/**
 * Pacing — SPEC §11.2.
 *
 * "60% spent, 40% through the cycle" is the number that changes behaviour, and
 * every part of it is a trap:
 *
 *   - **The denominator is the ACTUAL cycle length**, 28 to 31 days. A
 *     hardcoded 30 is wrong in February by 7% and in a 31-day cycle by 3%, and
 *     both errors point the same way: they make you look better paced than you
 *     are. Nothing in this module has a 30 in it; `total` is always passed in
 *     from `daysInPeriod()`.
 *   - **Weeks left is fractional.** A cycle averages 4.43 weeks, so dividing a
 *     cycle budget by 4 overstates the weekly allowance by ~10% and leaves you
 *     permanently, and wrongly, over budget.
 *   - **`remaining_pace` leads.** `fair_share` answers "what should this week
 *     cost?"; `remaining_pace` answers "what can I still spend per week without
 *     blowing the cycle?" — and it absorbs the overspend already committed,
 *     which is why it is the one that changes behaviour.
 *
 * Pure arithmetic, no dates, no database: `scripts/verify-home-aggregates.mjs`
 * runs the §6 worked example through it in both a 28-day and a 31-day cycle.
 */

export type Verdict = "On pace" | "Ahead" | "Over";

export type Pace = {
  /** base + carry. null when nothing is budgeted — see `verdict`. */
  budget: number | null;
  spent: number;
  /** Days consumed, inclusive of today. */
  elapsed: number;
  /** Days in the cycle. 28–31. Never 30 by assumption. */
  total: number;
  /** 0–1, uncapped: 1.4 means 140% of the budget is gone. null with no budget. */
  spentShare: number | null;
  /** 0–1. */
  elapsedShare: number;
  /** null with no budget — a verdict needs something to be measured against. */
  verdict: Verdict | null;
  /** Fractional, and the whole point: 4.43 weeks, not 4. */
  weeksLeft: number;
  /**
   * (budget − spent) / weeks_left, in SAR per week. Negative when the budget is
   * already gone, which is information and is displayed as such rather than
   * clamped. null with no budget or in a closed period.
   */
  remainingPace: number | null;
  /** cycle_budget × days_in_week / days_in_cycle. The static target. */
  fairShare: number | null;
  /** End-of-cycle spend at the current run rate. */
  projected: number;
};

/**
 * How far ahead of the calendar spending may run before it is called "Over".
 *
 * Five points of a cycle is roughly a day and a half. Below that the verdict
 * would flip on a single coffee bought in the morning rather than the evening,
 * and a headline that changes its mind daily stops being read.
 */
const TOLERANCE = 0.05;

export function pace({
  budget,
  spent,
  elapsed,
  total,
  daysInWeek = 7,
}: {
  budget: number | null;
  spent: number;
  elapsed: number;
  total: number;
  daysInWeek?: number;
}): Pace {
  const days = Math.max(total, 1);
  const gone = Math.min(Math.max(elapsed, 0), days);
  const elapsedShare = gone / days;

  // Run rate from what has actually happened. Before the first day closes there
  // is no rate to extrapolate, so the projection is just what is spent.
  const projected = gone > 0 ? (spent / gone) * days : spent;

  // Fractional by construction. Rounding it up to whole weeks would recreate
  // the ÷4 error the SPEC spends a paragraph on.
  const weeksLeft = (days - gone) / 7;

  if (budget === null || !Number.isFinite(budget)) {
    return {
      budget: null,
      spent,
      elapsed: gone,
      total: days,
      spentShare: null,
      elapsedShare,
      verdict: null,
      weeksLeft,
      remainingPace: null,
      fairShare: null,
      projected,
    };
  }

  // Not clamped. An effective budget can be zero or negative once a large
  // negative carry lands (§11.2), and "spent 3 of a 0 budget" is a real state.
  const spentShare = budget > 0 ? spent / budget : spent > 0 ? Infinity : 0;

  const verdict: Verdict =
    spent > budget
      ? "Over"
      : spentShare === null || !Number.isFinite(spentShare)
        ? "Over"
        : spentShare > elapsedShare + TOLERANCE
          ? "Over"
          : spentShare < elapsedShare - TOLERANCE
            ? "Ahead"
            : "On pace";

  return {
    budget,
    spent,
    elapsed: gone,
    total: days,
    spentShare,
    elapsedShare,
    verdict,
    weeksLeft,
    // Guard the last day of the cycle: dividing by ~0 weeks left produces a
    // per-week allowance in the millions, which reads as a bug.
    remainingPace: weeksLeft >= 0.5 ? (budget - spent) / weeksLeft : null,
    fairShare: (budget * daysInWeek) / days,
    projected,
  };
}

/* ------------------------------------------------------------------ carry */

export type CycleBudget = {
  /** The 25th that opens the cycle. */
  cycleStart: string;
  base: number;
  /** The carry this cycle inherited — stored, not recomputed. */
  carryIn: number;
  rollover: boolean;
  spent: number;
};

/**
 * §11.2 — `carry(c+1) = effective_budget(c) − spent(c)`, signed.
 *
 * Underspend raises the next cycle's allowance; **overspend lowers it**. That
 * is the honest version: overspending has a consequence, and saving across
 * cycles for a large purchase needs no separate feature.
 *
 * **One step, from one closing cycle.** Not a fold over history, which is the
 * distinction §11.2 spends a sentence on: "Carry is stored per cycle when the
 * cycle closes, not recomputed from the beginning of time, so a single
 * corrected old transaction can't cascade through years of budgets." A fold
 * recomputed at read time is exactly that cascade — fixing a mis-parsed
 * purchase from March would move April's carry, which moves May's, which moves
 * the allowance on the screen in front of you today.
 *
 * So this is called once per cycle boundary by `closeCycle` in `db/budgets.ts`,
 * its result is written to `budgets.carry_in`, and `carry_closed_at` is what
 * stops it ever being asked again.
 *
 * A category without rollover carries nothing forward and inherits nothing: the
 * carry it was handed is dropped rather than passed on.
 */
export function carryForward(closing: CycleBudget): number {
  if (!closing.rollover) return 0;
  return closing.base + closing.carryIn - closing.spent;
}

/**
 * base + carry, kept as separate numbers all the way to the screen.
 *
 * §11.2 asks for exactly this guard: "show `base` and `carry` as separate
 * numbers so a large negative carry is never mistaken for a small budget." A
 * category with a 2,000 base and a −1,800 carry has 200 to spend, and rendering
 * only the 200 makes an emergency look like a policy.
 */
export function effectiveBudget(base: number, carry: number): number {
  return base + carry;
}
