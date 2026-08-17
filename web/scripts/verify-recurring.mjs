/**
 * Recurring-series detection — SPEC §11.3, §13.
 *
 * Two halves, and the second is the one that keeps this feature trustworthy:
 *
 *   Part A, in memory, against `lib/recurring.ts`: the periodicity maths, the
 *   cadences (weekly and biweekly included, which §11.3 asks for specifically),
 *   the confidence, the price-increase flag and the dormancy prompt.
 *
 *   Part B, against real Postgres and `db/recurring.ts`: the two exclusions
 *   §11.3 states as rules, asserted through the query the nightly pass actually
 *   runs.
 *
 *     - **Savings transfers are never fed to the detector.** A perfectly regular
 *       monthly transfer to savings is built into the fixture. If it ever reaches
 *       the detector it becomes a bill, and the calendar starts predicting money
 *       that was never leaving. This is the failure mode that has no symptom
 *       other than a wrong calendar.
 *     - **Profit is detected on cadence only, never amount.** The fixture pays
 *       profit monthly at a different amount every time — 41.20, 58.90, 33.10,
 *       76.40 — which is what a real profit-bearing account does. The series must
 *       still be found, and it must NOT raise a price-change alert, because that
 *       alert would fire every month forever.
 *
 * Run: npm run test:recurring
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const MIGRATIONS = path.join(HERE, "..", "drizzle");

const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const {
  detectSeries,
  isDetectable,
  kindOfType,
  cadenceOf,
  nextAfter,
  priceChangeOf,
  isDormant,
  daysAway,
  expectedAmount,
  detectKeyOf,
  CONFIDENCE_FLOOR,
  MIN_OCCURRENCES,
  DETECTABLE_TYPES,
} = await load("lib/recurring.ts");
const { runDetection, actOnSeries } = await load("db/recurring.ts");
const { addDays, addMonths } = await load("lib/periods.ts");

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  PASS  ${name}`);
};
const acheck = async (name, fn) => {
  await fn();
  n++;
  console.log(`  PASS  ${name}`);
};

/* ============================================================ part A: pure */

const NOW = "2026-08-17";

/** An occurrence, with the boring fields defaulted to "detectable". */
let seq = 0;
function charge({
  day,
  amount = 49.99,
  type = "purchase",
  merchantKey = "netflix",
  label = "Netflix",
  accountId = "acc-1",
  internal = false,
  excluded = false,
  state = "posted",
}) {
  seq++;
  return {
    transactionId: `tx-${seq}`,
    type,
    merchantKey,
    merchantId: merchantKey === null ? null : `m-${merchantKey}`,
    label,
    accountId,
    amount,
    day,
    isInternalTransfer: internal,
    excludedFromAnalytics: excluded,
    state,
  };
}

/** `count` charges at `every` days apart, ending on `last`. */
function run({ last, every, count, ...rest }) {
  return Array.from({ length: count }, (_, i) =>
    charge({ day: addDays(last, -every * (count - 1 - i)), ...rest }),
  );
}

/** `count` monthly charges ending on `last`, on the same day of the month. */
function monthly({ last, count, amounts, ...rest }) {
  return Array.from({ length: count }, (_, i) =>
    charge({
      day: addMonths(last, -(count - 1 - i)),
      ...(amounts ? { amount: amounts[i] } : {}),
      ...rest,
    }),
  );
}

