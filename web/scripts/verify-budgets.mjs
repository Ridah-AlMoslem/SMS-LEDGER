/**
 * Budgets, rollover carry and goals — SPEC §11.2, §13.
 *
 * Every failure this script guards against is silent. Nothing throws when a
 * corrected transaction quietly rewrites two years of budgets, or when a weekly
 * allowance is a tenth too small every single week, or when a goal goes on
 * reporting savings that were withdrawn last Tuesday. The screen keeps showing
 * plausible numbers, and the only way to find out is to reconcile by hand.
 *
 * So each section below is one promise §11.2 makes, run against the same
 * functions the app calls — `db/budgets.ts`, `db/goals.ts`, `lib/pace.ts`,
 * `lib/goals.ts` — never against copies of them:
 *
 *   [1] Overspend produces a NEGATIVE carry into the next cycle, and underspend
 *       a positive one. Rollover carries both directions.
 *   [2] A corrected transaction two cycles back does not cascade into the
 *       current budget. The counterfactual is measured too, so the test proves
 *       the cascade was real and was prevented rather than absent.
 *   [3] fair_share over a full cycle's weeks sums to the cycle budget.
 *   [4] A 28-day and a 31-day cycle produce different fair_share for the same
 *       weekly window — and neither equals cycle_budget ÷ 4.
 *   [5] Goal progress falls when the linked account is debited, with nothing
 *       written to the goal.
 *   [6] The sum of goal buckets cannot exceed the account balance.
 *   [7] Reset carry, and the close that must not undo it.
 *   [8] The §6 expense rule decides what consumes a budget.
 *
 * Run: npm run test:budgets
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

const { setBudget, setRollover, resetCarry, closeCycle, unclosedCycles } =
  await load("db/budgets.ts");
const { saveGoal, deleteGoal } = await load("db/goals.ts");
const { pace, carryForward } = await load("lib/pace.ts");
const { bucketsFor, viewGoal, overAllocationBy, cyclesUntil } = await load("lib/goals.ts");
const { daysInPeriod, weekBucketsInCycle } = await load("lib/periods.ts");
const { IS_EXPENSE_SQL } = await load("db/predicates.ts");

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

/* --------------------------------------------------------------- fixtures */

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

// Seeded category ids from migration 0005. Fixed on purpose: a budget row has to
// mean the same thing after a rebuild.
const GROCERIES = "c0000000-0000-4000-a000-000000000201";
const RESTAURANTS = "c0000000-0000-4000-a000-000000000202";
const COFFEE = "c0000000-0000-4000-a000-000000000203";
const FUEL = "c0000000-0000-4000-a000-000000000301";

// 25 May – 24 Jun, 25 Jun – 24 Jul, 25 Jul – 24 Aug (31 days), 25 Feb – 24 Mar (28).
const MAY = "2026-05-25";
const JUNE = "2026-06-25";
const JULY = "2026-07-25";
const FEBRUARY = "2026-02-25";

await pg.exec(`
  INSERT INTO accounts (slug, name, institution, type, reconcilable,
                        opening_balance, current_balance, is_profit_bearing)
  VALUES ('saib_current', 'Current', 'SAIB', 'checking', false, '20000.00', '20000.00', false),
         ('saib_savings', 'Savings', 'SAIB', 'savings',  false, '10000.00', '10000.00', true),
         ('rajhi_card',  'Visa',     'AlRajhiBank', 'credit_card', true, '5000.00', '5000.00', false);
  UPDATE accounts SET is_liability = true, balance_semantics = 'available_credit',
                      credit_limit = '5000.00'
   WHERE slug = 'rajhi_card';
`);

const current = await one(`SELECT * FROM accounts WHERE slug = 'saib_current'`);
const savings = await one(`SELECT * FROM accounts WHERE slug = 'saib_savings'`);
const card = await one(`SELECT * FROM accounts WHERE slug = 'rajhi_card'`);

/** `recompute_balances` from api/db.py, verbatim — the statement the parser runs
 *  on its next tick. Goal progress is asserted against the balance this
 *  produces, so the test measures the same derivation production does. */
const RECOMPUTE = `
  UPDATE accounts a
  SET current_balance = a.opening_balance + COALESCE(t.delta, 0)
  FROM (
      SELECT acc.id,
             SUM(CASE WHEN tx.direction = 'credit' THEN tx.amount ELSE -tx.amount END) AS delta
      FROM accounts acc
      LEFT JOIN transactions tx
             ON tx.account_id = acc.id
            AND tx.state = 'posted'
            AND tx.superseded_by IS NULL
      GROUP BY acc.id
  ) t
  WHERE a.id = t.id
`;

