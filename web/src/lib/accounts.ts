/**
 * Account presentation logic (SPEC §3.3, §11.4).
 *
 * Kept out of the components because the credit-card rule is the single
 * easiest thing in this system to get backwards, and a rule buried in JSX is a
 * rule nobody can test.
 */

import { dayMonthYear } from "./format.ts";

export type AccountRow = {
  id: string;
  slug: string;
  name: string;
  institution: string;
  type: string;
  isLiability: boolean;
  balanceSemantics: string;
  reconcilable: boolean;
  currentBalance: string;
  creditLimit: string | null;
  isProfitBearing: boolean;
  balanceAsOf: Date | null;
  sortOrder: number;
  /** Carried so the edit sheet can show them. Nothing on this screen displays
   *  them; a card's dates belong in the sheet where they can be corrected. */
  statementDay: number | null;
  dueDay: number | null;
  profitPayoutDay: number | null;
};

export type Alert = {
  accountId: string;
  computedBalance: string;
  reportedBalance: string;
  delta: string;
  detectedAt: Date;
};

/* ---------------------------------------------- reconciliation state (§3.3b) */

/**
 * §3.3b — "reconciliation is a *capability flag*, not a guarantee", and the
 * table there is per-account: AlRajhi full, Barq partial, STC weak, SAIB none.
 *
 * Measured rather than hardcoded. Writing `institution === "SAIB" → none` into
 * the UI would state a fact about the templates as though it were a fact about
 * the account, and it would go quietly stale the day a bank changes a message
 * or a new template starts carrying a balance. What is actually knowable is in
 * the ledger: every leg the parser wrote carries `reported_balance`, non-null
 * exactly when the message printed one.
 */
export type ReconciliationLevel = "full" | "partial" | "weak" | "none";

export type Coverage = {
  /** Parsed legs on this account in the measured window. */
  messages: number;
  /** How many of them carried a balance the bank had printed. */
  withBalance: number;
  /** When the bank last stated one. */
  lastReportedAt: Date | null;
  /** When a person last entered one by hand — §3.3b's third compensating
   *  control, and the only anchor a balance-less account will ever have. */
  lastManualAt: Date | null;
};

export const NO_COVERAGE: Coverage = {
  messages: 0,
  withBalance: 0,
  lastReportedAt: null,
  lastManualAt: null,
};

export type Reconciliation = {
  level: ReconciliationLevel;
  /** Short, for a badge. Never reads as "verified" below `full`. */
  label: string;
  /** The sentence beneath it. Always says what is *not* checked. */
  detail: string;
  /** Share of messages carrying a balance, 0–1. null when nothing measured. */
  share: number | null;
  coverage: Coverage;
};

/** Every message states one — AlRajhi's card, on both purchases and payments. */
const FULL_AT = 0.9;
/** Some template does, routinely — Barq prints one on purchases only. */
const PARTIAL_AT = 0.35;

/**
 * Below this, a share is an accident rather than a rate.
 *
 * Three legs of which three carried a balance is 100% coverage and no evidence
 * at all, and "full" printed against it is precisely the claim §3.3b forbids:
 * an account that has not earned a clean reconciliation must never look like
 * one that has. So a small sample is capped at `weak` and the sentence says how
 * small.
 */
const MIN_SAMPLE = 5;