console.log("\n[1] THE EXCLUSION GATE (§11.3)");
{
  check("a savings transfer is not detectable — exclusion one, stated in code", () =>
    assert.equal(isDetectable(charge({ day: NOW, type: "transfer", internal: true })), false));
  check("nor is an internal transfer that calls itself a purchase", () =>
    assert.equal(isDetectable(charge({ day: NOW, type: "purchase", internal: true })), false));
  check("`transfer` is not even a detectable type", () =>
    assert.equal(kindOfType("transfer"), null));
  check("nor is a card payment — the purchase behind it was already counted", () =>
    assert.equal(kindOfType("card_payment"), null));
  check("nor a loan payment, which books two legs and would bill you twice", () =>
    assert.equal(kindOfType("loan_payment"), null));
  check("a transaction excluded from analytics is excluded here too", () =>
    assert.equal(isDetectable(charge({ day: NOW, excluded: true })), false));
  check("a declined authorisation never happened, so it is no evidence of a rhythm", () =>
    assert.equal(isDetectable(charge({ day: NOW, state: "declined" })), false));
  check("a pending charge has not settled either", () =>
    assert.equal(isDetectable(charge({ day: NOW, state: "pending" })), false));
  check("an unnamed charge has nothing to recur as", () =>
    assert.equal(isDetectable(charge({ day: NOW, merchantKey: null })), false));

  check("what IS detectable: a purchase, a SADAD bill, a fee, salary and profit", () => {
    assert.equal(kindOfType("purchase"), "subscription");
    assert.equal(kindOfType("bill_payment"), "bill");
    assert.equal(kindOfType("fee"), "bill");
    assert.equal(kindOfType("income"), "salary");
    assert.equal(kindOfType("profit"), "profit");
    assert.equal(Object.keys(DETECTABLE_TYPES).length, 5);
  });
}

console.log("\n[2] CADENCES, INCLUDING THE TWO THE WEEK GRAIN MADE VISIBLE (§11.3)");
{
  check("7 days is weekly", () => assert.equal(cadenceOf(7).cadence, "weekly"));
  check("14 is biweekly, and not two weeklies", () =>
    assert.equal(cadenceOf(14).cadence, "biweekly"));
  check("28, 30 and 31 are all monthly — February does not break a subscription", () => {
    assert.equal(cadenceOf(28).cadence, "monthly");
    assert.equal(cadenceOf(30).cadence, "monthly");
    assert.equal(cadenceOf(31).cadence, "monthly");
  });
  check("91 is quarterly and 365 is yearly", () => {
    assert.equal(cadenceOf(91).cadence, "quarterly");
    assert.equal(cadenceOf(365).cadence, "yearly");
  });
  check("21 days matches nothing — a rhythm that is not one of these is left alone", () =>
    assert.equal(cadenceOf(21), null));
  check("and neither does 60 — a bimonthly charge is not rounded into monthly", () =>
    assert.equal(cadenceOf(60), null));

  check("a monthly series steps by months, so the 31st stays the 31st", () =>
    assert.equal(nextAfter("2026-01-31", "monthly"), "2026-02-28"));
  check("rather than by 30.44 days, which would walk the date backwards", () =>
    assert.notEqual(nextAfter("2026-01-31", "monthly"), addDays("2026-01-31", 30)));
  check("a weekly series steps by 7 days", () =>
    assert.equal(nextAfter("2026-08-10", "weekly"), "2026-08-17"));
  check("a biweekly one by 14", () =>
    assert.equal(nextAfter("2026-08-10", "biweekly"), "2026-08-24"));
}