let seq = 0;

/** One expense, in a cycle, in a category. */
async function spend({
  amount,
  categoryId = GROCERIES,
  day,
  accountId = current.id,
  type = "purchase",
  direction = "debit",
  internal = false,
}) {
  seq++;
  return one(`
    INSERT INTO transactions (account_id, posted_at, amount, direction, type, state,
                              category_id, is_internal_transfer, merchant_raw)
    VALUES ('${accountId}', '${day}T12:00:00+03', '${amount}', '${direction}', '${type}',
            'posted', ${categoryId ? `'${categoryId}'` : "NULL"}, ${internal},
            'FIXTURE ${seq}')
    RETURNING *
  `);
}

const budgetAt = (categoryId, cycle) =>
  one(`SELECT amount, carry_in, rollover, carry_closed_at
         FROM budgets WHERE category_id = '${categoryId}' AND cycle_start = '${cycle}'`);

const money = (v) => Math.round(Number(v) * 100) / 100;

/* ------------------------------------------------------------------- [1] */

console.log("\n[1] ROLLOVER CARRIES BOTH DIRECTIONS, AND THE CARRY IS STORED (§11.2)");
{
  // Groceries: 1,000 budgeted, 1,400 spent. Overspend.
  await setBudget(db, { categoryId: GROCERIES, cycleStart: MAY, amount: "1000" });
  await setRollover(db, { categoryId: GROCERIES, cycleStart: MAY, rollover: true });
  await spend({ amount: "1400.00", categoryId: GROCERIES, day: "2026-06-02" });

  // Restaurants: 1,000 budgeted, 800 spent. Underspend.
  await setBudget(db, { categoryId: RESTAURANTS, cycleStart: MAY, amount: "1000" });
  await setRollover(db, { categoryId: RESTAURANTS, cycleStart: MAY, rollover: true });
  await spend({ amount: "800.00", categoryId: RESTAURANTS, day: "2026-06-03" });

  // Coffee: 200 budgeted, 50 spent, rollover OFF.
  await setBudget(db, { categoryId: COFFEE, cycleStart: MAY, amount: "200" });
  await spend({ amount: "50.00", categoryId: COFFEE, day: "2026-06-04" });

  const early = await closeCycle(db, { cycle: MAY, now: "2026-06-10" });
  check("a cycle that has not ended refuses to close", () => {
    assert.equal(early.ok, false);
    assert.match(early.error, /has not ended/);
  });

  const closed = await closeCycle(db, { cycle: MAY, now: "2026-06-25" });
  check("closing the cycle carries three categories forward", () => {
    assert.equal(closed.ok, true);
    assert.equal(closed.value.into, JUNE);
    assert.equal(closed.value.carried, 3);
  });

  const groceries = await budgetAt(GROCERIES, JUNE);
  check("overspending 400 produces a carry of −400 — the honest version", () =>
    assert.equal(money(groceries.carry_in), -400));
  check("and the base comes across untouched, so it is 1,000 with −400 against it", () =>
    assert.equal(money(groceries.amount), 1000));
  check("base and carry are two columns, so 600 is never displayable as the budget", () =>
    assert.notEqual(money(groceries.amount), 600));

  const restaurants = await budgetAt(RESTAURANTS, JUNE);
  check("underspending 200 raises the next allowance by 200", () =>
    assert.equal(money(restaurants.carry_in), 200));

  const coffee = await budgetAt(COFFEE, JUNE);
  check("a category without rollover carries nothing, though its budget persists", () => {
    assert.equal(money(coffee.carry_in), 0);
    assert.equal(money(coffee.amount), 200);
  });

  check("every carried row is stamped settled", () =>
    assert.equal([groceries, restaurants, coffee].every((b) => b.carry_closed_at !== null), true));

  // Idempotence. The tick fires nightly and Supabase wakes projects up at
  // random times; a second close must be a no-op rather than a second fold.
  const again = await closeCycle(db, { cycle: MAY, now: "2026-06-26" });
  const afterSecond = await budgetAt(GROCERIES, JUNE);
  check("closing twice changes nothing — the carry is settled, not cached", () => {
    assert.equal(again.ok, true);
    assert.equal(again.value.carried, 0);
    assert.equal(again.value.settled, 3);
    assert.equal(money(afterSecond.carry_in), -400);
  });

  const open = await unclosedCycles(db, { now: "2026-06-26" });
  check("and the cycle is no longer reported as owing a carry", () =>
    assert.equal(open.includes(MAY), false));
}

