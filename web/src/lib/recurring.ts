/**
 * Recurring-series detection — SPEC §11.3.
 *
 * "Typically the highest-ROI insight in a personal finance app", and the one
 * most easily discredited: a bills calendar containing one prediction that was
 * never going to happen is a calendar nobody reads again. So the rules about
 * what may NOT be detected are as load-bearing here as the periodicity maths,
 * and they are stated first.
 *
 * **Savings transfers are never fed to the detector.** They follow no routine,
 * so any series found in them is noise — and worse than noise: a predicted
 * internal transfer puts money in the upcoming-bills calendar that was never
 * leaving. Every internal transfer is refused by `isDetectable`, and the query
 * that gathers occurrences (`db/recurring.ts`) refuses them again in SQL. Two
 * gates for one rule, because the failure is silent and the fix is a `NOT`.
 *
 * **Profit payouts are detected on cadence only, never amount.** The amount
 * varies every cycle by nature. Amount is not part of the grouping key for any
 * series — grouping is (merchant identity, account, kind), so periodicity is the
 * only thing that ever forms a series — but for profit the amount is excluded
 * from the *confidence* too, and `priceChangeOf` returns null for it outright.
 * Without that last part a profit series fires a spurious price-change alert
 * every single month, which is exactly the noise §11.3 calls out.
 *
 * Pure arithmetic over civil dates. No database, no `Date.now()`, no `next/*`:
 * `scripts/verify-recurring.mjs` runs every rule below directly, and the
 * nightly pass in `db/recurring.ts` is the only thing that supplies rows.
 */

import { type CivilDate, addDays, addMonths, diffDays } from "./periods.ts";

export type RecurringKind = "subscription" | "bill" | "salary" | "profit";
export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

/**
 * `transactions.type` → the kind of series it could belong to.
 *
 * Everything absent from this map is refused, and each absence is a decision:
 *
 *   - `transfer` — §11.3's first exclusion. A savings transfer follows no
 *     routine, and a false prediction would pollute the calendar with money
 *     that was never leaving. `card_payment` is the same shape: it settles
 *     spending already counted at the purchase (§6).
 *   - `loan_payment` — genuinely recurring, and deliberately not here. A loan
 *     payment books two legs on two accounts (§6), which would form two series
 *     for one movement and bill you twice in the calendar. Loans have their own
 *     schedule and their own screen (§11.4), derived from the amortization
 *     rather than guessed from history.
 *   - `withdrawal` — cash coming out is the expense (§8.1), but it is not a
 *     charge anyone is going to send you again on a schedule.
 *   - `adjustment`, `refund` — a correction and a reversal. Neither recurs, and
 *     both are already excluded from analytics or netted against their original.
 */
export const DETECTABLE_TYPES: Record<string, RecurringKind> = {
  purchase: "subscription",
  bill_payment: "bill",
  fee: "bill",
  income: "salary",
  profit: "profit",
};

export function kindOfType(type: string): RecurringKind | null {
  return DETECTABLE_TYPES[type] ?? null;
}

/** One charge, as the detector sees it. */
export type Occurrence = {
  transactionId: string;
  /** `transactions.type`. Mapped to a kind by `kindOfType`. */
  type: string;
  /**
   * Stable identity of the other side: a merchant id where one was resolved,
   * otherwise a normalised biller or raw merchant string. Null is not
   * detectable — an unnamed charge has nothing to recur *as*.
   */
  merchantKey: string | null;
  merchantId: string | null;
  /** What to call it on screen. */
  label: string;
  accountId: string | null;
  amount: number;
  day: CivilDate;
  isInternalTransfer: boolean;
  excludedFromAnalytics: boolean;
  state: string;
};

/**
 * The exclusion gate, in one place (§11.3).
 *
 * `state` must be `posted`: a declined authorisation never happened, and a
 * pending one has not settled, so neither is evidence about a rhythm.
 */
export function isDetectable(o: Occurrence): boolean {
  if (o.isInternalTransfer) return false;
  if (o.excludedFromAnalytics) return false;
  if (o.state !== "posted") return false;
  if (!o.merchantKey) return false;
  return kindOfType(o.type) !== null;
}

/* --------------------------------------------------------------- statistics */

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Mean absolute deviation from the median.
 *
 * Not the standard deviation: one skipped or double charge is a single large
 * outlier, and a squared error lets that one event decide the confidence of a
 * series with two years of perfect history behind it.
 */
function meanAbsoluteDeviation(values: number[], centre: number): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + Math.abs(v - centre), 0) / values.length;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/* ----------------------------------------------------------------- cadence */