console.log("\n[3] DETECTION: WHAT BECOMES A SERIES AND WHAT DOES NOT");
{
  const weekly = detectSeries(
    run({ last: "2026-08-14", every: 7, count: 6, merchantKey: "gym", label: "Gym", amount: 120 }),
  );
  check("six weekly charges are a weekly series", () => {
    assert.equal(weekly.length, 1);
    assert.equal(weekly[0].cadence, "weekly");
    assert.equal(weekly[0].intervalDays, 7);
  });
  check("and its next expected date is one week after the last charge", () =>
    assert.equal(weekly[0].nextExpectedAt, "2026-08-21"));

  const biweekly = detectSeries(
    run({ last: "2026-08-07", every: 14, count: 5, merchantKey: "cleaner", label: "Cleaner" }),
  );
  check("five fortnightly charges are biweekly, not monthly", () =>
    assert.equal(biweekly[0].cadence, "biweekly"));

  const two = detectSeries(
    run({ last: "2026-08-14", every: 30, count: 2, merchantKey: "once", label: "Once" }),
  );
  check("two charges are not a series — one gap cannot tell a rhythm from a coincidence", () => {
    assert.equal(two.length, 0);
    assert.equal(MIN_OCCURRENCES, 3);
  });

  const irregular = detectSeries(
    [
      charge({ day: "2026-03-02", merchantKey: "cafe", label: "Cafe" }),
      charge({ day: "2026-04-19", merchantKey: "cafe", label: "Cafe" }),
      charge({ day: "2026-06-30", merchantKey: "cafe", label: "Cafe" }),
      charge({ day: "2026-08-03", merchantKey: "cafe", label: "Cafe" }),
    ],
  );
  check("four irregular visits to the same cafe are not a subscription", () =>
    assert.equal(irregular.length, 0));

  // Two charges on one day would otherwise produce a zero gap, and a single
  // zero drags a monthly median far enough to match no cadence at all.
  const sameDay = detectSeries(
    [
      ...monthly({ last: "2026-08-05", count: 4, merchantKey: "shop", label: "Shop", amount: 60 }),
      charge({ day: "2026-08-05", merchantKey: "shop", label: "Shop", amount: 40 }),
    ],
  );
  check("two charges on one day collapse into one occurrence of their total", () => {
    assert.equal(sameDay.length, 1);
    assert.equal(sameDay[0].cadence, "monthly");
    assert.equal(sameDay[0].occurrenceCount, 4);
    assert.equal(sameDay[0].amountLast, 100);
  });

  const twoAccounts = detectSeries(
    [
      ...monthly({ last: "2026-08-05", count: 4, merchantKey: "netflix", accountId: "acc-1" }),
      ...monthly({ last: "2026-08-11", count: 4, merchantKey: "netflix", accountId: "acc-2" }),
    ],
  );
  check("the same merchant on two accounts is two series, keyed by account", () => {
    assert.equal(twoAccounts.length, 2);
    assert.equal(
      twoAccounts[0].detectKey,
      detectKeyOf("subscription", "netflix", twoAccounts[0].accountId),
    );
  });

  const confident = detectSeries(
    monthly({ last: "2026-08-05", count: 9, merchantKey: "rent", label: "Rent", amount: 4000 }),
  );
  const barely = detectSeries(
    monthly({ last: "2026-08-05", count: 3, merchantKey: "rent", label: "Rent", amount: 4000 }),
  );
  // Not exactly 1, and that is the measurement working: calendar months are 28
  // to 31 days, so even a charge on the same date every month has gaps that
  // differ, and the regularity term reports the difference instead of rounding
  // it away.
  check("nine charges on the same date each month are near-certain", () => {
    assert.equal(confident[0].confidence > 0.95, true);
    assert.equal(confident[0].confidence <= 1, true);
  });
  check("three reach the floor but not more — a rhythm seen, not yet trusted", () => {
    assert.equal(barely[0].confidence >= CONFIDENCE_FLOOR, true);
    assert.equal(barely[0].confidence < confident[0].confidence, true);
  });
  check("a monthly series carries its day of month", () =>
    assert.equal(confident[0].dayOfMonth, 5));
  check("a weekly one does not — storing one invites a monthly reading", () =>
    assert.equal(weekly[0].dayOfMonth, null));

  // Amount variance lowers confidence for a subscription. Same cadence, same
  // count — only the amounts differ.
  const wobbly = detectSeries(
    monthly({
      last: "2026-08-05",
      count: 9,
      merchantKey: "market",
      label: "Market",
      amounts: [80, 320, 140, 260, 95, 410, 175, 230, 130],
    }),
  );
  check("the same cadence with wildly varying amounts is less confident", () =>
    assert.equal(wobbly[0].confidence < confident[0].confidence, true));
}