/* ------------------------------------------------------------------- [2] */

console.log("\n[2] A CORRECTION TWO CYCLES BACK DOES NOT CASCADE (§11.2)");
{
  // June: 1,000 base, +200 carried in from May, 900 spent.
  await spend({ amount: "900.00", categoryId: RESTAURANTS, day: "2026-07-02" });

  const closedJune = await closeCycle(db, { cycle: JUNE, now: "2026-07-25" });
  const july = await budgetAt(RESTAURANTS, JULY);

  check("June closes into July with 1,000 + 200 − 900 = 300", () => {
    assert.equal(closedJune.ok, true);
    assert.equal(money(july.carry_in), 300);
  });

  // Two cycles back, a transaction turns out to have been mis-parsed: the 800
  // restaurant bill in May was really 1,300. Exactly the §9.4 correction the
  // ledger exists to allow.
  await pg.exec(`
    UPDATE transactions SET amount = '1300.00'
     WHERE category_id = '${RESTAURANTS}'
       AND effective_cycle(posted_at, cycle_override) = '${MAY}'
  `);

  const spentInMay = await one(`
    SELECT sum(amount) AS total FROM v_categorized_amounts
     WHERE cycle_start = '${MAY}' AND category_id = '${RESTAURANTS}' AND ${IS_EXPENSE_SQL}
  `);
  check("the correction really did land — May now reads 1,300 spent", () =>
    assert.equal(money(spentInMay.total), 1300));

  // The nightly tick runs again over both boundaries, exactly as it would.
  await closeCycle(db, { cycle: MAY, now: "2026-08-01" });
  await closeCycle(db, { cycle: JUNE, now: "2026-08-01" });

  const juneAfter = await budgetAt(RESTAURANTS, JUNE);
  const julyAfter = await budgetAt(RESTAURANTS, JULY);

  check("June's carry did not move", () => assert.equal(money(juneAfter.carry_in), 200));
  check("and July's — the cycle on screen — did not move either", () =>
    assert.equal(money(julyAfter.carry_in), 300));

  // The cascade was real. This is what a read-time fold over history would have
  // produced from the corrected figure, and it is the number the screen would
  // now be showing.
  const cascadedJune = carryForward({
    cycleStart: MAY,
    base: 1000,
    carryIn: 0,
    rollover: true,
    spent: 1300,
  });
  const cascadedJuly = carryForward({
    cycleStart: JUNE,
    base: 1000,
    carryIn: cascadedJune,
    rollover: true,
    spent: 900,
  });

  check("a fold over history would have said −300 and −200 instead", () => {
    assert.equal(cascadedJune, -300);
    assert.equal(cascadedJuly, -200);
  });
  check("so the correction would have moved this cycle's allowance by 500", () =>
    assert.equal(money(julyAfter.carry_in) - cascadedJuly, 500));
}

/* ------------------------------------------------------------------- [3] */

