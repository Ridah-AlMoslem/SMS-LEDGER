/**
 * Cards and loans — SPEC §11.4, and the §6 rules that keep them out of the
 * spending figure.
 *
 * Two things here are computed and never stored:
 *
 *   - **A loan's amortization** (§4: "computed, not stored — derive the
 *     interest/principal split per payment from `apr` and `current_balance`").
 *     A stored schedule is a schedule that disagrees with the balance the
 *     moment an extra payment lands.
 *   - **What paying the minimum costs.** That figure only means anything
 *     alongside the alternative, which is why the two are returned together.
 *
 * And one rule governs both: **principal is not expense** (§6). A 2,000 loan
 * payment split 300/1,700 is 300 of spending and 1,700 of debt reduction;
 * counting the whole payment inflates expense and double-counts the principal,
 * once as spending and again as a net-worth movement. Everything below reports
 * the split rather than the payment.
 *
 * Pure, so `npm run test:account-detail` can hold it to account.
 */

import { type CivilDate, addMonths, diffDays } from "./periods.ts";

/* --------------------------------------------------------- card statements */

/**
 * §5.5 — the statement cycle exists **only** on the card detail view.
 *
 * Everywhere else in this app a month is the salary cycle, 25th → 24th. A card
 * statement runs on the bank's own dates and is a genuinely different period,
 * so the two must never appear as competing readings of "this month" on one
 * screen: the card's *spending* is reported in salary cycles like everything
 * else, and only what the bank is asking you to pay comes from here.
 */
export type Statement = {
  statementDate: CivilDate;
  totalDue: number | null;
  minimumDue: number | null;
  dueDate: CivilDate | null;
  paidAt: Date | null;
};

export type StatementState = {
  paid: boolean;
  /** Negative when the date has passed. null when the bank gave no due date. */
  daysUntilDue: number | null;
  urgency: "paid" | "overdue" | "due-soon" | "scheduled" | "unknown";
  detail: string;
};

/** §11.6 lists "card due within 3 days" as its own alert. */
export const DUE_SOON_DAYS = 3;

export function statementState(statement: Statement, today: CivilDate): StatementState {
  if (statement.paidAt) {
    return {
      paid: true,
      daysUntilDue: statement.dueDate ? diffDays(today, statement.dueDate) : null,
      urgency: "paid",
      detail: "This statement is settled. Paying a card is an internal transfer, not spending — the purchases behind it were counted when they happened (§6).",
    };
  }

  if (!statement.dueDate) {
    return {
      paid: false,
      daysUntilDue: null,
      urgency: "unknown",
      detail: "The statement message carried no due date, so nothing here can tell you how long you have.",
    };
  }

  const daysUntilDue = diffDays(today, statement.dueDate);

  if (daysUntilDue < 0) {
    return {
      paid: false,
      daysUntilDue,
      urgency: "overdue",
      detail: `Payment was due ${-daysUntilDue} ${-daysUntilDue === 1 ? "day" : "days"} ago and nothing has been recorded against it.`,
    };
  }

  return {
    paid: false,
    daysUntilDue,
    urgency: daysUntilDue <= DUE_SOON_DAYS ? "due-soon" : "scheduled",
    detail:
      daysUntilDue === 0
        ? "Payment is due today."
        : `Payment is due in ${daysUntilDue} ${daysUntilDue === 1 ? "day" : "days"}.`,
  };
}

/**
 * A typical Saudi card's monthly rate.
 *
 * An assumption, not a fact about your card: `accounts` has no rate column
 * because no message has ever stated one. It is a parameter everywhere below
 * and is printed beside every figure it produces, because a number this
 * consequential arrived at from a guess has to be visibly a guess.
 */
export const DEFAULT_CARD_MONTHLY_RATE = 0.025;

/** The flat floor most cards apply under their percentage minimum. */
export const DEFAULT_MINIMUM_FLOOR = 100;

export type PaymentPlan = {
  /** Months until the balance clears. null when it never does. */
  months: number | null;
  totalPaid: number;
  totalInterest: number;
  cleared: boolean;
};

export type PaymentComparison = {
  full: PaymentPlan;
  minimum: PaymentPlan;
  /** What the minimum costs over the full payment, in money and in months. */
  extraInterest: number;
  monthlyRate: number;
  /** The share of the balance the card asks for, from its own statement. */
  minimumShare: number;
};

/**
 * Pay it off now versus pay the minimum, with the interest consequence (§11.4).
 *
 * The minimum is modelled from **this card's own statement** — `minimumDue ÷
 * totalDue` — rather than from a generic 5%, so the comparison describes the
 * card in front of you. It falls to a percentage of the falling balance with a
 * flat floor beneath it, which is how these actually work; without the floor a
 * percentage-only minimum approaches zero and never clears, which is arithmetic
 * rather than an answer.
 */
