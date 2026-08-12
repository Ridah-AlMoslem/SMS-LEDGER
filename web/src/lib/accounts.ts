/**
 * Account presentation logic (SPEC §3.3, §11.4).
 *
 * Kept out of the components because the credit-card rule is the single
 * easiest thing in this system to get backwards, and a rule buried in JSX is a
 * rule nobody can test.
 */

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
};

export type Alert = {
  accountId: string;
  computedBalance: string;
  reportedBalance: string;
  delta: string;
  detectedAt: Date;
};

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

const AS_OF = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Riyadh",
});

export function asOf(d: Date | null): string | null {
  return d ? AS_OF.format(d) : null;
}