console.log("\n[4] PRICE INCREASES — THE MAIN THING THIS CATCHES (§11.3)");
{
  const bumped = detectSeries(
    monthly({
      last: "2026-08-05",
      count: 6,
      merchantKey: "netflix",
      label: "Netflix",
      amounts: [49.99, 49.99, 49.99, 49.99, 49.99, 56.99],
    }),
  );

  check("a 7-riyal rise on a 50-riyal subscription is flagged", () => {
    assert.equal(bumped[0].amountPrev, 49.99);
    assert.equal(bumped[0].amountLast, 56.99);
  });
  check("and dated to the charge the new price started on", () =>
    assert.equal(bumped[0].priceChangeAt, "2026-08-05"));
  check("the series is not split in two by the change — that history is the evidence", () =>
    assert.equal(bumped[0].occurrenceCount, 6));

  // Dated to when it changed, not to the latest invoice: a rise charged three
  // months ago is three months old.
  const older = priceChangeOf("subscription", [
    { amount: 49.99, day: "2026-03-05" },
    { amount: 49.99, day: "2026-04-05" },
    { amount: 56.99, day: "2026-05-05" },
    { amount: 56.99, day: "2026-06-05" },
    { amount: 56.99, day: "2026-07-05" },
  ]);
  check("a rise from three months ago is dated three months ago", () =>
    assert.equal(older.at, "2026-05-05"));
  check("with the old price read from the charges before it", () =>
    assert.equal(older.from, 49.99));

  check("a 1% wobble is not a price rise", () =>
    assert.equal(
      priceChangeOf("subscription", [
        { amount: 500, day: "2026-06-05" },
        { amount: 500, day: "2026-07-05" },
        { amount: 503, day: "2026-08-05" },
      ]),
      null,
    ));
  check("nor is a 20-halala difference on a small charge", () =>
    assert.equal(
      priceChangeOf("subscription", [
        { amount: 4.99, day: "2026-06-05" },
        { amount: 4.99, day: "2026-07-05" },
        { amount: 5.19, day: "2026-08-05" },
      ]),
      null,
    ));
  check("a decrease is reported too, signed — a price cut is worth knowing", () => {
    const cut = priceChangeOf("subscription", [
      { amount: 100, day: "2026-06-05" },
      { amount: 100, day: "2026-07-05" },
      { amount: 80, day: "2026-08-05" },
    ]);
    assert.equal(cut.delta, -20);
    assert.equal(Math.round(cut.fraction * 100), -20);
  });

  // §11.3 — "Suppress amount-drift warnings on any series whose kind = 'profit'."
  const profitHistory = [
    { amount: 41.2, day: "2026-05-25" },
    { amount: 58.9, day: "2026-06-25" },
    { amount: 33.1, day: "2026-07-25" },
    { amount: 76.4, day: "2026-08-25" },
  ];
  check("a profit payout raises no price alert, however far the amount moves", () =>
    assert.equal(priceChangeOf("profit", profitHistory), null));
  check("and the identical history on a subscription does", () =>
    assert.notEqual(priceChangeOf("subscription", profitHistory), null));
}

console.log("\n[5] PROFIT IS CADENCE ONLY, NEVER AMOUNT (§11.3)");
{
  const profit = detectSeries(
    monthly({
      last: "2026-08-25",
      count: 6,
      type: "profit",
      merchantKey: "profit:saib_savings",
      label: "Savings profit",
      amounts: [41.2, 58.9, 33.1, 76.4, 22.75, 91.3],
    }),
  );

  check("a profit payout with a different amount every month is still a series", () => {
    assert.equal(profit.length, 1);
    assert.equal(profit[0].kind, "profit");
    assert.equal(profit[0].cadence, "monthly");
  });
  // The property, stated exactly: the same dates with steady amounts score the
  // same as the same dates with wild ones. Amount plays no part at all.
  const flatProfit = detectSeries(
    monthly({
      last: "2026-08-25",
      count: 6,
      type: "profit",
      merchantKey: "profit:other_savings",
      label: "Other profit",
      amounts: [50, 50, 50, 50, 50, 50],
    }),
  );
  check("its confidence is not dragged down by the amounts — it is cadence only", () =>
    assert.equal(profit[0].confidence, flatProfit[0].confidence));
  check("no price change is recorded on it, so no alert can fire monthly", () => {
    assert.equal(profit[0].amountPrev, null);
    assert.equal(profit[0].priceChangeAt, null);
  });
  check("and the calendar says 'amount varies' rather than an average", () =>
    assert.equal(expectedAmount(profit[0]), null));

  // The same variance on a subscription, for contrast: confidence drops, and the
  // amount is predicted.
  const subscription = detectSeries(
    monthly({
      last: "2026-08-25",
      count: 6,
      merchantKey: "market",
      label: "Market",
      amounts: [41.2, 58.9, 33.1, 76.4, 22.75, 91.3],
    }),
  );
  check("the identical amounts on a subscription lower its confidence", () =>
    assert.equal(subscription[0].confidence < profit[0].confidence, true));
  check("and it does get a predicted amount", () =>
    assert.equal(expectedAmount(subscription[0]), 91.3));
}