export function reconciliationOf(
  account: { reconcilable: boolean },
  coverage: Coverage = NO_COVERAGE,
): Reconciliation {
  const anchored = coverage.lastManualAt
    ? " A balance you entered by hand anchors it from that point forward."
    : " Enter a balance by hand to anchor it from today.";

  // The bank never prints one. Not a coverage measurement at all — the flag
  // says so up front, and SAIB holds the current account, the savings and the
  // salary (§3.3b).
  if (!account.reconcilable) {
    return {
      level: "none",
      label: "Not checked against the bank",
      detail: `No message from this bank states a balance, so nothing here has been verified against it.${anchored}`,
      share: null,
      coverage,
    };
  }

  if (coverage.messages === 0) {
    return {
      level: "none",
      label: "Nothing to check yet",
      detail: `No messages have arrived for this account, so there is nothing to compare a balance against.${anchored}`,
      share: null,
      coverage,
    };
  }

  const share = coverage.withBalance / coverage.messages;

  if (coverage.withBalance === 0) {
    return {
      level: "none",
      label: "Not checked against the bank",
      detail: `None of the last ${coverage.messages} messages carried a balance, so the figure above is derived from message flow alone.${anchored}`,
      share,
      coverage,
    };
  }

  const measured: ReconciliationLevel =
    share >= FULL_AT ? "full" : share >= PARTIAL_AT ? "partial" : "weak";

  // Not enough messages to call a share a rate. Capped, and the reason stated.
  const level: ReconciliationLevel =
    coverage.messages < MIN_SAMPLE && measured !== "weak" ? "weak" : measured;

  const counted = `${coverage.withBalance} of the last ${coverage.messages} messages stated a balance`;

  if (level === "full") {
    return {
      level,
      label: "Checked against the bank",
      detail: `${counted}, and the ledger agrees with every one of them.`,
      share,
      coverage,
    };
  }

  if (level === "partial") {
    return {
      level,
      label: "Partly checked",
      detail: `${counted}. The rest are unverified — a missed message between two of them would not show up here.`,
      share,
      coverage,
    };
  }

  return {
    level,
    label: "Rarely checked",
    detail:
      coverage.messages < MIN_SAMPLE
        ? `Only ${coverage.messages} messages so far, ${coverage.withBalance} with a balance — too few to call this verified either way.${anchored}`
        : `${counted}. Long stretches of this account have never been checked against anything.${anchored}`,
    share,
    coverage,
  };
}

export type AccountView = AccountRow & {
  /** Signed contribution to net worth. Negative for anything owed. */
  net: number;
  /** Amount owed, for liabilities. null for assets. */
  debt: number | null;
  /** Spendable headroom on a credit card. null otherwise. */
  available: number | null;
  limit: number | null;
  /** 0–1. null when there is no limit to measure against. */
  utilisation: number | null;
};

/**
 * The rule that matters:
 *
 *   balance_semantics = 'available_credit' → the stored figure is what you can
 *   still SPEND, not what you owe. Purchases decrease it; payments increase it.
 *   Debt is limit − balance.
 *
 * Reading it the other way round turns a ~4.4k liability into a ~9.6k asset —
 * a swing of roughly the full credit limit, on one account (§3.3a).
 */
export function toView(a: AccountRow): AccountView {
  const balance = Number(a.currentBalance);
  const limit = a.creditLimit === null ? null : Number(a.creditLimit);

  if (a.isLiability && a.balanceSemantics === "available_credit" && limit !== null) {
    const debt = limit - balance;
    return {
      ...a,
      net: -debt,
      debt,
      available: balance,
      limit,
      utilisation: limit > 0 ? debt / limit : null,
    };
  }

  if (a.isLiability) {
    return { ...a, net: -balance, debt: balance, available: null, limit, utilisation: null };
  }

  return { ...a, net: balance, debt: null, available: null, limit: null, utilisation: null };
}

export type Group = {
  institution: string;
  label: string;
  accounts: AccountView[];
  net: number;
};

const INSTITUTION_LABELS: Record<string, string> = {
  AlRajhiBank: "AlRajhi Bank",
  "barq app": "Barq",
  SAIB: "SAIB",
  "STC Bank": "STC Bank",
};

export const TYPE_LABELS: Record<string, string> = {
  checking: "Current account",
  savings: "Savings",
  credit_card: "Credit card",
  wallet: "Wallet",
  cashback_wallet: "Cashback wallet",
  loan: "Loan",
  cash: "Cash",
};

export function groupByInstitution(rows: AccountRow[]): Group[] {
  const groups = new Map<string, AccountView[]>();

  for (const row of rows) {
    const view = toView(row);
    const existing = groups.get(row.institution);
    if (existing) existing.push(view);
    else groups.set(row.institution, [view]);
  }

  return [...groups.entries()]
    .map(([institution, accounts]) => ({
      institution,
      label: INSTITUTION_LABELS[institution] ?? institution,
      accounts: accounts.sort((x, y) => x.sortOrder - y.sortOrder),
      net: accounts.reduce((sum, x) => sum + x.net, 0),
    }))
    // Largest holdings first, so the accounts that matter are at the top.
    .sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
}

export function totals(groups: Group[]) {
  const accounts = groups.flatMap((g) => g.accounts);
  const assets = accounts.filter((a) => a.net > 0).reduce((s, a) => s + a.net, 0);
  const debt = accounts.filter((a) => a.net < 0).reduce((s, a) => s - a.net, 0);
  return { assets, debt, netWorth: assets - debt };
}

const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(n: number): string {
  return MONEY.format(Math.abs(n));
}

export function asOf(d: Date | null): string | null {
  return d ? dayMonthYear(d) : null;
}