type CadenceSpec = { cadence: Cadence; days: number; tolerance: number };

/**
 * The cadences worth predicting, with how far a median gap may sit from the
 * ideal and still count.
 *
 * §11.3 — "Detect **weekly and biweekly** cadences, not just monthly — these
 * only become visible once the weekly grain exists." The bands do not overlap,
 * and the gaps between them are deliberate: a 21-day rhythm matches nothing and
 * is left alone rather than rounded into a monthly series that will then be
 * wrong every third week.
 *
 * Monthly is 30.44 (365.25 ÷ 12) rather than 30, and its band spans 25–35 so a
 * charge on the 31st followed by one on the 28th of February is still monthly.
 */
const CADENCES: CadenceSpec[] = [
  { cadence: "weekly", days: 7, tolerance: 2 },
  { cadence: "biweekly", days: 14, tolerance: 3 },
  { cadence: "monthly", days: 30.44, tolerance: 5 },
  { cadence: "quarterly", days: 91.31, tolerance: 12 },
  { cadence: "yearly", days: 365.25, tolerance: 30 },
];

export function cadenceOf(medianGapDays: number): CadenceSpec | null {
  return (
    CADENCES.find((c) => Math.abs(medianGapDays - c.days) <= c.tolerance) ?? null
  );
}

/** The next occurrence after `from`, at this cadence.
 *
 *  Month-based cadences step by months, not by their average length in days:
 *  a rent charge on the 28th must land on the 28th next month, and adding 30.44
 *  days would walk it backwards through the calendar one day at a time. */
export function nextAfter(from: CivilDate, cadence: Cadence): CivilDate {
  switch (cadence) {
    case "weekly":
      return addDays(from, 7);
    case "biweekly":
      return addDays(from, 14);
    case "monthly":
      return addMonths(from, 1);
    case "quarterly":
      return addMonths(from, 3);
    case "yearly":
      return addMonths(from, 12);
  }
}

/* ------------------------------------------------------------ price changes */

export type PriceChange = {
  /** What it used to cost — the median of everything before the change. */
  from: number;
  /** What it costs now. */
  to: number;
  /** Signed. Positive is an increase. */
  delta: number;
  /** Signed fraction: 0.12 is a 12% rise. */
  fraction: number;
  /** The day the new amount was first charged. */
  at: CivilDate;
};

/** Below this the change is rounding, a partial month, or a currency wobble on
 *  a foreign-billed subscription — not a price rise. Both floors must be
 *  cleared: 5% of 4.99 is noise, and 1.00 of 500 is noise too. */
const PRICE_CHANGE_FRACTION = 0.05;
const PRICE_CHANGE_ABSOLUTE = 1;

/**
 * §11.3 — "Price-increase flags on subscriptions — silent annual price bumps
 * are the main thing this catches."
 *
 * **Finds the change point first, then compares across it.** The obvious version
 * — latest amount against the median of everything before it — degrades exactly
 * where this feature is most useful: once a rise is a few months old, the median
 * "before" is a blend of both prices, so the reported old price is a number that
 * was never charged and the reported rise shrinks month by month until it
 * vanishes. Walking back to where the current price started instead gives the
 * price that was actually paid, the date it changed, and a delta that does not
 * decay.
 *
 * The medians on both sides of the change point are what keep one odd invoice —
 * a pro-rated month, a one-off add-on — from reading as a permanent rise.
 *
 * **Returns null for `profit`, always.** The amount of a profit payout varies
 * every cycle; a drift warning there fires monthly and means nothing, which is
 * the spurious alert §11.3 names.
 */
export function priceChangeOf(
  kind: RecurringKind,
  history: { amount: number; day: CivilDate }[],
): PriceChange | null {
  if (kind === "profit") return null;
  if (history.length < 3) return null;

  const ordered = [...history].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const latest = ordered[ordered.length - 1].amount;

  // "The same price" allows for a halala of rounding or a percent of FX drift on
  // a subscription billed abroad.
  const tolerance = Math.max(PRICE_CHANGE_ABSOLUTE / 2, Math.abs(latest) * 0.01);

  // The start of the run of charges at the current price.
  let change = ordered.length - 1;
  while (change > 0 && Math.abs(ordered[change - 1].amount - latest) <= tolerance) change--;

  // One price for the whole history. Nothing changed.
  if (change === 0) return null;

  const from = median(ordered.slice(0, change).map((h) => h.amount));
  const to = median(ordered.slice(change).map((h) => h.amount));

  if (from <= 0) return null;

  const delta = to - from;
  if (Math.abs(delta) < PRICE_CHANGE_ABSOLUTE) return null;

  const fraction = delta / from;
  if (Math.abs(fraction) < PRICE_CHANGE_FRACTION) return null;

  return { from, to, delta, fraction, at: ordered[change].day };
}

