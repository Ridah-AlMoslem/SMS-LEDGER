/**
 * Savings and profit — SPEC §11.5, and the §6 rule that makes it possible.
 *
 * Three different events land in the *same* account and are not the same thing:
 * a deposit and a withdrawal are internal transfers (net worth unchanged), and
 * a profit payout is passive income (net worth up). Only the message wording
 * separates them, and §6 is explicit about the consequence:
 *
 *   "Keep `Σ deposits − Σ withdrawals` and `Σ profit` as independent running
 *    totals; never try to infer the split from the balance."
 *
 * That is the whole design of this module. Nothing here divides a balance into
 * parts. Two counters are carried forward independently and the balance is only
 * ever used to *check* them — `residual()` is the assertion that they still add
 * up, and the verification script runs it.
 *
 * Two facts from §11.5 shape everything else:
 *
 *   - **Profit varies month to month.** So no expected amount is stored, derived
 *     or warned about anywhere; `payoutStatus` takes dates and nothing else, and
 *     the projection is a range rather than a line.
 *   - **Transfers follow no routine.** So net contribution is reported as a
 *     signed per-cycle figure — it can be negative, and that is a valid result,
 *     not a bug (§11.5's scenario B).
 *
 * Everything is pure. `npm run test:account-detail` runs it.
 */

import {
  type CivilDate,
  addDays,
  diffDays,
  periodBounds,
  shortLabel,
} from "./periods.ts";
import { DEFAULT_SETTINGS, type PeriodSettings } from "./settings.ts";

/**
 * One posted leg on the savings account.
 *
 * `excluded` is carried but never used to decide the balance: a hand-booked
 * adjustment is excluded from analytics (§6 — a correction is neither income
 * nor spending) and still moves the account, because `recompute_balances` sums
 * every posted leg regardless. It lands in `other` below, visible rather than
 * quietly folded into one of the two real buckets.
 */
export type SavingsLeg = {
  /** Local civil day, from `local_date()`. What the BALANCE moves on. */
  day: CivilDate;
  /**
   * The cycle it is REPORTED in — `effective_cycle(posted_at, cycle_override)`.
   *
   * Two columns rather than one because they answer different questions and
   * §5.6 lets them differ: a balance is a fact about a date, while a cycle
   * bucket honours the override that puts an early salary in the cycle it
   * funds. The per-cycle counters bucket on this so the bars agree with Home's
   * `netToSavingsQuery`, and the daily balance walks `day` so the line is the
   * account's actual history. `residual()` is what catches it if the two ever
   * pull apart.
   */
  cycle: CivilDate;
  /** Positive magnitude, as stored. The direction carries the sign. */
  amount: number;
  direction: "credit" | "debit";
  type: string;
  isInternalTransfer: boolean;
  excluded: boolean;
};

export type LegClass = "deposit" | "withdrawal" | "profit" | "other";

/**
 * §6, applied to one leg.
 *
 * `profit` matches `IS_PASSIVE` in `db/predicates.ts` exactly — a credit of type
 * `profit` that is neither an internal transfer nor excluded. An unpaired
 * savings credit is **not** automatically profit (§6): the parser promotes it
 * on the message wording, and by the time a leg reaches here that decision has
 * already been made and stored in `type`.
 */
export function classify(leg: SavingsLeg): LegClass {
  if (leg.isInternalTransfer) {
    return leg.direction === "credit" ? "deposit" : "withdrawal";
  }
  if (leg.type === "profit" && leg.direction === "credit" && !leg.excluded) return "profit";
  return "other";
}

const signed = (leg: SavingsLeg) => (leg.direction === "credit" ? leg.amount : -leg.amount);