export function minimumVsFull(input: {
  balance: number;
  minimumDue: number | null;
  totalDue: number | null;
  monthlyRate?: number;
  floor?: number;
  maxMonths?: number;
}): PaymentComparison {
  const monthlyRate = input.monthlyRate ?? DEFAULT_CARD_MONTHLY_RATE;
  const floor = input.floor ?? DEFAULT_MINIMUM_FLOOR;
  const maxMonths = input.maxMonths ?? 600;

  const share =
    input.minimumDue !== null && input.totalDue !== null && input.totalDue > 0
      ? input.minimumDue / input.totalDue
      : 0.05;

  const full: PaymentPlan = {
    months: input.balance > 0 ? 1 : 0,
    totalPaid: Math.max(0, input.balance),
    totalInterest: 0,
    cleared: true,
  };

  let balance = input.balance;
  let totalPaid = 0;
  let totalInterest = 0;
  let months = 0;

  while (balance > 0.01 && months < maxMonths) {
    const interest = balance * monthlyRate;
    const due = balance + interest;
    const payment = Math.min(due, Math.max(due * share, floor));

    // A payment that does not cover the month's interest never clears, and
    // saying "600 months" would dress that up as a schedule.
    if (payment <= interest + 0.01) {
      return {
        full,
        minimum: { months: null, totalPaid, totalInterest, cleared: false },
        extraInterest: Infinity,
        monthlyRate,
        minimumShare: share,
      };
    }

    balance = due - payment;
    totalPaid += payment;
    totalInterest += interest;
    months++;
  }

  const cleared = balance <= 0.01;

  return {
    full,
    minimum: {
      months: cleared ? months : null,
      totalPaid,
      totalInterest,
      cleared,
    },
    extraInterest: cleared ? totalInterest : Infinity,
    monthlyRate,
    minimumShare: share,
  };
}

/**
 * §3.3a, stated as a sentence.
 *
 * `toView()` in `lib/accounts.ts` does the arithmetic and is the only place
 * that may; this only names what the stored figure means, so the card screen
 * can say it out loud rather than leaving the reader to infer which of two
 * numbers is the debt.
 */
export function balanceMeaning(semantics: string): string {
  return semantics === "available_credit"
    ? "The bank reports what you can still spend, not what you owe — purchases lower it and payments raise it. What you owe is the limit minus that figure."
    : "The bank reports what you owe.";
}

/* --------------------------------------------------------------- loans */

export type AmortizationRow = {
  /** 1-based payment number. */
  n: number;
  due: CivilDate;
  payment: number;
  /** §6 — the only part of a payment that is spending. */
  interest: number;
  /** §6 — debt reduction. Moves net worth, never the expense figure. */
  principal: number;
  /** What is still owed after this payment. */
  balance: number;
};

export type Amortization = {
  rows: AmortizationRow[];
  /** null when the payment never clears the balance. */
  months: number | null;
  payoffDate: CivilDate | null;
  totalInterest: number;
  totalPaid: number;
  cleared: boolean;
  monthlyRate: number;
  /** The payment does not cover the first month's interest — the balance grows
   *  with every payment made. A schedule would be a fiction; this is the fact. */
  underwater: boolean;
};

/**
 * The schedule from `apr` and `current_balance` (§4), computed on every read.
 *
 * `apr` is accepted as a fraction (`0.0499`) or as a percentage (`4.99`) and
 * normalised, because nothing writes that column yet and both conventions are
 * plausible in the same table. A 4.99 read as a fraction is a 499% loan, which
 * is not a rounding error — it is a payoff date decades wrong.
 */
export function amortize(input: {
  /** The debt owed. From the account, whose balance is derived from the legs. */
  balance: number;
  apr: number;
  payment: number;
  /** The month the next payment falls in. */
  from: CivilDate;
  maxMonths?: number;
}): Amortization {
  const monthlyRate = normaliseApr(input.apr) / 12;
  const maxMonths = input.maxMonths ?? 600;

  const rows: AmortizationRow[] = [];
  let balance = input.balance;
  let totalInterest = 0;
  let totalPaid = 0;

  const empty = {
    rows,
    months: null,
    payoffDate: null,
    totalInterest: 0,
    totalPaid: 0,
    cleared: false,
    monthlyRate,
  };

  if (balance <= 0) return { ...empty, months: 0, cleared: true, underwater: false };
  if (input.payment <= 0) return { ...empty, underwater: true };

  const firstInterest = balance * monthlyRate;
  if (input.payment <= firstInterest + 0.01) return { ...empty, underwater: true };

  for (let n = 1; n <= maxMonths && balance > 0.005; n++) {
    const interest = balance * monthlyRate;
    // The last payment is only what is left. Charging a full instalment there
    // would overstate both the total paid and the interest by up to one month.
    const payment = Math.min(input.payment, balance + interest);
    const principal = payment - interest;

    balance = Math.max(0, balance - principal);
    totalInterest += interest;
    totalPaid += payment;

    rows.push({
      n,
      due: addMonths(input.from, n - 1),
      payment,
      interest,
      principal,
      balance,
    });
  }

  const cleared = balance <= 0.005;

  return {
    rows,
    months: cleared ? rows.length : null,
    payoffDate: cleared && rows.length > 0 ? rows[rows.length - 1].due : null,
    totalInterest,
    totalPaid,
    cleared,
    monthlyRate,
    underwater: false,
  };
}

/** What one extra amount per month buys: months off the term and interest never
 *  paid. Both halves — "18 months sooner" and "4,100 saved" persuade different
 *  people, and the second is the one §6 says is the only part that was ever
 *  spending. */
export function extraPayment(input: {
  balance: number;
  apr: number;
  payment: number;
  extra: number;
  from: CivilDate;
}): { base: Amortization; withExtra: Amortization; monthsSaved: number | null; interestSaved: number } {
  const base = amortize(input);
  const withExtra = amortize({ ...input, payment: input.payment + input.extra });

  return {
    base,
    withExtra,
    monthsSaved:
      base.months !== null && withExtra.months !== null ? base.months - withExtra.months : null,
    interestSaved: base.totalInterest - withExtra.totalInterest,
  };
}

/** `0.0499` and `4.99` both mean 4.99%. Nothing writes this column yet, so
 *  both are accepted and normalised to a fraction rather than assumed. */
export function normaliseApr(apr: number): number {
  if (!Number.isFinite(apr) || apr <= 0) return 0;
  return apr > 1 ? apr / 100 : apr;
}
