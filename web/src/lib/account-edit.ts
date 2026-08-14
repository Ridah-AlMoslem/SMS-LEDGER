/**
 * Editing an account by hand — the rules, with no database and no JSX.
 *
 * Two things make this more than a form.
 *
 * **A balance is not a field you can set.** `recompute_balances` in the parser
 * (api/db.py) derives every balance as `opening_balance + Σ(posted legs)` on
 * every tick, deliberately: messages arrive out of order and replay is a design
 * requirement (§3.1), so an incremented balance would drift and a written one
 * would be overwritten within the minute. Typing a new balance therefore has to
 * *book the difference* as a transaction. That leg is what makes the edit
 * survive the next tick, and it is also what the ledger shows — the correction
 * is an event with a date and an amount, not a silent overwrite of history.
 *
 * **Some fields decide the sign of net worth.** §3.3a: on a credit card the
 * stored figure is available credit, and reading it as debt turns a ~4.4k
 * liability into a ~9.6k asset. So `is_liability` is derived from the type
 * rather than typed in, and `available_credit` without a credit limit is
 * refused outright — `toView()` silently falls back to treating the figure as
 * debt when the limit is null, which is the exact inversion §3.3a warns about.
 *
 * All of it is pure, so `npm run test:account-edit` can hold it to account.
 */

import { TYPE_LABELS, money } from "./accounts.ts";

/** The fields a person is allowed to change. Everything else is either
 *  derived (`is_liability`), an identifier the parser addresses accounts by
 *  (`slug`, `institution`), or derived from the ledger (`current_balance`). */
export type AccountDraft = {
  name: string;
  type: string;
  balanceSemantics: string;
  reconcilable: boolean;
  creditLimit: string | null;
  statementDay: number | null;
  dueDay: number | null;
  isProfitBearing: boolean;
  profitPayoutDay: number | null;
};

/** A draft plus the fields the edit reads but does not set directly. */
export type AccountState = AccountDraft & {
  isLiability: boolean;
  currentBalance: string;
};

/** §4 — "is_liability (derived from type)". Typing it in separately is how a
 *  card ends up counted as an asset. */
const LIABILITY_TYPES = new Set(["credit_card", "loan"]);

export function isLiabilityFor(type: string): boolean {
  return LIABILITY_TYPES.has(type);
}

export const ACCOUNT_TYPES = Object.keys(TYPE_LABELS);

/**
 * Force the dependent fields into agreement with the type.
 *
 * Only a credit card reports available credit, so changing a card to anything
 * else has to take the inverted semantics with it. Leaving
 * `balance_semantics = 'available_credit'` on a savings account would make
 * `toView()` compute `debt = limit − balance` on money you actually hold.
 */
export function normalise(draft: AccountDraft): AccountDraft {
  const card = draft.type === "credit_card";
  return {
    ...draft,
    name: draft.name.trim(),
    balanceSemantics: card ? draft.balanceSemantics : "balance",
    creditLimit: card ? draft.creditLimit : null,
    statementDay: card ? draft.statementDay : null,
    dueDay: card ? draft.dueDay : null,
    profitPayoutDay: draft.isProfitBearing ? draft.profitPayoutDay : null,
  };
}

/** null when the draft is storable. A message when it is not. */
export function validate(draft: AccountDraft, targetBalance: string | null): string | null {
  if (!draft.name.trim()) return "An account needs a name.";
  if (!TYPE_LABELS[draft.type]) return `Unknown account type "${draft.type}".`;

  if (draft.balanceSemantics !== "balance" && draft.balanceSemantics !== "available_credit") {
    return `Unknown balance semantics "${draft.balanceSemantics}".`;
  }

  if (draft.creditLimit !== null && !isPositiveAmount(draft.creditLimit)) {
    return "The credit limit must be a positive amount.";
  }

  // The §3.3a guard. Without a limit there is nothing to subtract the reported
  // figure from, and the available credit gets read straight back as debt.
  if (draft.balanceSemantics === "available_credit" && !isPositiveAmount(draft.creditLimit)) {
    return "A card whose balance means available credit needs a credit limit — debt is limit minus balance, and without the limit the available credit is read as debt.";
  }

  for (const [value, label] of [
    [draft.statementDay, "Statement day"],
    [draft.dueDay, "Payment due day"],
    [draft.profitPayoutDay, "Profit payout day"],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 28)) {
      return `${label} must be between 1 and 28 — a 29th, 30th or 31st does not occur every month.`;
    }
  }

  if (targetBalance !== null && parseAmount(targetBalance) === null) {
    return "The balance must be a number with at most two decimals.";
  }

  return null;
}