export type CycleSavings = {
  cycle: CivilDate;
  /** "Aug" — an axis tick at 390px. */
  label: string;
  deposits: number;
  withdrawals: number;
  /** deposits − withdrawals. **Signed**: a cycle that drew money out is
   *  negative, and §11.5 requires that to be shown rather than clamped. */
  net: number;
  profit: number;
  /** Anything that is neither — an adjustment, a fee. Signed. Kept visible so
   *  the two real counters cannot silently absorb something they did not earn. */
  other: number;

  /** Balance on the cycle's last day, or on `today` while it is in progress. */
  closingBalance: number;
  /**
   * Σ(each day's closing balance) ÷ days — the denominator §11.5 requires.
   *
   * "Use average *daily* balance, not closing balance — an irregular mid-cycle
   * deposit would otherwise distort the rate badly." A 50k deposit on the 23rd
   * of a cycle earns two days of profit and would otherwise be divided into as
   * though it had been there all month, reporting a yield near zero.
   */
  averageDailyBalance: number;
  /** Days actually elapsed in this cycle. 28–31, or fewer while in progress. */
  days: number;

  /** opening balance + Σ net contributions, from the start of the window. */
  cumulativePrincipal: number;
  cumulativeProfit: number;
  cumulativeOther: number;

  /** (profit ÷ average daily balance) × 12. null when there was no balance. */
  realizedYield: number | null;
  /**
   * The same rate on the closing balance. **Not for display** — it exists so
   * the two can be compared, and the verification script asserts they differ on
   * a mid-cycle deposit and that the average-daily one is what the view uses.
   */
  closingYield: number | null;
  /** Mean of the trailing three cycles' realized yield, this one included. */
  trailingYield: number | null;

  /** §11.5 — profit ÷ this cycle's expenses. null when nothing was spent,
   *  which is a missing denominator rather than infinite coverage. */
  passiveCoverage: number | null;
  /** The cycle has not finished. Its bar is not comparable to a whole one. */
  partial: boolean;
};

/** Cycles' worth of trailing history the yield average smooths over (§11.5 —
 *  "a single month tells you nothing"). */
export const YIELD_WINDOW = 3;

/** Cycles per year. The rate is annualised, and a cycle is one month (§5.1). */
const CYCLES_PER_YEAR = 12;

export function savingsByCycle(input: {
  /** The balance immediately BEFORE the first cycle in the window. §9.2's
   *  opening balance when the window reaches back to the start of tracking. */
  openingBalance: number;
  /** Posted legs inside the window. Legs outside it are ignored — the fold
   *  walks days and only looks up the ones it reaches. */
  legs: SavingsLeg[];
  /** Cycle anchors, oldest first, contiguous. */
  cycles: CivilDate[];
  /** Cycle anchor → that cycle's total expenses, for passive coverage. */
  expenseByCycle?: Map<CivilDate, number>;
  /** Today, so a cycle in progress averages over elapsed days only. */
  today: CivilDate;
  settings?: PeriodSettings;
}): CycleSavings[] {
  const s = input.settings ?? DEFAULT_SETTINGS;

  // The balance moves on the day the money moved; the counters are bucketed by
  // the cycle the leg is reported in. Two indexes, for the two questions.
  const deltaByDay = new Map<CivilDate, number>();

  type Counters = { deposits: number; withdrawals: number; profit: number; other: number };
  const byCycle = new Map<CivilDate, Counters>();

  for (const leg of input.legs) {
    deltaByDay.set(leg.day, (deltaByDay.get(leg.day) ?? 0) + signed(leg));

    let counters = byCycle.get(leg.cycle);
    if (!counters) byCycle.set(leg.cycle, (counters = { deposits: 0, withdrawals: 0, profit: 0, other: 0 }));

    switch (classify(leg)) {
      case "deposit":
        counters.deposits += leg.amount;
        break;
      case "withdrawal":
        counters.withdrawals += leg.amount;
        break;
      case "profit":
        counters.profit += leg.amount;
        break;
      default:
        counters.other += signed(leg);
    }
  }

  let balance = input.openingBalance;
  let cumulativePrincipal = input.openingBalance;
  let cumulativeProfit = 0;
  let cumulativeOther = 0;

  const rows: CycleSavings[] = [];

  for (const cycle of input.cycles) {
    const { start, end } = periodBounds("cycle", cycle, s);
    // A cycle in progress averages over the days that have happened. Dividing
    // by 31 on the 3rd would report a yield a tenth of the real one.
    const last = input.today < end ? input.today : end;

    const { deposits, withdrawals, profit, other } = byCycle.get(cycle) ?? {
      deposits: 0,
      withdrawals: 0,
      profit: 0,
      other: 0,
    };

    let balanceSum = 0;
    let days = 0;

    if (diffDays(start, last) >= 0) {
      for (let day = start; day <= last; day = addDays(day, 1)) {
        // Applied before the day is measured, so the figure summed is each
        // day's CLOSING balance. A deposit earns from the day it lands.
        balance += deltaByDay.get(day) ?? 0;
        balanceSum += balance;
        days++;
      }
    }

    const net = deposits - withdrawals;
    cumulativePrincipal += net;
    cumulativeProfit += profit;
    cumulativeOther += other;

    const averageDailyBalance = days > 0 ? balanceSum / days : 0;
    const expense = input.expenseByCycle?.get(cycle);

    rows.push({
      cycle,
      label: shortLabel("cycle", cycle, s),
      deposits,
      withdrawals,
      net,
      profit,
      other,
      closingBalance: balance,
      averageDailyBalance,
      days,
      cumulativePrincipal,
      cumulativeProfit,
      cumulativeOther,
      realizedYield:
        averageDailyBalance > 0 ? (profit / averageDailyBalance) * CYCLES_PER_YEAR : null,
      closingYield: balance > 0 ? (profit / balance) * CYCLES_PER_YEAR : null,
      trailingYield: null, // filled below, once the series exists
      passiveCoverage: expense !== undefined && expense > 0 ? profit / expense : null,
      partial: last < end,
    });
  }

  const trailing = trailingMean(
    rows.map((r) => r.realizedYield),
    YIELD_WINDOW,
  );
  for (let i = 0; i < rows.length; i++) rows[i].trailingYield = trailing[i];

  return rows;
}