/**
 * How long a price change stays news.
 *
 * A year, because §11.3's target is the *annual* bump: anything shorter would
 * retire a yearly subscription's rise before its next charge arrives. Older
 * changes are still carried on the series row — the before-and-after is useful
 * context — they just stop leading the screen.
 */
export const PRICE_ALERT_DAYS = 365;

export function isRecentPriceChange(at: CivilDate | null, now: CivilDate): boolean {
  return at !== null && diffDays(at, now) <= PRICE_ALERT_DAYS;
}

/* ---------------------------------------------------------------- dormancy */

/**
 * §11.3 — "you haven't been charged for X in 3 months — cancelled?"
 *
 * Three intervals, not three calendar months, so the prompt scales with the
 * cadence: a monthly series goes quiet after ~91 days, which is the three
 * months the SPEC names, while a weekly one is flagged after three weeks and a
 * yearly one is not flagged for three years. A fixed 90 days would say nothing
 * about a weekly charge until it had been gone for thirteen cycles.
 */
export function isDormant(
  series: { lastSeen: CivilDate; intervalDays: number },
  now: CivilDate,
): boolean {
  return diffDays(series.lastSeen, now) > series.intervalDays * 3;
}

/** Days until the next charge. Negative when it is overdue, which is a fact
 *  worth printing rather than a date worth moving. */
export function daysAway(nextExpectedAt: CivilDate, now: CivilDate): number {
  return diffDays(now, nextExpectedAt);
}

/* ---------------------------------------------------------------- detection */

export type Detected = {
  /** `kind|merchant|account` — the identity a re-run recognises. */
  detectKey: string;
  label: string;
  kind: RecurringKind;
  merchantId: string | null;
  accountId: string | null;
  cadence: Cadence;
  /** The measured median gap, rounded to whole days. */
  intervalDays: number;
  amountAvg: number;
  amountLast: number;
  amountPrev: number | null;
  priceChangeAt: CivilDate | null;
  /** Only for month-based cadences: a weekly series has no day of month, and
   *  storing one invites a monthly reading of it. */
  dayOfMonth: number | null;
  firstSeen: CivilDate;
  lastSeen: CivilDate;
  occurrenceCount: number;
  nextExpectedAt: CivilDate;
  /** 0–1, three decimals — `recurring_series.confidence` is NUMERIC(4,3). */
  confidence: number;
  /** Every charge behind this series, for the link-back in
   *  `transactions.recurring_series_id` (§4). */
  transactionIds: string[];
};

/**
 * Two gaps is the minimum that can distinguish a rhythm from a coincidence.
 *
 * With one gap, every pair of charges 30 days apart is a "monthly
 * subscription" — including two unrelated visits to the same restaurant.
 */
export const MIN_OCCURRENCES = 3;

/** Below this a series is a guess, and a guess does not belong in a bills
 *  calendar. Confirming one by hand overrides this (see `db/recurring.ts`). */
export const CONFIDENCE_FLOOR = 0.4;

export function detectKeyOf(kind: RecurringKind, merchantKey: string, accountId: string | null) {
  return `${kind}|${merchantKey}|${accountId ?? ""}`;
}

/**
 * Group eligible occurrences by identity and measure each group's rhythm.
 *
 * Amount is not part of the key, on purpose and for two independent reasons:
 * §11.3 requires profit to be grouped on cadence alone, and a subscription that
 * has had a price rise would otherwise split into two series — losing exactly
 * the history that makes the rise visible.
 *
 * Takes no notion of "now", and needs none: what a series *is* depends only on
 * the charges behind it. Today decides whether it is overdue or dormant, and
 * that is asked separately, at render time, by `daysAway` and `isDormant` — so
 * a series does not change its own definition overnight.
 */
export function detectSeries(occurrences: Occurrence[]): Detected[] {
  const groups = new Map<string, Occurrence[]>();

  for (const o of occurrences) {
    if (!isDetectable(o)) continue;
    const kind = kindOfType(o.type);
    if (!kind || !o.merchantKey) continue;

    const key = detectKeyOf(kind, o.merchantKey, o.accountId);
    const bucket = groups.get(key);
    if (bucket) bucket.push(o);
    else groups.set(key, [o]);
  }

  const detected: Detected[] = [];

  for (const [detectKey, raw] of groups) {
    const series = measure(detectKey, raw);
    if (series) detected.push(series);
  }

  // Soonest first, then by confidence: the list this feeds is a calendar.
  return detected.sort((a, b) =>
    a.nextExpectedAt < b.nextExpectedAt
      ? -1
      : a.nextExpectedAt > b.nextExpectedAt
        ? 1
        : b.confidence - a.confidence,
  );
}