console.log("\n[6] DORMANCY, SCALED TO THE CADENCE (§11.3)");
{
  check("a monthly charge missing for 3 months is dormant — the SPEC's own case", () =>
    assert.equal(isDormant({ lastSeen: "2026-05-10", intervalDays: 30 }, NOW), true));
  check("missing for one month is not", () =>
    assert.equal(isDormant({ lastSeen: "2026-07-20", intervalDays: 30 }, NOW), false));
  check("a weekly charge is dormant after three weeks, not three months", () =>
    assert.equal(isDormant({ lastSeen: "2026-07-20", intervalDays: 7 }, NOW), true));
  check("and a yearly one is not dormant at three months", () =>
    assert.equal(isDormant({ lastSeen: "2026-05-10", intervalDays: 365 }, NOW), false));

  check("days away is negative when a charge is overdue, not clamped", () =>
    assert.equal(daysAway("2026-08-10", NOW), -7));
  check("and positive ahead of time", () => assert.equal(daysAway("2026-08-20", NOW), 3));

  // The next expected date is not rolled forward past today. Inventing a future
  // date for a series that stopped billing hides the only fact worth acting on.
  const stopped = detectSeries(
    monthly({ last: "2026-05-05", count: 5, merchantKey: "gone", label: "Gone" }),
  );
  check("a stopped series keeps its overdue expected date", () => {
    assert.equal(stopped[0].nextExpectedAt, "2026-06-05");
    assert.equal(daysAway(stopped[0].nextExpectedAt, NOW) < 0, true);
  });
}

/* ================================================= part B: against Postgres */

console.log("\n[7] THE GATHER QUERY REFUSES WHAT §11.3 SAYS IT MUST");

const pg = new PGlite();
for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
    try {
      await pg.exec(stmt);
    } catch (err) {
      console.error(`migration ${file} failed:\n${stmt.slice(0, 300)}\n${err.message}`);
      process.exit(1);
    }
  }
}

const db = drizzle(pg);
const rows = async (q) => (await pg.query(q)).rows;
const one = async (q) => (await rows(q))[0];

await pg.exec(`
  INSERT INTO accounts (slug, name, institution, type, reconcilable,
                        opening_balance, current_balance, is_profit_bearing)
  VALUES ('saib_current', 'Current', 'SAIB', 'checking', false, '20000.00', '20000.00', false),
         ('saib_savings', 'Savings', 'SAIB', 'savings',  false, '50000.00', '50000.00', true);

  INSERT INTO merchants (normalized_name, display_name)
  VALUES ('netflix', 'Netflix'), ('stc', 'STC');
`);

const current = await one(`SELECT * FROM accounts WHERE slug = 'saib_current'`);
const savingsAccount = await one(`SELECT * FROM accounts WHERE slug = 'saib_savings'`);
const netflix = await one(`SELECT * FROM merchants WHERE normalized_name = 'netflix'`);

async function tx({
  day,
  amount,
  type = "purchase",
  direction = "debit",
  accountId = current.id,
  merchantId = null,
  merchantRaw = null,
  biller = null,
  internal = false,
  incomeClass = null,
}) {
  await pg.exec(`
    INSERT INTO transactions (account_id, posted_at, amount, direction, type, state,
                              merchant_id, merchant_raw, biller, is_internal_transfer,
                              income_class)
    VALUES ('${accountId}', '${day}T12:00:00+03', '${amount}', '${direction}', '${type}',
            'posted', ${merchantId ? `'${merchantId}'` : "NULL"},
            ${merchantRaw ? `'${merchantRaw}'` : "NULL"},
            ${biller ? `'${biller}'` : "NULL"}, ${internal},
            ${incomeClass ? `'${incomeClass}'` : "NULL"})
  `);
}