console.log("\n[3] FAIR_SHARE IS DAY-WEIGHTED AND SUMS BACK TO THE CYCLE BUDGET (§11.2)");
{
  const BUDGET = 5000;
  const days = daysInPeriod("cycle", JULY);
  const weeks = weekBucketsInCycle(JULY);

  check("25 Jul – 24 Aug is 31 days across 6 week buckets", () => {
    assert.equal(days, 31);
    assert.equal(weeks.length, 6);
  });
  check("the buckets tile the cycle exactly — clipped, not rounded (§5.3)", () =>
    assert.equal(weeks.reduce((sum, w) => sum + w.days, 0), days));
  check("two of them are partial, which is why a whole-week assumption is wrong", () =>
    assert.equal(weeks.filter((w) => w.partial).length, 2));

  const shares = weeks.map(
    (w) => pace({ budget: BUDGET, spent: 0, elapsed: 0, total: days, daysInWeek: w.days }).fairShare,
  );

  const summed = shares.reduce((sum, s) => sum + s, 0);
  check("Σ fair_share over every week of the cycle == the cycle budget", () =>
    assert.equal(Math.round(summed * 100) / 100, BUDGET));

  // §11.2 — "a cycle averages 4.43 weeks, so a flat quarter-split understates
  // the weekly allowance by ~10% and makes you look permanently over budget."
  const quarter = BUDGET / 4;
  const whole = shares.find((_, i) => !weeks[i].partial);
  check("a whole week's fair share is 1,129.03, not the 1,250 a ÷4 would give", () => {
    assert.equal(Math.round(whole * 100) / 100, 1129.03);
    assert.equal(quarter, 1250);
  });
  check("the ÷4 shortcut overstates a week by 10.7% — permanently over budget", () =>
    assert.equal(Math.round((quarter / whole - 1) * 1000) / 10, 10.7));

  // The stub weeks get a stub allowance. A 1-day bucket handed a seventh of the
  // cycle is how a screen invents an overspend at a cycle edge.
  const stub = weeks.find((w) => w.days === 1);
  check("a 1-day bucket at the cycle edge is allowed one day's worth", () =>
    assert.equal(Math.round(shares[weeks.indexOf(stub)] * 100) / 100,
                 Math.round((BUDGET / days) * 100) / 100));
}

/* ------------------------------------------------------------------- [4] */

console.log("\n[4] A 28-DAY AND A 31-DAY CYCLE DISAGREE ABOUT THE SAME WEEK (§11.2)");
{
  const BUDGET = 5000;
  const long = daysInPeriod("cycle", JULY);
  const short = daysInPeriod("cycle", FEBRUARY);

  check("31 days and 28 days", () => {
    assert.equal(long, 31);
    assert.equal(short, 28);
  });

  const longWeek = pace({ budget: BUDGET, spent: 0, elapsed: 0, total: long, daysInWeek: 7 });
  const shortWeek = pace({ budget: BUDGET, spent: 0, elapsed: 0, total: short, daysInWeek: 7 });

  check("the same 7-day window is allowed 1,129.03 in July and 1,250.00 in February", () => {
    assert.equal(Math.round(longWeek.fairShare * 100) / 100, 1129.03);
    assert.equal(Math.round(shortWeek.fairShare * 100) / 100, 1250);
  });
  check("so the two grains cannot share a stored weekly figure", () =>
    assert.notEqual(longWeek.fairShare, shortWeek.fairShare));

  // February is the one cycle where ÷4 happens to be right, which is exactly why
  // the shortcut survives long enough to ship.
  check("February is the only place ÷4 agrees, and July is not", () => {
    assert.equal(Math.round(shortWeek.fairShare * 100) / 100, BUDGET / 4);
    assert.notEqual(Math.round(longWeek.fairShare * 100) / 100, BUDGET / 4);
  });

  // remaining_pace absorbs what has already been spent; fair_share does not.
  const paced = pace({ budget: BUDGET, spent: 3000, elapsed: 18, total: long, daysInWeek: 7 });
  check("remaining_pace is (budget − spent) ÷ weeks left, and it leads", () => {
    assert.equal(Math.round(paced.weeksLeft * 100) / 100, 1.86);
    assert.equal(Math.round(paced.remainingPace * 100) / 100, 1076.92);
  });
  check("and it is not the fair share — that is the point of showing both", () =>
    assert.notEqual(Math.round(paced.remainingPace * 100) / 100,
                    Math.round(paced.fairShare * 100) / 100));
}

/* ------------------------------------------------------------------- [5] */