/**
 * Several charges from one merchant on one day are one occurrence.
 *
 * Two reasons, and the second is the important one. What a bills calendar
 * predicts is how much leaves on a day, so the day's total is the right figure
 * — and for a real subscription there is one charge and the total is it. But
 * also: two charges on the same day produce a zero gap, and a single zero drags
 * the median gap of a monthly series down far enough to match nothing at all.
 */
function collapseByDay(occurrences: Occurrence[]): {
  day: CivilDate;
  amount: number;
  transactionIds: string[];
}[] {
  const byDay = new Map<CivilDate, { amount: number; transactionIds: string[] }>();

  for (const o of occurrences) {
    const existing = byDay.get(o.day);
    if (existing) {
      existing.amount += o.amount;
      existing.transactionIds.push(o.transactionId);
    } else {
      byDay.set(o.day, { amount: o.amount, transactionIds: [o.transactionId] });
    }
  }

  return [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function measure(detectKey: string, raw: Occurrence[]): Detected | null {
  const kind = kindOfType(raw[0].type);
  if (!kind) return null;

  const history = collapseByDay(raw);
  if (history.length < MIN_OCCURRENCES) return null;

  const gaps: number[] = [];
  for (let i = 1; i < history.length; i++) {
    gaps.push(diffDays(history[i - 1].day, history[i].day));
  }

  const medianGap = median(gaps);
  const spec = cadenceOf(medianGap);
  if (!spec) return null;

  const amounts = history.map((h) => h.amount);
  const amountMedian = median(amounts);

  // How closely the gaps hold to the cadence. Measured against the ideal
  // interval rather than against the observed median, so a series that is
  // regularly irregular does not score as regular.
  const regularity = clamp01(1 - meanAbsoluteDeviation(gaps, medianGap) / spec.days);

  // §11.3 — amount plays no part for profit. Its amount varies every cycle, so
  // folding that variance into the confidence would push every real profit
  // series below the display floor.
  const stability =
    kind === "profit" || amountMedian <= 0
      ? 1
      : clamp01(1 - meanAbsoluteDeviation(amounts, amountMedian) / amountMedian);

  // A third charge is enough to see a rhythm; seven is enough to trust it.
  const volume = Math.min(1, 0.5 + (history.length - MIN_OCCURRENCES) / 8);

  const confidence =
    kind === "profit"
      ? volume * regularity
      : volume * (0.65 * regularity + 0.35 * stability);

  const last = history[history.length - 1];
  const price = priceChangeOf(kind, history);
  const monthly = spec.cadence !== "weekly" && spec.cadence !== "biweekly";

  return {
    detectKey,
    label: raw[0].label,
    kind,
    merchantId: raw[0].merchantId,
    accountId: raw[0].accountId,
    cadence: spec.cadence,
    intervalDays: Math.round(medianGap),
    amountAvg: amounts.reduce((s, a) => s + a, 0) / amounts.length,
    amountLast: last.amount,
    amountPrev: price ? price.from : null,
    priceChangeAt: price ? price.at : null,
    dayOfMonth: monthly ? Number(last.day.slice(8, 10)) : null,
    firstSeen: history[0].day,
    lastSeen: last.day,
    occurrenceCount: history.length,
    // Deliberately not rolled forward past `now`. A series whose next charge
    // was due three weeks ago is overdue, and inventing a future date for it
    // hides the one fact worth acting on — see `isDormant` and `daysAway`.
    nextExpectedAt: nextAfter(last.day, spec.cadence),
    confidence: Math.round(clamp01(confidence) * 1000) / 1000,
    transactionIds: history.flatMap((h) => h.transactionIds),
  };
}

/* -------------------------------------------------------------- expectation */

/**
 * What to bill in the calendar for one occurrence of a series.
 *
 * Null for profit: §11.3 detects it on cadence only, so the honest calendar
 * entry is the date with "amount varies" beside it rather than an average
 * dressed up as a prediction.
 */
export function expectedAmount(series: {
  kind: RecurringKind;
  amountLast: number | null;
  amountAvg: number | null;
}): number | null {
  if (series.kind === "profit") return null;
  return series.amountLast ?? series.amountAvg ?? null;
}
