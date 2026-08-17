/**
 * The account detail views — SPEC §3.3, §6, §11.4, §11.5.
 *
 * Extends the fixtures in `verify-accounts-view.mjs` rather than restating
 * them: the credit-card rule is checked there against `toView`, and the checks
 * here are the ones that only appear once an account has a *history* behind it.
 *
 * Three of them are the ones named in the build prompt, and each is a mistake
 * that produces a completely plausible screen:
 *
 *   1. **`available_credit` read as a balance moves net worth by the full
 *      limit** (§3.3a). The same account, the same stored figure, one flag
 *      different — 14,000 apart.
 *   2. **Realized yield on the closing balance is not realized yield** (§11.5).
 *      A large deposit late in a cycle earns for days and would be divided into
 *      as though it had been there all month; the two figures are asserted to
 *      differ and the average-daily one is asserted to be what the view uses.
 *   3. **Contributions and cumulative profit sum to the balance** (§6). The
 *      split is two independent running totals and is never inferred from the
 *      balance — this is the assertion that says so.
 *
 * The rest cover the accounting traps the other bodies are built on: loan
 * principal is not expense, a savings deposit is not income, and the cashback
 * wallet's two legs are two different things.
 *
 * Run: npm run test:account-detail
 *   (node --experimental-strip-types; Node 22.6+)
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const { toView, groupByInstitution, totals, reconciliationOf, NO_COVERAGE } =
  await load("lib/accounts.ts");
const { savingsByCycle, residual, project, payoutStatus, classify, trailingMean, YIELD_WINDOW } =
  await load("lib/savings.ts");
const { amortize, extraPayment, minimumVsFull, statementState, normaliseApr } =
  await load("lib/liabilities.ts");
const { periodBounds } = await load("lib/periods.ts");

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  PASS  ${name}`);
};

/* --------------------------------------------------------- shared fixtures */

/** The same shape `verify-accounts-view.mjs` builds its accounts from. */
const account = (over) => ({
  id: over.slug,
  slug: over.slug,
  name: over.slug,
  institution: over.institution ?? "X",
  type: "checking",
  isLiability: false,
  balanceSemantics: "balance",
  reconcilable: true,
  currentBalance: "0",
  creditLimit: null,
  isProfitBearing: false,
  balanceAsOf: null,
  sortOrder: 0,
  statementDay: null,
  dueDay: null,
  profitPayoutDay: null,
  ...over,
});

const leg = (over) => ({
  day: over.day,
  cycle: over.cycle ?? periodBounds("cycle", over.day).start,
  amount: over.amount,
  direction: over.direction ?? "credit",
  type: over.type ?? "transfer",
  isInternalTransfer: over.isInternalTransfer ?? false,
  excluded: over.excluded ?? false,
});

const deposit = (day, amount) =>
  leg({ day, amount, direction: "credit", type: "transfer", isInternalTransfer: true });
const withdrawal = (day, amount) =>
  leg({ day, amount, direction: "debit", type: "transfer", isInternalTransfer: true });
const profit = (day, amount) => leg({ day, amount, direction: "credit", type: "profit" });

