/**
 * Net worth over time, from `balance_snapshots` (SPEC §11.1 chart 4).
 *
 * The arithmetic is one line — assets minus liabilities — and the whole
 * difficulty is in the word "liabilities". A credit card whose bank reports
 * *available credit* contributes `limit − available` as debt; read the stored
 * figure as the debt itself and a 3,411 liability becomes a 10,588 asset, a
 * ~14,000 swing on one account (§3.3a).
 *
 * So this module does not know that rule. It calls `toView()` from
 * `lib/accounts.ts`, which already encodes it and already has tests, with the
 * account's balance swapped for its balance *on that day*. There is exactly one
 * implementation of the credit-card rule in this codebase and this is not a
 * second one.
 */

import { type AccountRow, toView } from "./accounts.ts";
import { type CivilDate, addDays } from "./periods.ts";

export type Snapshot = {
  accountId: string;
  /** Local civil date of the snapshot — already bucketed by `local_date()`. */
  day: CivilDate;
  balance: number;
};

export type NetWorthPoint = { day: CivilDate; value: number };

/**
 * An account plus the one column the list view has no use for.
 *
 * `opening_balance` is what an account was worth before any message arrived
 * (§9.2), and it is the only defensible value for a day earlier than the first
 * snapshot. Declared here rather than widened into `AccountRow` because no
 * other screen needs it and a type that carries every column is a type that
 * stops saying what a screen actually reads.
 */
export type NetWorthAccount = AccountRow & { openingBalance?: string | number | null };

/**
 * Daily net worth across `[from, to]`.
 *
 * Balances are carried forward: a snapshot is what the bank last said, and an
 * account says nothing on the days between messages. Carrying forward is the
 * only honest reading — interpolating would invent movements that no message
 * recorded, and dropping the account for those days would make net worth dip
 * every time a bank went quiet.
 *
 * An account with no snapshot at or before a day contributes its
 * `opening_balance` (§9.2), which is the only figure known to be true before
 * any message arrived. Accounts that never report — SAIB states no balance in
 * any message (§3.3b) — therefore sit at a constant, which is right: they add
 * level to the series without adding shape they cannot support.
 */
export function netWorthSeries(
  accounts: NetWorthAccount[],
  snapshots: Snapshot[],
  from: CivilDate,
  to: CivilDate,
): NetWorthPoint[] {
  if (accounts.length === 0 || to < from) return [];

  // Latest-first per account, so the fold below can take the first hit.
  const byDay = new Map<string, Map<string, number>>();
  let seeded = new Map<string, number>();

  for (const account of accounts) seeded.set(account.id, Number(account.openingBalance ?? 0));

  for (const s of [...snapshots].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    if (s.day < from) {
      // Everything before the window collapses into the opening position.
      seeded.set(s.accountId, s.balance);
      continue;
    }
    if (s.day > to) continue;
    let day = byDay.get(s.day);
    if (!day) byDay.set(s.day, (day = new Map()));
    day.set(s.accountId, s.balance);
  }

  const balances = new Map(seeded);
  const series: NetWorthPoint[] = [];

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const updates = byDay.get(day);
    if (updates) for (const [id, balance] of updates) balances.set(id, balance);

    let net = 0;
    for (const account of accounts) {
      const balance = balances.get(account.id);
      if (balance === undefined) continue;
      // The one call that matters: `toView` applies available_credit semantics.
      net += toView({ ...account, currentBalance: balance.toFixed(2) }).net;
    }
    series.push({ day, value: net });
  }

  seeded = new Map(); // release
  return series;
}

/**
 * Whether the series carries any real history.
 *
 * A flat line drawn from a single opening balance is not a trend, and drawing
 * it as one implies months of stability that were never observed. The strip
 * shows the sparkline only when at least two distinct values exist.
 */
export function hasShape(series: NetWorthPoint[]): boolean {
  if (series.length < 2) return false;
  const first = series[0].value;
  return series.some((p) => p.value !== first);
}