console.log("\n[5] GOAL PROGRESS FALLS WHEN THE ACCOUNT IS DEBITED (§11.2)");
{
  const created = await saveGoal(db, {
    name: "Emergency fund",
    targetAmount: "20000",
    targetDate: "2027-06-30",
    accountId: savings.id,
    allocation: "8000",
  });
  check("a goal over a real account is accepted", () => assert.equal(created.ok, true));

  const read = async () => {
    const goals = (
      await rows(`SELECT id, name, target_amount, target_date::text AS target_date,
                         linked_account_id, allocation FROM goals ORDER BY created_at`)
    ).map((g) => ({
      id: g.id,
      name: g.name,
      targetAmount: Number(g.target_amount),
      targetDate: g.target_date,
      accountId: g.linked_account_id,
      allocation: Number(g.allocation),
    }));

    const balances = new Map(
      (await rows(`SELECT id, current_balance FROM accounts`)).map((a) => [
        a.id,
        Number(a.current_balance),
      ]),
    );

    const buckets = bucketsFor(goals, balances);
    return goals.map((g) =>
      viewGoal(g, buckets.get(g.accountId), { now: "2026-08-17", accountRunRate: null }),
    );
  };

  const [before] = await read();
  check("progress is the allocation while the balance backs it — 8,000 of 20,000", () => {
    assert.equal(money(before.funded), 8000);
    assert.equal(Math.round(before.progress * 100), 40);
  });

  // A withdrawal. Nothing touches the goal; the balance is recomputed from the
  // legs exactly as the parser's next tick would.
  await spend({
    amount: "5000.00",
    categoryId: null,
    day: "2026-08-10",
    accountId: savings.id,
    type: "withdrawal",
  });
  await pg.exec(RECOMPUTE);

  const balance = await one(`SELECT current_balance FROM accounts WHERE id = '${savings.id}'`);
  check("the account is down to 5,000", () => assert.equal(money(balance.current_balance), 5000));

  const [after] = await read();
  check("goal progress fell to 5,000 with nothing written to the goal", () =>
    assert.equal(money(after.funded), 5000));
  check("its allocation is untouched — the claim did not change, the money did", () =>
    assert.equal(money(after.allocation), 8000));
  check("so the row can say 'allocated 8,000, only 5,000 in the account'", () =>
    assert.equal(after.allocation > after.funded, true));
  check("progress is 25%, read from the balance rather than from a counter", () =>
    assert.equal(Math.round(after.progress * 100), 25));

  const storedAllocation = await one(`SELECT allocation FROM goals LIMIT 1`);
  check("and the database still holds only the allocation, never the progress", () =>
    assert.equal(money(storedAllocation.allocation), 8000));

  // §11.2 — "show required contribution per cycle to hit target_date, and
  // whether the current run rate makes it."
  // 17 Aug 2026 sits in the cycle opening 25 Jul 2026; 30 Jun 2027 sits in the
  // one opening 25 Jun 2027. That is twelve paydays, counting the one whose
  // cycle you are in.
  check("cycles left counts salary cycles, inclusive of this one", () =>
    assert.equal(cyclesUntil("2027-06-30", "2026-08-17"), 12));
  check("a target inside the current cycle leaves one, not zero", () =>
    assert.equal(cyclesUntil("2026-08-20", "2026-08-17"), 1));
  check("and a target already past leaves none, which is what makes it overdue", () =>
    assert.equal(cyclesUntil("2026-07-01", "2026-08-17"), 0));

  const [withRate] = await read();
  check("the required contribution is what is missing spread over those cycles", () =>
    assert.equal(money(withRate.requiredPerCycle), money(15000 / 12)));

  const goals = (
    await rows(`SELECT id, name, target_amount, target_date::text AS target_date,
                       linked_account_id, allocation FROM goals`)
  ).map((g) => ({
    id: g.id,
    name: g.name,
    targetAmount: Number(g.target_amount),
    targetDate: g.target_date,
    accountId: g.linked_account_id,
    allocation: Number(g.allocation),
  }));
  const buckets = bucketsFor(goals, new Map([[savings.id, 5000]]));

  const slow = viewGoal(goals[0], buckets.get(savings.id), {
    now: "2026-08-17",
    accountRunRate: 100,
  });
  const fast = viewGoal(goals[0], buckets.get(savings.id), {
    now: "2026-08-17",
    accountRunRate: 5000,
  });
  check("100 a cycle does not get there and says so", () => assert.equal(slow.onTrack, false));
  check("5,000 a cycle does", () => assert.equal(fast.onTrack, true));
  check("with no history there is no verdict rather than a false one", () =>
    assert.equal(viewGoal(goals[0], buckets.get(savings.id), { now: "2026-08-17" }).onTrack, null));
}

/* ------------------------------------------------------------------- [6] */