// Six months of: a monthly subscription, a monthly SADAD bill, monthly salary,
// monthly profit at a different amount each time, and — the trap — a perfectly
// regular monthly transfer to savings.
for (let i = 0; i < 6; i++) {
  const month = addMonths("2026-03-05", i);
  await tx({ day: month, amount: "49.99", merchantId: netflix.id });
  await tx({ day: addDays(month, 3), amount: "310.00", type: "bill_payment", biller: "STC" });
  await tx({
    day: addMonths("2026-03-25", i),
    amount: "18000.00",
    direction: "credit",
    type: "income",
    incomeClass: "earned",
  });
  await tx({
    day: addMonths("2026-03-25", i),
    amount: String([41.2, 58.9, 33.1, 76.4, 22.75, 91.3][i]),
    direction: "credit",
    type: "profit",
    accountId: savingsAccount.id,
    incomeClass: "passive",
  });

  // The exclusion. Same day every month, same amount every month — the most
  // regular thing in the fixture, and it must never become a bill.
  await tx({
    day: addMonths("2026-03-26", i),
    amount: "3000.00",
    type: "transfer",
    internal: true,
    merchantRaw: "TO SAVINGS",
  });
  await tx({
    day: addMonths("2026-03-26", i),
    amount: "3000.00",
    direction: "credit",
    type: "transfer",
    accountId: savingsAccount.id,
    internal: true,
    merchantRaw: "TO SAVINGS",
  });
}

{
  const result = await runDetection(db, { now: "2026-08-30" });
  check("the pass runs", () => assert.equal(result.ok, true));

  const series = await rows(`
    SELECT s.detect_key, s.label, s.kind::text AS kind, s.cadence::text AS cadence,
           s.confidence, s.amount_last, s.amount_prev,
           s.price_change_at::text AS price_change_at,
           s.occurrence_count, s.next_expected_at::text AS next_expected_at
      FROM recurring_series s
     ORDER BY s.kind, s.detect_key
  `);

  const byLabel = (needle) => series.find((s) => s.detect_key.includes(needle));

  check("the subscription, the bill, the salary and the profit are all found", () => {
    assert.equal(series.length, 4);
    assert.notEqual(byLabel("netflix"), undefined);
    assert.notEqual(byLabel("stc"), undefined);
    assert.notEqual(byLabel("income:"), undefined);
    assert.notEqual(byLabel("profit:"), undefined);
  });

  // The one that matters. The savings transfer is the most regular row in the
  // fixture; a detector that reads it produces a 3,000 bill every month.
  check("the monthly savings transfer produced NO series — exclusion one holds", () => {
    // Its merchant string would have keyed the series, and its amount would have
    // been the prediction. Neither exists.
    assert.equal(series.some((s) => s.detect_key.includes("to savings")), false);
    assert.equal(series.some((s) => Number(s.amount_last) === 3000), false);
  });
  await acheck("even though it is the most regular thing in the fixture", async () => {
    const legs = await one(`
      SELECT count(*)::int AS n FROM transactions
       WHERE is_internal_transfer AND amount = '3000.00'
    `);
    assert.equal(legs.n, 12);
  });

  // Every series is displayable without reaching for its detection key. The key
  // is normalised (`stc`, `profit:saib_savings`) and putting it on screen is how
  // a bills calendar comes to list a lowercase slug as a payee.
  check("each series stores a label a person can read", () => {
    assert.equal(byLabel("netflix").label, "Netflix");
    assert.equal(byLabel("stc").label, "STC");
    assert.equal(byLabel("income:").label, "Salary");
    assert.equal(byLabel("profit:").label, "Savings profit");
  });

  const profit = byLabel("profit:");
  check("profit is detected on cadence alone", () => {
    assert.equal(profit.kind, "profit");
    assert.equal(profit.cadence, "monthly");
    assert.equal(Number(profit.occurrence_count), 6);
  });
  check("and carries no price change, so no spurious alert can fire monthly", () => {
    assert.equal(profit.amount_prev, null);
    assert.equal(profit.price_change_at, null);
  });

  const subscription = byLabel("netflix");
  // Six identical charges on the same date: the cadence and the amounts are both
  // as regular as they get, so what is left holding the figure below 1 is the
  // count itself — six months is a rhythm, not yet a decade of one.
  check("the subscription is monthly at 49.99, well clear of the floor", () => {
    assert.equal(subscription.cadence, "monthly");
    assert.equal(Number(subscription.amount_last), 49.99);
    assert.equal(Number(subscription.confidence) > CONFIDENCE_FLOOR * 2, true);
  });
  check("its next charge is expected a month after the last one", () =>
    assert.equal(subscription.next_expected_at, "2026-09-05"));

  const linked = await one(`
    SELECT count(*)::int AS n FROM transactions
     WHERE recurring_series_id IS NOT NULL
  `);
  check("every occurrence is linked back to its series (§4)", () =>
    assert.equal(linked.n, 24));

  const transfersLinked = await one(`
    SELECT count(*)::int AS n FROM transactions
     WHERE is_internal_transfer AND recurring_series_id IS NOT NULL
  `);
  check("and not one internal transfer was linked to anything", () =>
    assert.equal(transfersLinked.n, 0));

  // Idempotence: the tick runs nightly.
  const second = await runDetection(db, { now: "2026-08-30" });
  const after = await one(`SELECT count(*)::int AS n FROM recurring_series`);
  check("a second pass updates rather than duplicating", () => {
    assert.equal(second.ok, true);
    assert.equal(after.n, 4);
  });
}