const round = (v, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/* ============================================================ §3.3a ======= */

console.log("\n[1] BALANCE SEMANTICS MOVE NET WORTH BY THE WHOLE LIMIT (§3.3a)");
{
  // §3.3a's own worked figures: the card reports 10,588 against a 13,999
  // limit. Read correctly that is 3,411 owed. Read as an ordinary balance it is
  // 10,588 held — "a 3,411 liability into a 10,588 asset", and the gap between
  // those two readings is exactly the credit limit.
  const stored = "10588.00";
  const limit = "13999.00";

  const card = (over) =>
    account({
      slug: "card",
      type: "credit_card",
      currentBalance: stored,
      creditLimit: limit,
      ...over,
    });

  const right = toView(
    card({ isLiability: true, balanceSemantics: "available_credit" }),
  );

  // The inversion itself: the same stored figure taken at face value. This is
  // what `isLiabilityFor` in `lib/account-edit.ts` exists to make impossible,
  // and what the seed's comment is warning about.
  const inverted = toView(card({ isLiability: false, balanceSemantics: "balance" }));

  check("available_credit derives debt as limit − reported", () =>
    assert.equal(right.debt, 3411));
  check("so the card LOWERS net worth", () => assert.equal(right.net, -3411));
  check("read as a plain balance it RAISES net worth by the reported figure", () =>
    assert.equal(inverted.net, 10588));
  check("the two readings differ by the FULL credit limit", () =>
    assert.equal(round(inverted.net - right.net), Number(limit)));

  // The third reading — a liability whose figure is taken as the debt — is
  // wrong differently: it overstates what is owed rather than inverting it.
  const overstated = toView(card({ isLiability: true, balanceSemantics: "balance" }));
  check("a liability read with the wrong semantics overstates the debt", () => {
    assert.equal(overstated.debt, 10588);
    assert.ok(overstated.debt > right.debt);
  });
  check("and only the correct reading leaves credit available", () => {
    assert.equal(right.available, 10588);
    assert.equal(overstated.available, null);
  });

  // The same difference at the level the screen actually reports.
  const netWorthWith = (cardAccount) =>
    totals(groupByInstitution([account({ slug: "savings", currentBalance: "71902.86" }), cardAccount]))
      .netWorth;

  check("net worth on the whole screen differs by the full limit", () =>
    assert.equal(
      round(
        netWorthWith(card({ isLiability: false, balanceSemantics: "balance" })) -
          netWorthWith(card({ isLiability: true, balanceSemantics: "available_credit" })),
      ),
      Number(limit),
    ));

  // Without a limit there is nothing to subtract from, and `toView` falls
  // through to reading the available credit as the debt. `validate()` refuses
  // that combination outright for this reason; this is what it is refusing.
  const noLimit = toView(
    card({ isLiability: true, balanceSemantics: "available_credit", creditLimit: null }),
  );
  check("available_credit with no limit reads the headroom as debt", () =>
    assert.equal(noLimit.debt, 10588));
}

/* ============================================================ §3.3b ======= */

console.log("\n[2] RECONCILIATION IS STATED, NEVER IMPLIED (§3.3b)");
{
  const covered = (messages, withBalance) => ({
    messages,
    withBalance,
    lastReportedAt: withBalance > 0 ? new Date("2026-08-12T09:00:00Z") : null,
    lastManualAt: null,
  });

  // The four rows of §3.3b's table, measured from what the ledger holds rather
  // than hardcoded per institution.
  const alrajhi = reconciliationOf({ reconcilable: true }, covered(40, 40));
  const barq = reconciliationOf({ reconcilable: true }, covered(20, 12));
  const stc = reconciliationOf({ reconcilable: true }, covered(30, 2));
  const saib = reconciliationOf({ reconcilable: false }, covered(50, 0));

  check("every message carries a balance → full", () => assert.equal(alrajhi.level, "full"));
  check("purchases only → partial", () => assert.equal(barq.level, "partial"));
  check("one template only → weak", () => assert.equal(stc.level, "weak"));
  check("a bank that never states one → none", () => assert.equal(saib.level, "none"));

  // The rule the whole feature exists for.
  check("'unverifiable' never reads as 'verified'", () => {
    for (const r of [stc, saib]) {
      assert.doesNotMatch(r.label.toLowerCase(), /^checked/);
      assert.match(`${r.label} ${r.detail}`.toLowerCase(), /not |rarely |too few/);
    }
  });
  check("only 'full' claims the ledger agrees with the bank", () =>
    assert.match(alrajhi.detail, /agrees with every one/));

  // A tiny sample is not a rate. Three of three is 100% coverage and no
  // evidence, and "full" printed against it is the exact overclaim §3.3b bans.
  const thin = reconciliationOf({ reconcilable: true }, covered(3, 3));
  check("3 of 3 messages is capped at weak, not called full", () =>
    assert.equal(thin.level, "weak"));
  check("and says why it is capped", () => assert.match(thin.detail, /too few/));

  const silent = reconciliationOf({ reconcilable: true }, covered(9, 0));
  check("a reconcilable account that has never reported is 'none'", () =>
    assert.equal(silent.level, "none"));

  const fresh = reconciliationOf({ reconcilable: true }, NO_COVERAGE);
  check("no messages at all is 'none', not a clean bill of health", () => {
    assert.equal(fresh.level, "none");
    assert.equal(fresh.share, null);
  });

  const anchored = reconciliationOf(
    { reconcilable: false },
    { messages: 12, withBalance: 0, lastReportedAt: null, lastManualAt: new Date() },
  );
  check("a hand-entered balance is named as the anchor it is (§3.3b control 3)", () =>
    assert.match(anchored.detail, /entered by hand anchors it/));
}

/* ============================================================ §11.5 ======= */

console.log("\n[3] REALIZED YIELD IS MEASURED ON THE AVERAGE DAILY BALANCE (§11.5)");
{
  // A cycle that opens at 10,000 and receives 90,000 on its second-to-last day.
  // The money was in the account for two days out of thirty-one. Divided by the
  // CLOSING balance the account looks like it earned almost nothing; divided by
  // what was actually on deposit, it earned a normal rate.
  const cycle = "2026-07-25"; // 25 Jul – 24 Aug, 31 days
  const rows = savingsByCycle({
    openingBalance: 10000,
    legs: [deposit("2026-08-23", 90000), profit("2026-08-24", 50)],
    cycles: [cycle],
    today: "2026-08-24",
  });

  const row = rows[0];

  check("the cycle is measured over its actual 31 days", () => assert.equal(row.days, 31));
  check("closing balance carries the late deposit", () =>
    assert.equal(row.closingBalance, 100050));

  // 29 days at 10,000, then 100,000 on the 23rd and 100,050 on the 24th.
  const expectedADB = (10000 * 29 + 100000 + 100050) / 31;
  check("average daily balance weights the deposit by the days it was there", () =>
    assert.equal(round(row.averageDailyBalance, 4), round(expectedADB, 4)));

  check("realized yield uses the average daily balance", () =>
    assert.equal(round(row.realizedYield, 8), round((50 / expectedADB) * 12, 8)));
  check("the closing-balance figure is computed too, for comparison", () =>
    assert.equal(round(row.closingYield, 8), round((50 / 100050) * 12, 8)));

  // The point of the whole exercise: they are not close.
  check("the two rates DIFFER on a large mid-cycle deposit", () =>
    assert.notEqual(round(row.realizedYield, 6), round(row.closingYield, 6)));
  check("and the closing-balance one understates it by more than 3×", () =>
    assert.ok(row.realizedYield / row.closingYield > 3));

  // Which one the screen shows. `CycleSavings.realizedYield` is what the chart
  // is handed; `closingYield` exists only so this assertion can be written.
  check("the view is handed the average-daily figure", () => {
    assert.ok(row.realizedYield > row.closingYield);
    assert.equal(round(row.realizedYield, 8), round((50 / row.averageDailyBalance) * 12, 8));
  });

  // A steady cycle, where the two agree — so the difference above is the
  // deposit's doing rather than an artefact of the formula.
  const steady = savingsByCycle({
    openingBalance: 100000,
    legs: [profit("2026-08-24", 50)],
    cycles: [cycle],
    today: "2026-08-24",
  })[0];
  check("with no mid-cycle movement the two rates nearly agree", () =>
    assert.ok(Math.abs(steady.realizedYield - steady.closingYield) / steady.realizedYield < 0.01));
}

console.log("\n[4] CONTRIBUTIONS AND PROFIT SUM TO THE BALANCE (§6)");
{
  // §6: "Keep Σ deposits − Σ withdrawals and Σ profit as independent running
  // totals; never try to infer the split from the balance."
  const cycles = ["2026-05-25", "2026-06-25", "2026-07-25"];
  const rows = savingsByCycle({
    openingBalance: 50000,
    legs: [
      deposit("2026-06-01", 3000),
      profit("2026-06-20", 120),
      withdrawal("2026-07-02", 5000),
      profit("2026-07-22", 118),
      deposit("2026-08-01", 2000),
      profit("2026-08-20", 125),
    ],
    cycles,
    today: "2026-08-24",
  });

  for (const row of rows) {
    check(`${row.label}: principal + profit == balance`, () =>
      assert.equal(round(residual(row), 6), 0));
  }

  const last = rows[rows.length - 1];
  check("net principal is opening + deposits − withdrawals", () =>
    assert.equal(last.cumulativePrincipal, 50000 + 3000 - 5000 + 2000));
  check("cumulative profit is the profit legs alone", () =>
    assert.equal(round(last.cumulativeProfit), 363));
  check("and the two really do add to the balance", () =>
    assert.equal(round(last.cumulativePrincipal + last.cumulativeProfit), round(last.closingBalance)));

  // The mistake this rules out: dividing the balance by a ratio. A month with a
  // withdrawal larger than the profit would report NEGATIVE growth under any
  // scheme that infers the split from a falling balance.
  const drawn = rows[2];
  check("a cycle that ends smaller still shows the profit it earned", () => {
    assert.ok(drawn.profit > 0);
    assert.ok(rows[2].cumulativeProfit > rows[1].cumulativeProfit);
  });
}

console.log("\n[5] A DEPOSIT IS A TRANSFER; PROFIT IS INCOME (§6)");
{
  check("an internal credit is a deposit, not profit", () =>
    assert.equal(classify(deposit("2026-08-01", 1000)), "deposit"));
  check("an internal debit is a withdrawal", () =>
    assert.equal(classify(withdrawal("2026-08-01", 1000)), "withdrawal"));
  check("a profit credit is profit", () =>
    assert.equal(classify(profit("2026-08-01", 45)), "profit"));

  // The §6 trap in its exact form: a credit of type 'profit' that was ALSO
  // paired as an internal transfer is a transfer. Pairing wins over the type
  // here because the type came from wording and the pairing is corroborated
  // movement; either way it is not new money.
  check("a profit-typed leg that is paired as a transfer is not income", () =>
    assert.equal(
      classify(leg({ day: "2026-08-01", amount: 45, type: "profit", isInternalTransfer: true })),
      "deposit",
    ));

  check("a hand-booked adjustment is neither", () =>
    assert.equal(
      classify(leg({ day: "2026-08-01", amount: 45, type: "adjustment", excluded: true })),
      "other",
    ));

  // And it stays visible rather than being absorbed into one of the two real
  // counters — an adjustment counted as profit would report the account
  // earning money it was handed.
  const rows = savingsByCycle({
    openingBalance: 1000,
    legs: [leg({ day: "2026-08-01", amount: 200, type: "adjustment", excluded: true })],
    cycles: ["2026-07-25"],
    today: "2026-08-24",
  });
  check("an adjustment lands in 'other', not in growth", () => {
    assert.equal(rows[0].cumulativeProfit, 0);
    assert.equal(rows[0].cumulativeOther, 200);
    assert.equal(round(residual(rows[0]), 6), 0);
  });
}

console.log("\n[6] NET CONTRIBUTION CAN BE NEGATIVE (§11.5 scenario B)");
{
  const rows = savingsByCycle({
    openingBalance: 20000,
    legs: [withdrawal("2026-08-05", 3000), profit("2026-08-20", 50)],
    cycles: ["2026-07-25"],
    today: "2026-08-24",
  });

  check("drawing savings down reports a negative net, not a zero", () =>
    assert.equal(rows[0].net, -3000));
  check("and it is not clamped anywhere on the way out", () => assert.ok(rows[0].net < 0));
  check("the profit that cycle is still counted as income", () =>
    assert.equal(rows[0].profit, 50));
}

console.log("\n[7] THE TRAILING AVERAGE, AND WHAT NULL MEANS");
{
  check("a null is skipped, not read as a zero", () =>
    assert.deepEqual(trailingMean([null, 0.04, 0.02], 3), [null, 0.04, 0.03]));
  check("the window is trailing and inclusive", () =>
    assert.deepEqual(
      trailingMean([0.03, 0.03, 0.06, 0.06], 3).map((v) => round(v, 6)),
      [0.03, 0.03, 0.04, 0.05],
    ));
  check("three cycles is the window §11.5 names", () => assert.equal(YIELD_WINDOW, 3));
}

console.log("\n[8] THE PROJECTION IS A RANGE, NOT A LINE (§11.5)");
{
  const varied = project({
    balance: 100000,
    yields: [0.02, 0.05, 0.035, 0.045],
    contribution: 1000,
    cycles: 12,
  });

  check("a varying rate opens a band", () => assert.ok(varied.rate.high > varied.rate.low));
  check("the end of the band is wider than its start", () => {
    const first = varied.points[1];
    const last = varied.points[varied.points.length - 1];
    assert.ok(last.high - last.low > first.high - first.low);
  });
  check("four observations is enough to ground it", () => assert.equal(varied.grounded, true));

  // The case the flag exists for: one observation gives a zero-width band,
  // which on screen reads as certainty about a rate nobody has measured.
  const thin = project({ balance: 100000, yields: [0.04], contribution: 0, cycles: 12 });
  check("one observation collapses the band", () =>
    assert.equal(thin.rate.low, thin.rate.high));
  check("and is flagged as not grounded, so the view can say so", () =>
    assert.equal(thin.grounded, false));

  check("the low edge never goes negative", () =>
    assert.ok(project({ balance: 1000, yields: [0.01, 0.9], contribution: 0 }).rate.low >= 0));

  // The slider moves the contribution and nothing else.
  const withExtra = project({
    balance: 100000,
    yields: [0.02, 0.05, 0.035, 0.045],
    contribution: 1000,
    extra: 500,
    cycles: 12,
  });
  check("the slider adds to the contribution", () =>
    assert.equal(withExtra.contribution, 1500));
  check("and leaves the rate alone", () =>
    assert.deepEqual(withExtra.rate, varied.rate));
  check("more in means more out", () => {
    const a = varied.points[12];
    const b = withExtra.points[12];
    assert.ok(b.mid > a.mid);
  });

  // Compounding, not simple addition: 12 cycles at a positive rate must beat
  // the balance plus twelve contributions.
  check("the projection compounds", () => {
    const end = varied.points[12].mid;
    assert.ok(end > 100000 + 12 * 1000);
  });
}

console.log("\n[9] PAYOUT TRACKING WATCHES THE CADENCE, NEVER THE AMOUNT (§11.5)");
{
  const monthly = ["2026-05-25", "2026-06-25", "2026-07-25"];

  check("on schedule inside the grace period", () =>
    assert.equal(payoutStatus(monthly, "2026-08-27").state, "on-time"));
  check("late once the usual gap plus grace has passed", () =>
    assert.equal(payoutStatus(monthly, "2026-09-02").state, "late"));
  check("missing once a whole further gap has gone by", () =>
    assert.equal(payoutStatus(monthly, "2026-09-26").state, "missing"));
  check("one payout is not a cadence", () =>
    assert.equal(payoutStatus(["2026-07-25"], "2026-09-30").state, "unknown"));
  check("none at all is unknown, not missing", () =>
    assert.equal(payoutStatus([], "2026-09-30").state, "unknown"));
  // Measured, not assumed to be 30: 25 May → 25 Jun is 31 days and 25 Jun →
  // 25 Jul is 30, and the gap the tracker uses is the one that happened.
  check("the measured gap is reported", () =>
    assert.equal(payoutStatus(monthly, "2026-08-27").cadenceDays, 31));

  // §11.5: "a smaller-than-usual one is not [worth an alert]". Enforced by the
  // signature rather than by remembering it — the function is handed dates and
  // has no amount to look at, and nothing it returns describes one.
  check("the tracker takes payout dates and today, and no amounts", () =>
    assert.equal(payoutStatus.length, 2));
  check("and nothing it reports is a size", () =>
    assert.deepEqual(Object.keys(payoutStatus(monthly, "2026-08-27")).sort(), [
      "cadenceDays",
      "daysLate",
      "detail",
      "expectedBy",
      "lastAt",
      "state",
    ]));
}

/* ============================================================ §11.4 ======= */

console.log("\n[10] LOAN PRINCIPAL IS NOT EXPENSE — ONLY INTEREST IS (§6)");
{
  // §6's worked loan: a 2,000 payment on a balance carrying interest splits
  // into an interest part that is spending and a principal part that is not.
  const schedule = amortize({
    balance: 50000,
    apr: 0.072,
    payment: 2000,
    from: "2026-09-25",
  });

  const first = schedule.rows[0];

  check("the first payment splits into interest and principal", () => {
    assert.equal(round(first.interest), round((50000 * 0.072) / 12));
    assert.equal(round(first.principal), round(2000 - (50000 * 0.072) / 12));
  });
  check("the two halves are the whole payment", () =>
    assert.equal(round(first.interest + first.principal), 2000));
  check("only the principal reduces the balance", () =>
    assert.equal(round(first.balance), round(50000 - first.principal)));
  check("so the debt falls by less than was paid", () =>
    assert.ok(50000 - first.balance < 2000));

  check("the schedule clears", () => assert.equal(schedule.cleared, true));
  check("and has a payoff date", () => assert.ok(schedule.payoffDate));
  check("total interest is the sum of the interest column", () =>
    assert.equal(
      round(schedule.totalInterest),
      round(schedule.rows.reduce((s, r) => s + r.interest, 0)),
    ));
  check("total paid is more than the debt, by exactly the interest", () =>
    assert.equal(round(schedule.totalPaid - schedule.totalInterest), 50000));

  // The last payment is only what is left. A full instalment there would
  // overstate the cost of the loan by up to a month.
  const last = schedule.rows[schedule.rows.length - 1];
  check("the final payment is trimmed to what remains", () => {
    assert.ok(last.payment <= 2000);
    assert.equal(round(last.balance), 0);
  });

  // A payment that does not cover the interest never clears, and saying "600
  // months" would dress that up as a schedule.
  const under = amortize({ balance: 50000, apr: 0.24, payment: 500, from: "2026-09-25" });
  check("a payment below the interest is refused as a schedule", () => {
    assert.equal(under.underwater, true);
    assert.equal(under.months, null);
    assert.equal(under.rows.length, 0);
  });

  const saved = extraPayment({
    balance: 50000,
    apr: 0.072,
    payment: 2000,
    extra: 500,
    from: "2026-09-25",
  });
  check("paying more clears it sooner", () => assert.ok(saved.monthsSaved > 0));
  check("and saves interest, which is the only part that was spending", () =>
    assert.ok(saved.interestSaved > 0));

  check("4.99 and 0.0499 are the same rate", () => {
    assert.equal(normaliseApr(4.99), 0.0499);
    assert.equal(normaliseApr(0.0499), 0.0499);
  });
}

console.log("\n[11] THE CARD STATEMENT, AND THE COST OF THE MINIMUM (§11.4)");
{
  const statement = {
    statementDate: "2026-08-05",
    totalDue: 4389.91,
    minimumDue: 219.5,
    dueDate: "2026-08-25",
    paidAt: null,
  };

  check("days until due counts from today", () =>
    assert.equal(statementState(statement, "2026-08-22").daysUntilDue, 3));
  check("three days out is 'due soon' (§11.6's alert threshold)", () =>
    assert.equal(statementState(statement, "2026-08-22").urgency, "due-soon"));
  check("past the date is overdue, not 'due in −2 days'", () => {
    const s = statementState(statement, "2026-08-27");
    assert.equal(s.urgency, "overdue");
    assert.match(s.detail, /due 2 days ago/);
  });
  check("a settled statement says paying a card is not spending", () => {
    const s = statementState({ ...statement, paidAt: new Date() }, "2026-08-22");
    assert.equal(s.paid, true);
    assert.match(s.detail, /internal transfer, not spending/);
  });
  check("no due date is 'unknown', never assumed", () =>
    assert.equal(statementState({ ...statement, dueDate: null }, "2026-08-22").urgency, "unknown"));

  const comparison = minimumVsFull({
    balance: 4389.91,
    minimumDue: 219.5,
    totalDue: 4389.91,
  });

  check("paying in full costs no interest at all", () => {
    assert.equal(comparison.full.totalInterest, 0);
    assert.equal(comparison.full.totalPaid, 4389.91);
  });
  check("paying the minimum costs interest", () =>
    assert.ok(comparison.minimum.totalInterest > 0));
  check("and takes years", () => assert.ok(comparison.minimum.months > 24));
  check("the minimum share comes from this card's own statement", () =>
    assert.equal(round(comparison.minimumShare, 4), 0.05));
  check("the difference is the interest, stated as such", () =>
    assert.equal(round(comparison.extraInterest), round(comparison.minimum.totalInterest)));
}

/* ============================================================ integration = */

console.log("\n[12] THE SAVINGS SCREEN'S OWN NUMBERS, END TO END");
{
  // §11.5's whole story on one account: irregular contributions, variable
  // profit, one month drawn down, over six cycles.
  const cycles = [
    "2026-02-25",
    "2026-03-25",
    "2026-04-25",
    "2026-05-25",
    "2026-06-25",
    "2026-07-25",
  ];

  const rows = savingsByCycle({
    openingBalance: 60000,
    legs: [
      deposit("2026-03-02", 5000),
      profit("2026-03-24", 140),
      profit("2026-04-24", 152),
      deposit("2026-05-01", 12000),
      profit("2026-05-24", 165),
      withdrawal("2026-06-10", 8000),
      profit("2026-06-24", 158),
      deposit("2026-07-28", 4000),
      profit("2026-08-22", 175),
    ],
    cycles,
    expenseByCycle: new Map([
      ["2026-06-25", 9000],
      ["2026-07-25", 8500],
    ]),
    today: "2026-08-24",
  });

  check("every cycle's split still adds to its balance", () => {
    for (const row of rows) assert.equal(round(residual(row), 6), 0);
  });

  const last = rows[rows.length - 1];
  check("the balance is opening + net contributions + profit", () =>
    assert.equal(round(last.closingBalance), round(60000 + 5000 + 12000 - 8000 + 4000 + 790)));

  check("the drawn-down cycle is negative and the others are not", () => {
    const june = rows.find((r) => r.cycle === "2026-05-25"); // 25 May – 24 Jun
    assert.equal(june.net, -8000);
    assert.ok(rows.filter((r) => r.net < 0).length === 1);
  });

  check("passive coverage is profit over what the cycle COST", () =>
    assert.equal(round(last.passiveCoverage, 6), round(175 / 8500, 6)));
  check("a cycle with no expenses has no coverage figure, not an infinite one", () =>
    assert.equal(rows[0].passiveCoverage, null));

  check("the trailing yield smooths the per-cycle series", () => {
    const measured = rows.filter((r) => r.realizedYield !== null);
    assert.ok(measured.length >= 3);
    assert.ok(last.trailingYield !== null);
    assert.notEqual(round(last.trailingYield, 8), round(last.realizedYield, 8));
  });

  // Every rate is measured against a denominator larger than the profit and
  // smaller than an implausible one — a sanity floor on the whole fold.
  check("every cycle that earned reports a plausible annual rate", () => {
    for (const row of rows) {
      if (row.profit === 0) continue;
      assert.ok(
        row.realizedYield > 0 && row.realizedYield < 0.2,
        `${row.label}: ${row.realizedYield}`,
      );
    }
  });

  // A cycle where no profit landed earned nothing, and that is a measured
  // zero rather than a gap: the balance was there, it simply was not paid.
  // Drawing it as null would leave a hole in the series where a real month is.
  check("a cycle with a balance but no payout is a zero, not a null", () => {
    const quiet = rows.find((r) => r.profit === 0 && r.averageDailyBalance > 0);
    assert.ok(quiet);
    assert.equal(quiet.realizedYield, 0);
  });

  // A cycle in progress must not be averaged over days that have not happened.
  const partial = savingsByCycle({
    openingBalance: 10000,
    legs: [],
    cycles: ["2026-07-25"],
    today: "2026-08-01",
  })[0];
  check("a cycle in progress averages over elapsed days only", () => {
    assert.equal(partial.days, 8);
    assert.equal(partial.partial, true);
  });
}

console.log(`\n${"=".repeat(60)}\nALL ${n} ACCOUNT-DETAIL CHECKS PASS\n${"=".repeat(60)}`);