console.log("\n[6] THE SUM OF THE BUCKETS CANNOT EXCEED THE BALANCE (§11.2)");
{
  // The savings account holds 5,000 and the emergency fund claims 8,000 of it
  // already — an over-allocation that a withdrawal created rather than an edit.
  const overByWithdrawal = await one(
    `SELECT sum(allocation) AS allocated,
            (SELECT current_balance FROM accounts WHERE id = '${savings.id}') AS balance
       FROM goals WHERE linked_account_id = '${savings.id}'`,
  );
  check("the state a withdrawal can create is visible, not hidden", () =>
    assert.equal(money(overByWithdrawal.allocated) > money(overByWithdrawal.balance), true));

  const second = await saveGoal(db, {
    name: "New laptop",
    targetAmount: "9000",
    targetDate: null,
    accountId: savings.id,
    allocation: "1000",
  });
  check("a second goal that does not fit is refused", () => {
    assert.equal(second.ok, false);
    assert.match(second.error, /more than Savings holds/);
  });
  check("and the message names the excess and the balance", () =>
    assert.match(second.error, /4,000\.00 more[\s\S]*5,000\.00/));

  await acheck("nothing was written", async () =>
    assert.equal((await rows(`SELECT id FROM goals`)).length, 1));

  // Put the money back and the same save fits.
  await spend({
    amount: "5000.00",
    categoryId: null,
    day: "2026-08-11",
    accountId: savings.id,
    type: "transfer",
    direction: "credit",
    internal: true,
  });
  await pg.exec(RECOMPUTE);

  const fits = await saveGoal(db, {
    name: "New laptop",
    targetAmount: "9000",
    targetDate: null,
    accountId: savings.id,
    allocation: "2000",
  });
  check("with 10,000 in the account, 8,000 + 2,000 is accepted exactly", () =>
    assert.equal(fits.ok, true));

  const oneMore = await saveGoal(db, {
    name: "Holiday",
    targetAmount: "3000",
    targetDate: null,
    accountId: savings.id,
    allocation: "0.01",
  });
  check("and one halala more is not", () => assert.equal(oneMore.ok, false));

  // Editing an existing goal must not count its own old allocation twice.
  const goalRows = await rows(`SELECT id, allocation FROM goals ORDER BY created_at`);
  const raise = await saveGoal(db, {
    id: goalRows[1].id,
    name: "New laptop",
    targetAmount: "9000",
    targetDate: null,
    accountId: savings.id,
    allocation: "2000",
  });
  check("re-saving a goal unchanged is not an over-allocation of itself", () =>
    assert.equal(raise.ok, true));

  const tooBig = await saveGoal(db, {
    id: goalRows[1].id,
    name: "New laptop",
    targetAmount: "9000",
    targetDate: null,
    accountId: savings.id,
    allocation: "3000",
  });
  check("but raising it past the remainder is", () => assert.equal(tooBig.ok, false));

  // The pure rule, directly: it is what the sheet shows before the save is
  // attempted, so the refusal is never a surprise.
  const asGoals = [
    { id: "a", name: "A", targetAmount: 100, targetDate: null, accountId: savings.id, allocation: 6000 },
    { id: "b", name: "B", targetAmount: 100, targetDate: null, accountId: savings.id, allocation: 3000 },
  ];
  check("overAllocationBy names the excess", () =>
    assert.equal(overAllocationBy(asGoals, { accountId: savings.id, allocation: 2000, balance: 10000 }), 1000));
  check("and returns null when it fits", () =>
    assert.equal(overAllocationBy(asGoals, { accountId: savings.id, allocation: 1000, balance: 10000 }), null));
  check("excluding the goal being edited from its own sum", () =>
    assert.equal(
      overAllocationBy(asGoals, { accountId: savings.id, allocation: 7000, balance: 10000, goalId: "a" }),
      null,
    ));

  // A goal over a credit card would read available credit as savings (§3.3a).
  const onCard = await saveGoal(db, {
    name: "Card goal",
    targetAmount: "1000",
    targetDate: null,
    accountId: card.id,
    allocation: "0",
  });
  check("a goal over a liability is refused — available credit is not savings", () => {
    assert.equal(onCard.ok, false);
    assert.match(onCard.error, /is a liability/);
  });

  const gone = await deleteGoal(db, { id: goalRows[1].id });
  check("deleting a goal frees its allocation", () => assert.equal(gone.ok, true));
}

/* ------------------------------------------------------------------- [7] */