console.log("\n[8] A PERSON'S DECISIONS SURVIVE THE NEXT PASS (§11.3)");
{
  const series = await one(
    `SELECT id, detect_key FROM recurring_series WHERE detect_key LIKE '%netflix%'`,
  );

  await actOnSeries(db, { id: series.id, action: "cancel" });
  await actOnSeries(db, { id: series.id, action: "confirm" });
  await runDetection(db, { now: "2026-08-30" });

  const after = await one(
    `SELECT status::text AS status, confirmed_at, amount_last
       FROM recurring_series WHERE id = '${series.id}'`,
  );
  check("a cancelled series is not quietly reactivated by a new charge", () =>
    assert.equal(after.status, "cancelled"));
  check("a confirmation is not cleared either", () =>
    assert.notEqual(after.confirmed_at, null));
  check("but the amounts still track reality — the detector owns those", () =>
    assert.equal(Number(after.amount_last), 49.99));

  // Excluding stops the detector updating the row at all, which is what makes it
  // stronger than dismissing.
  await actOnSeries(db, { id: series.id, action: "exclude" });
  await pg.exec(`UPDATE recurring_series SET amount_last = '1.00' WHERE id = '${series.id}'`);
  const excluded = await runDetection(db, { now: "2026-08-30" });
  const stale = await one(`SELECT amount_last FROM recurring_series WHERE id = '${series.id}'`);

  check("an excluded series is skipped by the pass", () =>
    assert.equal(excluded.value.skipped, 1));
  check("so nothing about it is rewritten", () => assert.equal(Number(stale.amount_last), 1));

  await actOnSeries(db, { id: series.id, action: "include" });
  await runDetection(db, { now: "2026-08-30" });
  const back = await one(
    `SELECT amount_last, dismissed_at FROM recurring_series WHERE id = '${series.id}'`,
  );
  check("re-including it picks the real amount back up", () =>
    assert.equal(Number(back.amount_last), 49.99));
  check("and un-silences it", () => assert.equal(back.dismissed_at, null));

  const missing = await actOnSeries(db, { id: "00000000-0000-4000-a000-000000000000", action: "pause" });
  check("acting on a series that is gone says so rather than throwing", () => {
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no longer exists/);
  });
}

await pg.close();
console.log(`\n${"=".repeat(62)}\nALL ${n} RECURRING CHECKS PASS\n${"=".repeat(62)}`);
