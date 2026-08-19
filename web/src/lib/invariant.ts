/**
 * The master invariant (SPEC §6), on screen rather than only in tests.
 *
 * ```
 * Δ net worth over any period  ==  income − expense
 * ```
 *
 * §6: "If this identity fails, exactly one of the rules above is being applied
 * wrongly. Assert it in tests, and surface it on the dashboard as a health
 * check — it catches classification errors that no individual balance
 * reconciliation would."
 *
 * That last clause is the whole reason this exists next to the per-account
 * reconciliation on the same page. Reconciliation compares one account against
 * the balance its bank printed, so it catches a *missing* or *duplicated*
 * message. It cannot catch a message that was received exactly once, moved the
 * balance by exactly the right amount, and was filed under the wrong type — a
 * card payment read as a purchase reconciles perfectly on both accounts and
 * overstates spending by the full amount. §6 quantifies the family: drop one
 * clause from the expense rule and the worked example reports 7,600 instead of
 * 1,100.
 *
 * ## Both sides come from the ledger's own legs
 *
 * Net worth here is NOT the sum of the balances the banks last reported. It is
 * what `recompute_balances` derives from the posted legs (`opening_balance + Σ`),
 * rolled back over the cycle. That is deliberate: if the net-worth side were
 * read from bank-reported balances, a missed message would fail this check —
 * and a missed message is precisely what per-account reconciliation already
 * reports, with the account named. Deriving both sides from the same legs
 * leaves classification as the only thing that can break it, which is what
 * makes a failure here mean something specific.
 *
 * ## Two reconciling items, named rather than hidden
 *
 * A ledger in real use has two legitimate reasons for the two sides to differ,
 * and an alarm that fires on both is an alarm that gets ignored — the same
 * reasoning that puts `QUEUE_STALL_MS` at fifteen minutes rather than two.
 *
 *   - **Adjustments** (§3.3b). A balance corrected by hand books an
 *     `adjustment` leg, always `excluded_from_analytics`: it moves net worth
 *     and is neither income nor spending, because it is money that was already
 *     there and unaccounted for. It belongs on the net-worth side only.
 *   - **Legs not yet posted.** `IS_EXPENSE` excludes only `declined`, so a
 *     `pending` pre-auth (§7.2) counts as expense the moment it arrives, while
 *     `recompute_balances` counts posted legs alone. The two sides disagree by
 *     that amount until it settles — correctly, on both counts.
 *
 * So the check is on what is left after both are accounted for. Each is
 * reported as its own figure, because "the invariant is off by 340 and 340 of
 * it is a pre-auth" and "the invariant is off by 340" are different messages.
 *
 * Pure, and imports `toView` rather than reimplementing it: the available-credit
 * rule is the single easiest thing in this system to get backwards, and reading
 * it the wrong way round moves net worth by a whole credit limit (§3.3a). There
 * is one implementation of that rule and this is not a second one.
 */

import { type AccountRow, toView } from "./accounts.ts";

/**
 * One account's signed movement across the cycle, in balance terms — credit
 * adds, debit subtracts, exactly as `recompute_balances` sums it.
 *
 * These are movements, not balances. The account's *current* balance is on the
 * `AccountRow`; subtracting `posted` from it gives what the ledger says the
 * balance was when the cycle opened.
 */
export type CycleMovement = {
  accountId: string;
  /** Every posted leg. This is Δ balance for the cycle, by definition. */
  posted: number;
  /** The `excluded_from_analytics` subset of `posted` — hand adjustments. */
  excluded: number;
  /** Legs §6 counts but no balance reflects yet: `pending` and `reversed`. */
  unposted: number;
};

export type InvariantCheck = {
  /** Δ net worth the ledger's own legs produce over the cycle. */
  observed: number;
  /** income − expense over the same cycle, from `v_categorized_amounts`. */
  expected: number;
  income: number;
  expense: number;
  /** Net worth moved by hand-booked adjustments (§3.3b). */
  adjustments: number;
  /** Net worth that pending/reversed legs will move once they post (§7.2). */
  unposted: number;
  /** What neither side can account for. This is the number that matters. */
  unexplained: number;
  ok: boolean;
  /** True when there is nothing in the cycle yet — pass, but say so. */
  empty: boolean;
};