console.log("\n[7] RESET CARRY, AND THE CLOSE THAT MUST NOT UNDO IT (§11.2)");
{
  const before = await budgetAt(GROCERIES, JUNE);
  check("groceries carries −400 into June", () => assert.equal(money(before.carry_in), -400));

  const reset = await resetCarry(db, { categoryId: GROCERIES, cycleStart: JUNE });
  const after = await budgetAt(GROCERIES, JUNE);
  check("one click zeroes it", () => {
    assert.equal(reset.ok, true);
    assert.equal(money(after.carry_in), 0);
  });

  // The reset is settled, so the nightly close cannot helpfully put the drift
  // back on its next run — which would make the button look broken.
  await closeCycle(db, { cycle: MAY, now: "2026-08-01" });
  const stillZero = await budgetAt(GROCERIES, JUNE);
  check("and a later close leaves it at zero", () => assert.equal(money(stillZero.carry_in), 0));

  const missing = await resetCarry(db, { categoryId: FUEL, cycleStart: JUNE });
  check("resetting a carry that does not exist says so", () => {
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no budget here/);
  });

  const rolloverFirst = await setRollover(db, {
    categoryId: FUEL,
    cycleStart: JUNE,
    rollover: true,
  });
  check("rollover cannot be turned on for a category with no budget", () => {
    assert.equal(rolloverFirst.ok, false);
    assert.match(rolloverFirst.error, /Set a budget/);
  });

  // §4 — cycle_start is always the 25th that opens the cycle. A date inside the
  // cycle normalises rather than failing the check constraint.
  const midCycle = await setBudget(db, {
    categoryId: FUEL,
    cycleStart: "2026-07-03",
    amount: "600",
  });
  check("a budget set from a date inside the cycle lands on the 25th", () => {
    assert.equal(midCycle.ok, true);
    assert.equal(midCycle.value.cycleStart, JUNE);
  });

  const removed = await setBudget(db, { categoryId: FUEL, cycleStart: JUNE, amount: null });
  check("an empty amount removes the budget rather than storing zero", async () =>
    assert.equal(removed.ok, true));
  await acheck("and the row is gone", async () =>
    assert.equal(await budgetAt(FUEL, JUNE), undefined));

  const nonsense = await setBudget(db, { categoryId: FUEL, cycleStart: JUNE, amount: "lots" });
  check("a budget that is not an amount is refused", () => {
    assert.equal(nonsense.ok, false);
    assert.match(nonsense.error, /must be an amount/);
  });
}

/* ------------------------------------------------------------------- [8] */

console.log("\n[8] THE §6 EXPENSE RULE DECIDES WHAT CONSUMES A BUDGET");
{
  const CYCLE = "2026-08-25";
  await setBudget(db, { categoryId: FUEL, cycleStart: CYCLE, amount: "1000" });
  await setRollover(db, { categoryId: FUEL, cycleStart: CYCLE, rollover: true });

  // 300 of fuel — spending. Plus three things that are not, each of which would
  // eat the budget if the carry were computed from "sum of debits":
  await spend({ amount: "300.00", categoryId: FUEL, day: "2026-09-01" });
  //   a savings transfer out of current (§6: moving your own money)
  await spend({
    amount: "2000.00", categoryId: FUEL, day: "2026-09-02", type: "transfer", internal: true,
  });
  //   the card being paid off (the purchase was already counted)
  await spend({
    amount: "500.00", categoryId: FUEL, day: "2026-09-03", type: "card_payment",
  });
  //   a declined authorisation (it never happened)
  await spend({ amount: "400.00", categoryId: FUEL, day: "2026-09-04", type: "purchase" });
  await pg.exec(`UPDATE transactions SET state = 'declined' WHERE merchant_raw = 'FIXTURE ${seq}'`);

  const closed = await closeCycle(db, { cycle: CYCLE, now: "2026-09-25" });
  const next = await budgetAt(FUEL, "2026-09-25");

  check("only the 300 of real spending consumed the budget", () => {
    assert.equal(closed.ok, true);
    assert.equal(money(next.carry_in), 700);
  });

  const naive = await one(`
    SELECT sum(amount) AS total FROM transactions
     WHERE category_id = '${FUEL}'
       AND effective_cycle(posted_at, cycle_override) = '${CYCLE}'
       AND direction = 'debit'
  `);
  check("a 'sum of debits' carry would have read 3,200 out and carried −2,200", () => {
    assert.equal(money(naive.total), 3200);
    assert.equal(1000 - money(naive.total), -2200);
  });
  check("which is a 2,900 error in one cycle, on one category", () =>
    assert.equal(money(next.carry_in) - (1000 - money(naive.total)), 2900));
}

await pg.close();
console.log(`\n${"=".repeat(62)}\nALL ${n} BUDGET AND GOAL CHECKS PASS\n${"=".repeat(62)}`);