/**
 * The check that the two counters still describe the account.
 *
 * `opening + net contributions + profit + other` must be the balance. It holds
 * by construction here, which is the point: if this ever returns a non-zero, a
 * leg was classified into a bucket it does not belong in, and the growth band
 * on screen is claiming money the account did not earn.
 */
export function residual(row: CycleSavings): number {
  return (
    row.cumulativePrincipal + row.cumulativeProfit + row.cumulativeOther - row.closingBalance
  );
}

/**
 * Trailing mean over `window` values, nulls skipped.
 *
 * Null where the window holds nothing to average, rather than zero: "no yield
 * measured" and "a yield of zero" are different statements and a chart that
 * draws them the same way reports a flat month that never happened.
 */
export function trailingMean(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter(
      (v): v is number => v !== null,
    );
    if (slice.length === 0) return null;
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  });
}

/* ------------------------------------------------------------- projection */

export type ProjectionPoint = {
  /** Cycles ahead. 0 is today. */
  cycle: number;
  label: string;
  low: number;
  mid: number;
  high: number;
};

export type Projection = {
  points: ProjectionPoint[];
  /** The annualised rates the band was drawn from. */
  rate: { low: number; mid: number; high: number };
  /** Trailing-average net contribution per cycle, plus whatever the slider
   *  adds. Signed — a history of withdrawals projects downwards. */
  contribution: number;
  /**
   * Whether the band is drawn from enough history to mean anything.
   *
   * False with fewer than three measured yields, and the view says so. A range
   * computed from one observation has zero width, which reads as certainty —
   * exactly the false precision §11.5 asks the range to avoid.
   */
  grounded: boolean;
  observations: number;
};

/**
 * §11.5 — "forecast from trailing-average yield and trailing-average net
 * contribution … show it as a range, not a line."
 *
 * The band is one standard deviation of the observed yields either side of
 * their mean. Not a confidence interval and not presented as one: it is the
 * spread this account has actually shown, compounded forward, and its whole
 * job is to stop a single projected number being read as a promise.
 */