/**
 * Halalas. The same tolerance `reconcile()` uses in `api/db.py`, so a
 * difference too small to raise a drift alert is too small to fail this.
 */
export const TOLERANCE = 0.01;

/** Net worth with each account's balance shifted by `delta`. `toView` applies
 *  the §3.3a rule; the shift is linear through it, which is what lets the two
 *  reconciling items below be measured as differences of this function. */
function netWorthShiftedBy(accounts: AccountRow[], delta: Map<string, number>): number {
  let total = 0;
  for (const account of accounts) {
    const moved = Number(account.currentBalance) + (delta.get(account.id) ?? 0);
    total += toView({ ...account, currentBalance: moved.toFixed(2) }).net;
  }
  return total;
}

const shift = (
  movements: CycleMovement[],
  pick: (m: CycleMovement) => number,
  sign: 1 | -1,
): Map<string, number> =>
  new Map(movements.map((m) => [m.accountId, sign * pick(m)]));

/**
 * `accounts` must be every account the legs can touch, not just the active
 * ones. Income and expense are aggregated across the whole ledger, so a
 * net-worth side that quietly omitted a deactivated account holding this
 * cycle's legs would report a classification error that is really a filter.
 */
export function masterInvariant(input: {
  accounts: AccountRow[];
  movements: CycleMovement[];
  income: number;
  expense: number;
  tolerance?: number;
}): InvariantCheck {
  const { accounts, movements, income, expense } = input;
  const tolerance = input.tolerance ?? TOLERANCE;

  const none = new Map<string, number>();
  const closing = netWorthShiftedBy(accounts, none);

  // Roll the cycle back off the balances: current − Σ(this cycle's posted legs)
  // is what the ledger says net worth was when the cycle opened.
  const opening = netWorthShiftedBy(accounts, shift(movements, (m) => m.posted, -1));
  const observed = closing - opening;

  // Each reconciling item as the net-worth difference it makes, measured
  // through `toView` for the same reason the totals are: a liability moves net
  // worth the other way, and the sign rule must not be retyped here.
  const adjustments =
    closing - netWorthShiftedBy(accounts, shift(movements, (m) => m.excluded, -1));
  const unposted =
    netWorthShiftedBy(accounts, shift(movements, (m) => m.unposted, 1)) - closing;

  const expected = income - expense;

  // observed == expected + adjustments − unposted, when nothing is misfiled.
  const unexplained = observed - expected - adjustments + unposted;

  return {
    observed,
    expected,
    income,
    expense,
    adjustments,
    unposted,
    unexplained,
    ok: Math.abs(unexplained) <= tolerance,
    empty: income === 0 && expense === 0 && movements.length === 0,
  };
}

/**
 * What a failure most likely is, in one line.
 *
 * Deliberately a hypothesis and not a diagnosis: the sign narrows it to one of
 * two families and the panel says which, because "the invariant failed by
 * 800.00" sends you to read §6 from the top, and "spending is overstated by
 * 800.00 — something that only moved money between your own accounts is being
 * counted as spending" sends you to the ledger with a filter in mind.
 */
export function explain(check: InvariantCheck): string {
  const off = Math.abs(check.unexplained).toFixed(2);

  if (check.ok) return "Every leg this cycle is classified consistently.";

  return check.unexplained > 0
    ? `Net worth rose ${off} more than income minus spending accounts for. Either spending is overstated — a transfer, card payment or loan principal being counted as an expense (§6) — or income arrived that was never classified as income.`
    : `Net worth rose ${off} less than income minus spending accounts for. Either income is overstated — most often a transfer in from your own account read as income (§8.2) — or money left without being recorded as spending.`;
}