/* ------------------------------------------------------------------ money */

/**
 * Amounts are compared and subtracted in halalas.
 *
 * `9610.09 − 9500.00` in floating point is `110.09000000000015`, and NUMERIC
 * (14,2) would store the rounded figure while the ledger leg carried the
 * remainder — a one-halala drift that raises a reconciliation alert for a
 * correction that was exactly right.
 */
export function parseAmount(input: string | number | null): number | null {
  if (input === null) return null;
  const text = String(input).replace(/[\s,٬]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

export function formatAmount(halalas: number): string {
  return (halalas / 100).toFixed(2);
}

function isPositiveAmount(value: string | null): boolean {
  const parsed = parseAmount(value);
  return parsed !== null && parsed > 0;
}

/** `money()` prints the magnitude and leaves the sign to the caller, the way
 *  the account rows do. A balance can legitimately be negative — an overdrawn
 *  current account — and a description that drops the minus describes the
 *  opposite correction. */
function signed(halalas: number): string {
  return (halalas < 0 ? "−" : "") + money(halalas / 100);
}

export type Adjustment = {
  direction: "credit" | "debit";
  /** Always positive, two decimals. The direction carries the sign. */
  amount: string;
  description: string;
};

/**
 * The ledger leg that makes a typed balance true.
 *
 * The sign rule is the parser's, unchanged: credit adds, debit subtracts, for
 * assets *and* for credit cards. On a card the stored figure is available
 * credit, so "I have more available than you think" is a credit and genuinely
 * means less debt — the interpretation differs, the arithmetic does not.
 *
 * Returns null when the balance did not move; there is nothing to book, and
 * booking a zero leg would put an empty row in the ledger for every rename.
 */
export function adjustmentFor(
  current: string,
  target: string,
  semantics: string,
): Adjustment | null {
  const from = parseAmount(current);
  const to = parseAmount(target);
  if (from === null || to === null) return null;

  const delta = to - from;
  if (delta === 0) return null;

  const noun = semantics === "available_credit" ? "Available credit" : "Balance";

  return {
    direction: delta > 0 ? "credit" : "debit",
    amount: formatAmount(Math.abs(delta)),
    description: `${noun} set to ${signed(to)} (was ${signed(from)})`,
  };
}

/* ------------------------------------------------------------------- diff */

export type Change = { from: string | null; to: string | null };

/** Field → label, in the order an edit record reads best. `balance` is not
 *  here: it is recorded by the adjustment leg, which carries the amount, the
 *  date and the account of its own accord. */
const LABELS: Record<string, string> = {
  name: "Name",
  type: "Type",
  isLiability: "Counts as debt",
  balanceSemantics: "Balance means",
  creditLimit: "Credit limit",
  statementDay: "Statement day",
  dueDay: "Payment due day",
  isProfitBearing: "Profit-bearing",
  profitPayoutDay: "Profit payout day",
  reconcilable: "Reconcilable",
};

export function fieldLabel(field: string): string {
  return LABELS[field] ?? field;
}

/** How a stored value reads in an edit record. Nulls stay null so "unset →
 *  set" is distinguishable from "0 → 5". */
export function display(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (field === "type") return TYPE_LABELS[String(value)] ?? String(value);
  if (field === "balanceSemantics") {
    return value === "available_credit" ? "available credit" : "balance";
  }
  if (field === "creditLimit") {
    const parsed = parseAmount(String(value));
    return parsed === null ? String(value) : money(parsed / 100);
  }
  return String(value);
}

/**
 * What actually changed, as `{field: {from, to}}`.
 *
 * Compared field by field rather than by stringifying both sides: a form
 * round-trips `"14000.00"` as `"14000"`, and an edit record claiming the credit
 * limit changed every time you renamed the account is an audit trail nobody
 * reads twice.
 */
export function diff(before: AccountState, after: AccountState): Record<string, Change> {
  const changed: Record<string, Change> = {};

  for (const field of Object.keys(LABELS)) {
    const from = before[field as keyof AccountState] ?? null;
    const to = after[field as keyof AccountState] ?? null;

    const same =
      field === "creditLimit"
        ? parseAmount(from as string | null) === parseAmount(to as string | null)
        : from === to;

    if (!same) changed[field] = { from: display(field, from), to: display(field, to) };
  }

  return changed;
}