export function project(input: {
  balance: number;
  /** Realized yields, annualised. Nulls (cycles with no balance) are dropped. */
  yields: (number | null)[];
  /** Trailing-average net contribution per cycle. Signed. */
  contribution: number;
  /** The "+500 per cycle" slider. */
  extra?: number;
  cycles?: number;
  /** Cycle index (1-based) → axis label. */
  labelAt?: (ahead: number) => string;
}): Projection {
  const observed = input.yields.filter((v): v is number => v !== null);
  const cycles = input.cycles ?? 24;
  const extra = input.extra ?? 0;
  const contribution = input.contribution + extra;

  const mean =
    observed.length > 0 ? observed.reduce((s, v) => s + v, 0) / observed.length : 0;

  // Sample standard deviation. Zero with one observation, which collapses the
  // band — `grounded` is what stops that being displayed as a forecast.
  const variance =
    observed.length > 1
      ? observed.reduce((s, v) => s + (v - mean) ** 2, 0) / (observed.length - 1)
      : 0;
  const spread = Math.sqrt(variance);

  const rate = { low: Math.max(0, mean - spread), mid: mean, high: mean + spread };

  const points: ProjectionPoint[] = [
    {
      cycle: 0,
      label: input.labelAt?.(0) ?? "now",
      low: input.balance,
      mid: input.balance,
      high: input.balance,
    },
  ];

  let low = input.balance;
  let mid = input.balance;
  let high = input.balance;

  for (let ahead = 1; ahead <= cycles; ahead++) {
    low = low * (1 + rate.low / CYCLES_PER_YEAR) + contribution;
    mid = mid * (1 + rate.mid / CYCLES_PER_YEAR) + contribution;
    high = high * (1 + rate.high / CYCLES_PER_YEAR) + contribution;
    points.push({ cycle: ahead, label: input.labelAt?.(ahead) ?? `+${ahead}`, low, mid, high });
  }

  return {
    points,
    rate,
    contribution,
    grounded: observed.length >= YIELD_WINDOW,
    observations: observed.length,
  };
}

/* --------------------------------------------------------- payout tracking */

export type PayoutState = "unknown" | "on-time" | "late" | "missing";

export type PayoutStatus = {
  state: PayoutState;
  /** Median days between payouts. null with fewer than two observed. */
  cadenceDays: number | null;
  lastAt: CivilDate | null;
  /** When the next one was due, from the cadence. */
  expectedBy: CivilDate | null;
  /** Days past `expectedBy`. 0 when not late. */
  daysLate: number;
  detail: string;
};

/**
 * §11.5 — "detect the monthly *cadence* but never the amount. A late or missing
 * payout is worth an alert; a smaller-than-usual one is not."
 *
 * The signature is the enforcement: this function receives dates and nothing
 * else, so it cannot warn about an amount even by accident. Profit here is
 * genuinely variable — a rate alert would fire most months and mean nothing,
 * and the one real failure it would bury is the payout that never arrived.
 */
export function payoutStatus(
  payoutDays: CivilDate[],
  today: CivilDate,
  /** Banks are not punctual to the day. A payout is late only past this. */
  graceDays = 5,
): PayoutStatus {
  const days = [...new Set(payoutDays)].sort();
  const lastAt = days.length > 0 ? days[days.length - 1] : null;

  if (days.length < 2) {
    return {
      state: "unknown",
      cadenceDays: null,
      lastAt,
      expectedBy: null,
      daysLate: 0,
      detail:
        days.length === 0
          ? "No profit has been recorded yet, so there is no cadence to measure against."
          : "One payout so far. Two are needed before a missing one can be told from a new account.",
    };
  }

  const gaps = days.slice(1).map((d, i) => diffDays(days[i], d));
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const cadenceDays =
    gaps.length % 2 === 1 ? gaps[middle] : Math.round((gaps[middle - 1] + gaps[middle]) / 2);

  const expectedBy = addDays(lastAt!, cadenceDays);
  const overdue = diffDays(expectedBy, today);
  const daysLate = Math.max(0, overdue - graceDays);

  if (daysLate === 0) {
    return {
      state: "on-time",
      cadenceDays,
      lastAt,
      expectedBy,
      daysLate: 0,
      detail: `Profit arrives about every ${cadenceDays} days. The next is due around ${expectedBy}.`,
    };
  }

  // A whole further cycle has gone by. Not "late" any more — one did not happen.
  if (overdue >= cadenceDays) {
    return {
      state: "missing",
      cadenceDays,
      lastAt,
      expectedBy,
      daysLate,
      detail: `No profit since ${lastAt}, and one was due around ${expectedBy}. A whole payout is missing, or the message never arrived.`,
    };
  }

  return {
    state: "late",
    cadenceDays,
    lastAt,
    expectedBy,
    daysLate,
    detail: `Profit was due around ${expectedBy} and has not arrived. ${daysLate} ${daysLate === 1 ? "day" : "days"} past the usual ${cadenceDays}-day gap.`,
  };
}
