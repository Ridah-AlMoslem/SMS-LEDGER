/**
 * Savings goals — SPEC §11.2.
 *
 * "Goals are virtual buckets over a real account. Progress reads from the linked
 * account's actual balance, not a separate counter, so a withdrawal reduces goal
 * progress automatically and the number can never drift from reality."
 *
 * Two numbers, and keeping them apart is the whole design:
 *
 *   - **allocation** is the bucket: how much of that account this goal claims.
 *     Stored, because a person decides it, and because several goals may share
 *     one account and §11.2 requires the sum of their claims to be checked
 *     against the balance.
 *   - **funded** is the progress: how much of that claim the balance actually
 *     backs, right now. Derived, always, from `accounts.current_balance` — which
 *     is itself derived from the legs (§3.3). Nothing writes it.
 *
 * When the claims fit inside the balance, funded == allocation and the two look
 * redundant. They stop looking redundant the moment money leaves: a withdrawal
 * that drops the balance below the total claimed reduces every goal's progress
 * in proportion, immediately, with nothing to update and nothing to reconcile.
 * A stored progress counter would instead go on reporting savings that are no
 * longer there.
 *
 * Pure arithmetic over civil dates — no database, no `Date.now()`.
 */

import { type CivilDate, addMonths, diffDays, periodStart } from "./periods.ts";
import { DEFAULT_SETTINGS, type PeriodSettings } from "./settings.ts";

export type Goal = {
  id: string;
  name: string;
  targetAmount: number;
  /** null means "no deadline" — a goal with no date has no required
   *  contribution, which is a different thing from a contribution of zero. */
  targetDate: CivilDate | null;
  accountId: string | null;
  allocation: number;
};

/** One account, and what the goals over it add up to. */
export type Bucket = {
  accountId: string;
  /** The account's real balance. */
  balance: number;
  /** Σ allocations of the goals linked to it. */
  allocated: number;
  /**
   * balance − allocated. §11.2: "the unallocated remainder is always
   * displayed." Negative when the goals claim more than the account holds,
   * which is a state the UI must show rather than hide — see `coverage`.
   */
  remainder: number;
  /** 0–1. Below 1 the account cannot back every claim, and each goal's progress
   *  is scaled by this. */
  coverage: number;
  overAllocated: boolean;
};

export function bucketsFor(goals: Goal[], balances: Map<string, number>): Map<string, Bucket> {
  const allocated = new Map<string, number>();

  for (const g of goals) {
    if (!g.accountId) continue;
    allocated.set(g.accountId, (allocated.get(g.accountId) ?? 0) + g.allocation);
  }

  const buckets = new Map<string, Bucket>();

  for (const [accountId, total] of allocated) {
    const balance = balances.get(accountId) ?? 0;
    buckets.set(accountId, {
      accountId,
      balance,
      allocated: total,
      remainder: balance - total,
      // Guarded at both ends: an account with nothing allocated has full
      // coverage by definition, and a negative balance backs nothing at all.
      coverage: total <= 0 ? 1 : Math.min(1, Math.max(0, balance) / total),
      overAllocated: total > balance,
    });
  }

  return buckets;
}

/**
 * The excess an allocation change would create, or null when it fits.
 *
 * §11.2 — "the sum of buckets must not exceed the balance. Reject or warn on
 * over-allocation." This is the reject half, and it belongs here rather than in
 * the mutation so the sheet can show the number *before* the save is attempted.
 *
 * `goalId` is excluded from the sum when present, so editing an existing goal
 * does not count its own old allocation against it.
 */
export function overAllocationBy(
  goals: Goal[],
  { accountId, allocation, balance, goalId }: {
    accountId: string;
    allocation: number;
    balance: number;
    goalId?: string;
  },
): number | null {
  const others = goals
    .filter((g) => g.accountId === accountId && g.id !== goalId)
    .reduce((sum, g) => sum + g.allocation, 0);

  const excess = others + allocation - balance;
  return excess > 0 ? excess : null;
}

/* ------------------------------------------------------------------ pacing */

/**
 * Cycles from the one containing `now` to the one containing `target`,
 * inclusive of both.
 *
 * Cycles, not calendar months: contributions land with a salary, so "how many
 * more paydays are there" is the question a required contribution answers. A
 * target inside the current cycle leaves 1 — you have this payday and no other.
 * A target already past leaves 0, which is what makes the goal overdue rather
 * than merely demanding.
 */
export function cyclesUntil(
  target: CivilDate,
  now: CivilDate,
  s: PeriodSettings = DEFAULT_SETTINGS,
): number {
  if (diffDays(now, target) < 0) return 0;

  const here = periodStart(now, s);
  const there = periodStart(target, s);

  let count = 1;
  for (let c = here; c < there; c = addMonths(c, 1)) count++;
  return count;
}

export type GoalView = Goal & {
  /** Progress, read from the account balance. Never stored. */
  funded: number;
  /** funded ÷ target, uncapped — 1.2 means the bucket is over-full. */
  progress: number;
  /** What is still missing. Zero once the goal is met. */
  remaining: number;
  /** null with no target date. */
  cyclesLeft: number | null;
  /** What must go in per cycle to arrive on time. null with no target date. */
  requiredPerCycle: number | null;
  /** The target date has passed and the goal is not met. */
  overdue: boolean;
  /** This goal's share of the account's recent net contribution per cycle.
   *  null when there is no history to measure. */
  runRate: number | null;
  /** Whether the current run rate makes the target date. null when either the
   *  date or the run rate is unknown — a verdict needs both. */
  onTrack: boolean | null;
};

/**
 * One goal, resolved against its account.
 *
 * `accountRunRate` is the account's net contribution per cycle (deposits minus
 * withdrawals — it can be negative, and §11.5 says so). It is divided between
 * the goals sharing the account in proportion to their allocations, because that
 * is the same rule the funding follows: two goals splitting one savings account
 * are each getting their share of whatever went in.
 */
export function viewGoal(
  goal: Goal,
  bucket: Bucket | undefined,
  {
    now,
    accountRunRate = null,
    settings = DEFAULT_SETTINGS,
  }: { now: CivilDate; accountRunRate?: number | null; settings?: PeriodSettings },
): GoalView {
  const coverage = bucket?.coverage ?? (goal.accountId ? 0 : 1);
  const funded = Math.max(0, goal.allocation * coverage);
  const remaining = Math.max(0, goal.targetAmount - funded);

  const cyclesLeft = goal.targetDate ? cyclesUntil(goal.targetDate, now, settings) : null;
  const requiredPerCycle =
    cyclesLeft === null ? null : cyclesLeft > 0 ? remaining / cyclesLeft : remaining;

  const share =
    bucket && bucket.allocated > 0 ? goal.allocation / bucket.allocated : goal.accountId ? 0 : 1;
  const runRate = accountRunRate === null ? null : accountRunRate * share;

  return {
    ...goal,
    funded,
    progress: goal.targetAmount > 0 ? funded / goal.targetAmount : 0,
    remaining,
    cyclesLeft,
    requiredPerCycle,
    overdue: cyclesLeft === 0 && remaining > 0,
    runRate,
    onTrack:
      requiredPerCycle === null || runRate === null
        ? null
        : remaining === 0 || runRate >= requiredPerCycle,
  };
}
