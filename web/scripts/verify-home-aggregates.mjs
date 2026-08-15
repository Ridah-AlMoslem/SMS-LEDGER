/**
 * Home's aggregates — SPEC §6, §11.2, §13.
 *
 * The dashboard's headline figures are all one arithmetic mistake away from
 * being plausible and wrong, and §6 quantifies exactly how wrong: the worked
 * example reports **7,600 of spending instead of 1,100** if "expense" is read
 * as "sum of debits". A 6.9× overstatement that no individual screen would
 * look strange.
 *
 * So this script builds that worked example in a real Postgres (PGlite),
 * against the real migrations, and asserts:
 *
 *   1. income is 12,045 and expense is 1,100 — not 7,600.
 *   2. Δ net worth == income − expense, the master invariant of §6.
 *   3. Pacing divides by the cycle's ACTUAL length, by running the same fixture
 *      in a 28-day cycle and a 31-day one and requiring different answers.
 *
 * Everything it filters with is imported from `src/db/predicates.ts` and
 * everything it paces with is imported from `src/lib/pace.ts` — the same code
 * the pages run. A test that retypes the rule it is checking agrees with the
 * bug.
 *
 * Run: npm run test:home
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const MIGRATIONS = path.join(HERE, "..", "drizzle");

const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const { IS_EARNED_SQL, IS_EXPENSE_SQL, IS_PASSIVE_SQL, IS_UNCATEGORIZED_SQL } =
  await load("db/predicates.ts");
const { pace, foldCarry, effectiveBudget } = await load("lib/pace.ts");
const { groupByInstitution, totals: accountTotals, toView } = await load("lib/accounts.ts");
const { netWorthSeries, hasShape } = await load("lib/net-worth.ts");
const { rankAlerts, reviewQueueAlert } = await load("lib/alerts.ts");
const { daysInPeriod, daysElapsed, periodBounds, weekStart, shortLabel } =
  await load("lib/periods.ts");

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  PASS  ${name}`);
};

/* ------------------------------------------------------------- the fixture */

const CATEGORIES = {
  groceries: "c0000000-0000-4000-a000-000000000201",
  fees: "c0000000-0000-4000-a000-000000000b01",
  restaurants: "c0000000-0000-4000-a000-000000000202",
};

/**
 * §6's worked example, as ledger rows.
 *
 * Two modelling decisions worth stating, because the SPEC's Python fixture
 * (`tests/verify_accounting.py`) carries them as struct fields and this schema
 * has no column for either:
 *
 * **The loan payment is two legs, not one with an `interest` attribute.** A
 * 2,000 payment split 300/1,700 books 1,700 of `loan_payment` (excluded from
 * expense — the principal moves net worth) and 300 of `fee` (an ordinary
 * expense, §7.4). Together they debit checking by exactly 2,000, so the balance
 * is right, and expense picks up the interest with no special case anywhere —
 * which is the point: "+ Σ loan interest portions" as a clause in every
 * aggregate is the kind of per-chart SQL §6 warns about.
 *
 * **The loan's counter-leg is a DEBIT.** `recompute_balances` (api/db.py) uses
 * one uniform sign rule — credit adds, debit subtracts — for every account, and
 * a loan's stored balance is the debt owed. A payment reduces it, so the leg
 * that reduces it is a debit. Booking it as a credit would grow the loan by
 * 1,700 on every payment.
 */
function fixture(cycleStart, ids) {
  const day = (offset, time = "10:00") => {
    const d = new Date(`${cycleStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return `${d.toISOString().slice(0, 10)}T${time}:00+03`;
  };

  return [
    // salary 12,000 — earned income, landing on the day the cycle opens
    `('${ids.checking}', '${day(0)}', 12000.00, 'credit', 'income', 'earned', NULL, false, NULL)`,
    // 800 of groceries on the card — a purchase IS spending
    `('${ids.card}', '${day(2)}', 800.00, 'debit', 'purchase', NULL, '${CATEGORIES.groceries}', false, NULL)`,
    // the card paid in full — an internal transfer, NOT a second 800 of spend
    `('${ids.checking}', '${day(6)}', 800.00, 'debit', 'card_payment', NULL, NULL, true, NULL)`,
    `('${ids.card}', '${day(6)}', 800.00, 'credit', 'card_payment', NULL, NULL, true, NULL)`,
    // loan payment 2,000 = 1,700 principal + 300 interest
    `('${ids.checking}', '${day(8)}', 1700.00, 'debit', 'loan_payment', NULL, NULL, false, NULL)`,
    `('${ids.loan}', '${day(8)}', 1700.00, 'debit', 'loan_payment', NULL, NULL, false, NULL)`,
    `('${ids.checking}', '${day(8)}', 300.00, 'debit', 'fee', NULL, '${CATEGORIES.fees}', false, NULL)`,
    // 1,000 and 3,000 moved to savings — internal both ways
    `('${ids.checking}', '${day(10)}', 1000.00, 'debit', 'transfer', NULL, NULL, true, NULL)`,
    `('${ids.savings}', '${day(10)}', 1000.00, 'credit', 'transfer', NULL, NULL, true, NULL)`,
    `('${ids.checking}', '${day(12)}', 3000.00, 'debit', 'transfer', NULL, NULL, true, NULL)`,
    `('${ids.savings}', '${day(12)}', 3000.00, 'credit', 'transfer', NULL, NULL, true, NULL)`,
    // 45 of profit — passive income. Excluding it breaks the master invariant.
    `('${ids.savings}', '${day(14)}', 45.00, 'credit', 'profit', 'passive', NULL, false, NULL)`,
  ];
}

const OPENING = { checking: 10000, savings: 5000, card: 10000, loan: 50000 };
const CARD_LIMIT = 10000;

/** `recompute_balances` from api/db.py, verbatim — the same statement the
 *  parser runs on its next tick. Net worth is therefore derived from the very
 *  legs the aggregates read, which is what makes the invariant check below a
 *  test rather than a restatement. */
const RECOMPUTE = `
  UPDATE accounts a
  SET current_balance = a.opening_balance + COALESCE(t.delta, 0),
      balance_as_of   = COALESCE(t.last_at, a.balance_as_of)
  FROM (
      SELECT acc.id,
             SUM(CASE WHEN tx.direction = 'credit' THEN tx.amount
                      ELSE -tx.amount END) AS delta,
             MAX(tx.posted_at) AS last_at
      FROM accounts acc
      LEFT JOIN transactions tx
             ON tx.account_id = acc.id
            AND tx.state = 'posted'
            AND tx.superseded_by IS NULL
      GROUP BY acc.id
  ) t
  WHERE a.id = t.id
`;

async function boot(cycleStart) {
  const db = new PGlite();

  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      try {
        await db.exec(stmt);
      } catch (err) {
        console.error(`migration ${file} failed:\n${stmt.slice(0, 300)}\n${err.message}`);
        process.exit(1);
      }
    }
  }

  const ids = {
    checking: "a0000000-0000-4000-a000-000000000001",
    savings: "a0000000-0000-4000-a000-000000000002",
    card: "a0000000-0000-4000-a000-000000000003",
    loan: "a0000000-0000-4000-a000-000000000004",
  };

  await db.exec(`
    INSERT INTO accounts (id, slug, name, institution, type, is_liability,
                          balance_semantics, opening_balance, current_balance,
                          credit_limit, is_profit_bearing, sort_order)
    VALUES
      ('${ids.checking}', 'checking', 'Current', 'SAIB', 'checking', false,
       'balance', ${OPENING.checking}, ${OPENING.checking}, NULL, false, 1),
      ('${ids.savings}', 'savings', 'Savings', 'SAIB', 'savings', false,
       'balance', ${OPENING.savings}, ${OPENING.savings}, NULL, true, 2),
      -- §3.3a: the stored figure is AVAILABLE CREDIT. Debt is limit − balance.
      ('${ids.card}', 'card', 'Visa', 'AlRajhiBank', 'credit_card', true,
       'available_credit', ${OPENING.card}, ${OPENING.card}, ${CARD_LIMIT}, false, 3),
      ('${ids.loan}', 'loan', 'Car loan', 'AlRajhiBank', 'loan', true,
       'balance', ${OPENING.loan}, ${OPENING.loan}, NULL, false, 4);

    INSERT INTO transactions
      (account_id, posted_at, amount, direction, type, income_class, category_id,
       is_internal_transfer, cycle_override)
    VALUES ${fixture(cycleStart, ids).join(",\n           ")};
  `);

  await db.exec(RECOMPUTE);
  return { db, ids };
}

const rows = async (db, sql) => (await db.query(sql)).rows;
const one = async (db, sql) => (await rows(db, sql))[0];

/** The §6 aggregates, filtered with the app's own predicate text. */
async function measure(db, cycle) {
  const r = await one(
    db,
    `SELECT COALESCE(sum(amount) FILTER (WHERE ${IS_EXPENSE_SQL}), 0)       AS expense,
            COALESCE(sum(amount) FILTER (WHERE ${IS_EARNED_SQL}), 0)        AS earned,
            COALESCE(sum(amount) FILTER (WHERE ${IS_PASSIVE_SQL}), 0)       AS passive,
            COALESCE(sum(amount) FILTER (WHERE ${IS_UNCATEGORIZED_SQL}), 0) AS uncategorized
       FROM v_categorized_amounts
      WHERE cycle_start = '${cycle}'::date`,
  );

  const earned = Number(r.earned);
  const passive = Number(r.passive);
  return {
    expense: Number(r.expense),
    earned,
    passive,
    income: earned + passive,
    uncategorized: Number(r.uncategorized),
  };
}

/** Net worth through the app's own account view — `toView()` is the only place
 *  the available-credit rule exists, and reading it backwards is a swing of
 *  roughly a full credit limit (§3.3a). */
async function netWorthOf(db) {
  const accounts = (
    await rows(
      db,
      `SELECT id, slug, name, institution, type::text AS type, is_liability,
              balance_semantics::text AS balance_semantics, reconcilable,
              current_balance, opening_balance, credit_limit, is_profit_bearing, sort_order
         FROM accounts ORDER BY sort_order`,
    )
  ).map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    institution: a.institution,
    type: a.type,
    isLiability: a.is_liability,
    balanceSemantics: a.balance_semantics,
    reconcilable: a.reconcilable,
    currentBalance: String(a.current_balance),
    openingBalance: String(a.opening_balance),
    creditLimit: a.credit_limit === null ? null : String(a.credit_limit),
    isProfitBearing: a.is_profit_bearing,
    balanceAsOf: null,
    sortOrder: Number(a.sort_order),
    statementDay: null,
    dueDay: null,
    profitPayoutDay: null,
  }));

  return { accounts, ...accountTotals(groupByInstitution(accounts)) };
}

/** Halalas, and never negative zero: `-0 === 0` is true but assert.equal's
 *  strict comparison distinguishes them, and a card paid in full lands on
 *  exactly that value. */
const round = (n) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

/* ========================================================================= */

const JULY = "2026-07-25"; // 25 Jul – 24 Aug 2026: 31 days
const FEBRUARY = "2026-02-25"; // 25 Feb – 24 Mar 2026: 28 days

const july = await boot(JULY);

console.log("\n[1] THE §6 WORKED EXAMPLE: 12,045 IN, 1,100 OUT — NOT 7,600");
{
  const m = await measure(july.db, JULY);

  check("income is 12,045 — 12,000 earned plus 45 of profit", () =>
    assert.equal(round(m.income), 12045));
  check("profit is counted as income, not as a transfer (§6, §11.5)", () =>
    assert.equal(round(m.passive), 45));
  check("expense is 1,100 — 800 of groceries and 300 of loan interest", () =>
    assert.equal(round(m.expense), 1100));

  // The failure the SPEC quantifies. "Sum of debits" over the accounts the
  // money actually left — checking and the card — is the 7,600 in §6's table.
  const naive = await one(
    july.db,
    `SELECT sum(t.amount) AS total
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.direction = 'debit' AND a.type <> 'loan'`,
  );

  check("the naive 'sum of debits' really does read 7,600", () =>
    assert.equal(round(Number(naive.total)), 7600));
  check("and expense is nothing like it — a 6.9× overstatement", () => {
    assert.notEqual(round(m.expense), 7600);
    assert.equal(Math.round((7600 / m.expense) * 10) / 10, 6.9);
  });

  const parts = await rows(
    july.db,
    `SELECT type::text AS type, direction::text AS direction, sum(amount) AS total
       FROM v_categorized_amounts
      WHERE cycle_start = '${JULY}'::date AND ${IS_EXPENSE_SQL}
      GROUP BY 1, 2 ORDER BY 1`,
  );

  check("the card payment is not in expense — the purchase already was", () =>
    assert.equal(parts.some((p) => p.type === "card_payment"), false));
  check("the loan PRINCIPAL is not in expense", () =>
    assert.equal(parts.some((p) => p.type === "loan_payment"), false));
  check("the loan INTEREST is, as an ordinary expense leg (§7.4)", () =>
    assert.equal(round(Number(parts.find((p) => p.type === "fee").total)), 300));
  check("savings deposits are not expense — moving your own money is not spending", () =>
    assert.equal(parts.some((p) => p.type === "transfer"), false));

  check("savings rate is 90.9% including profit", () =>
    assert.equal(Math.round(((m.income - m.expense) / m.income) * 1000) / 10, 90.9));
  check("earned-only savings rate is 90.8%", () =>
    assert.equal(Math.round(((m.earned - m.expense) / m.earned) * 1000) / 10, 90.8));
  check("passive coverage is 4.1% — 'your savings pays for 4% of your life'", () =>
    assert.equal(Math.round((m.passive / m.expense) * 1000) / 10, 4.1));
}

console.log("\n[2] THE MASTER INVARIANT: Δ NET WORTH == INCOME − EXPENSE");
{
  const m = await measure(july.db, JULY);
  const { accounts, netWorth, assets, debt } = await netWorthOf(july.db);

  const opening =
    OPENING.checking + OPENING.savings - (CARD_LIMIT - OPENING.card) - OPENING.loan;

  check("opening net worth is −35,000", () => assert.equal(opening, -35000));
  check("closing net worth is −24,055", () => assert.equal(round(netWorth), -24055));
  check("assets are 24,245 and debt 48,300", () => {
    assert.equal(round(assets), 24245);
    assert.equal(round(debt), 48300);
  });

  const delta = netWorth - opening;
  check("Δ net worth == income − expense, to the halala", () =>
    assert.equal(round(delta), round(m.income - m.expense)));
  check("and that figure is +10,945", () => assert.equal(round(delta), 10945));

  // §3.3a, stated as a number: the same account read the other way round moves
  // net worth by roughly the whole credit limit.
  const card = accounts.find((a) => a.slug === "card");
  const asDebt = toView(card);
  const misread = toView({ ...card, balanceSemantics: "balance" });
  check("reading available_credit as a balance swings net worth by the limit", () =>
    assert.equal(round(asDebt.net - misread.net), CARD_LIMIT));

  // The card is paid in full, so it contributes nothing — but it must
  // contribute nothing as a ZERO liability, not as a 10,000 asset.
  check("a fully-paid card contributes zero, not its available credit", () =>
    assert.equal(round(asDebt.net), 0));
}

console.log("\n[3] SPLITS COUNT ONCE, AND UNCATEGORIZED IS COUNTED AT ALL (§9.6, §11.2)");
{
  // A split purchase and an uncategorized one, inside the same cycle.
  await july.db.exec(`
    INSERT INTO transactions (id, account_id, posted_at, amount, direction, type, category_id)
    VALUES ('d0000000-0000-4000-a000-000000000001', '${july.ids.checking}',
            '2026-08-03T12:00:00+03', 300.00, 'debit', 'purchase', NULL),
           ('d0000000-0000-4000-a000-000000000002', '${july.ids.checking}',
            '2026-08-04T12:00:00+03', 45.50, 'debit', 'purchase', NULL);

    INSERT INTO transaction_splits (transaction_id, category_id, amount) VALUES
      ('d0000000-0000-4000-a000-000000000001', '${CATEGORIES.groceries}', 100.00),
      ('d0000000-0000-4000-a000-000000000001', '${CATEGORIES.restaurants}',    200.00);
  `);

  const m = await measure(july.db, JULY);
  check("the 3-leg split adds its 300 exactly once", () =>
    assert.equal(round(m.expense), 1100 + 300 + 45.5));

  const byCategory = await rows(
    july.db,
    `SELECT COALESCE(c.name, 'Uncategorized') AS name, sum(v.amount) AS total
       FROM v_categorized_amounts v
       LEFT JOIN categories c ON c.id = v.category_id
      WHERE v.cycle_start = '${JULY}'::date AND ${IS_EXPENSE_SQL}
      GROUP BY 1 ORDER BY 1`,
  );

  const named = Object.fromEntries(byCategory.map((r) => [r.name, round(Number(r.total))]));
  check("Groceries carries the unsplit 800 and the split's 100 leg", () =>
    assert.equal(named.Groceries, 900));
  check("Restaurants carries only its own leg", () =>
    assert.equal(named.Restaurants, 200));
  check("the rollup sums back to the cycle's expense", () =>
    assert.equal(round(Object.values(named).reduce((s, v) => s + v, 0)), m.expense));
  check("uncategorized is a first-class row, not a hidden one", () =>
    assert.equal(named.Uncategorized, 45.5));
  check("and the uncategorized predicate agrees with it", () =>
    assert.equal(round(m.uncategorized), 45.5));
}

console.log("\n[4] PACING DIVIDES BY THE ACTUAL CYCLE LENGTH — 28 AND 31, NEVER 30");
{
  const february = await boot(FEBRUARY);

  const short = await measure(february.db, FEBRUARY);

  // Same events, same money. Only the calendar differs. (July's fixture has
  // picked up the split and the early salary from the sections above, so the
  // comparison is against §6's figures rather than against that.)
  check("the two cycles report the same expense — the accounting is unchanged", () =>
    assert.equal(round(short.expense), 1100));
  check("and the same income", () => assert.equal(round(short.income), 12045));

  const longDays = daysInPeriod("cycle", JULY);
  const shortDays = daysInPeriod("cycle", FEBRUARY);

  check("25 Jul – 24 Aug is 31 days", () => assert.equal(longDays, 31));
  check("25 Feb – 24 Mar is 28 days", () => assert.equal(shortDays, 28));

  // The database and the TypeScript agree about the length, which is what lets
  // the page bucket in SQL and pace in the browser.
  const sqlLength = await one(
    july.db,
    `SELECT (period_end('${JULY}'::date) - period_start('${JULY}'::date) + 1) AS days`,
  );
  check("SQL and lib/periods.ts agree on the length", () =>
    assert.equal(Number(sqlLength.days), longDays));

  const BUDGET = 5000;
  const SPENT = 1100;
  const DAY = 18;

  const longPace = pace({ budget: BUDGET, spent: SPENT, elapsed: DAY, total: longDays });
  const shortPace = pace({ budget: BUDGET, spent: SPENT, elapsed: DAY, total: shortDays });
  const wrongPace = pace({ budget: BUDGET, spent: SPENT, elapsed: DAY, total: 30 });

  check("day 18 is 58% of a 31-day cycle and 64% of a 28-day one", () => {
    assert.equal(Math.round(longPace.elapsedShare * 100), 58);
    assert.equal(Math.round(shortPace.elapsedShare * 100), 64);
  });
  check("a hardcoded 30 agrees with neither", () => {
    assert.notEqual(Math.round(wrongPace.elapsedShare * 100), Math.round(longPace.elapsedShare * 100));
    assert.notEqual(Math.round(wrongPace.elapsedShare * 100), Math.round(shortPace.elapsedShare * 100));
  });

  check("weeks left is fractional — 1.9 in July, 1.4 in February", () => {
    assert.equal(round(longPace.weeksLeft), 1.86);
    assert.equal(round(shortPace.weeksLeft), 1.43);
  });

  check("remaining_pace differs between the two cycles by ~630 a week", () => {
    assert.equal(round(longPace.remainingPace), 2100);
    assert.equal(round(shortPace.remainingPace), 2730);
  });

  // §11.2 — "Using cycle_budget ÷ 4 is wrong: a cycle averages 4.43 weeks."
  check("fair_share is day-weighted, and ÷4 understates it in a 31-day cycle", () => {
    assert.equal(round(longPace.fairShare), 1129.03);
    assert.notEqual(round(longPace.fairShare), BUDGET / 4);
    // February's cycle really is four weeks; the shortcut is right exactly here
    // and nowhere else, which is why it survives long enough to ship.
    assert.equal(round(shortPace.fairShare), BUDGET / 4);
  });

  check("the projection runs at the actual rate to the actual end", () => {
    assert.equal(round(longPace.projected), round((SPENT / DAY) * 31));
    assert.equal(round(shortPace.projected), round((SPENT / DAY) * 28));
  });

  check("the verdict reads the pace, not the total", () => {
    // 22% of the budget spent, 58% of the cycle gone: comfortably ahead.
    assert.equal(longPace.verdict, "Ahead");
    assert.equal(pace({ budget: 1000, spent: 900, elapsed: 18, total: 31 }).verdict, "Over");
    assert.equal(pace({ budget: 1000, spent: 580, elapsed: 18, total: 31 }).verdict, "On pace");
  });

  // §11.5's rule, applied to the pacing figure it is the twin of: an overspend
  // is shown as an overspend, never clamped to zero.
  const blown = pace({ budget: 1000, spent: 1800, elapsed: 18, total: 31 });
  check("a blown budget yields a NEGATIVE remaining pace, not zero", () => {
    assert.equal(blown.remainingPace < 0, true);
    assert.equal(round(blown.remainingPace), -430.77);
  });

  check("no budget yields no verdict rather than a false one", () => {
    const none = pace({ budget: null, spent: SPENT, elapsed: DAY, total: longDays });
    assert.equal(none.verdict, null);
    assert.equal(none.remainingPace, null);
    assert.equal(round(none.projected), round((SPENT / DAY) * 31));
  });

  await february.db.close();
}

console.log("\n[5] CYCLE OVERRIDE MOVES THE CYCLE, NEVER THE WEEK (§5.6)");
{
  // A salary credited Thursday 23 July for a due date of 25 July: it funds the
  // cycle it opens, whatever date it landed on.
  await july.db.exec(`
    INSERT INTO transactions
      (id, account_id, posted_at, amount, direction, type, income_class, cycle_override)
    VALUES ('d0000000-0000-4000-a000-00000000000e', '${july.ids.checking}',
            '2026-07-23T14:04:00+03', 500.00, 'credit', 'income', 'earned', '2026-07-25')`);

  const r = await one(
    july.db,
    `SELECT cycle_start::text AS cycle_start, week_start::text AS week_start
       FROM v_categorized_amounts
      WHERE transaction_id = 'd0000000-0000-4000-a000-00000000000e'`,
  );

  check("the override puts the early salary in the cycle it funds", () =>
    assert.equal(r.cycle_start, "2026-07-25"));
  check("the week bucket is a literal date range and ignores it", () =>
    assert.equal(r.week_start, "2026-07-19"));
  check("lib/periods.ts computes the same week from the posting date", () =>
    assert.equal(weekStart("2026-07-23"), "2026-07-19"));

  const m = await measure(july.db, JULY);
  check("and the cycle's income rose by exactly the early salary", () =>
    assert.equal(round(m.earned), 12500));
}

console.log("\n[6] ROLLOVER CARRIES BOTH DIRECTIONS (§11.2)");
{
  const history = (spends, rollover = true) =>
    spends.map((spent, i) => ({
      cycleStart: `2026-0${i + 3}-25`,
      base: 1000,
      rollover,
      spent,
    }));

  check("underspend raises the next cycle's allowance", () =>
    assert.equal(foldCarry(history([800, 0])), 200));
  check("overspend lowers it — that is the honest version", () =>
    assert.equal(foldCarry(history([1400, 0])), -400));
  check("carry accumulates across cycles rather than resetting", () =>
    assert.equal(foldCarry(history([800, 900, 0])), 300));
  check("a category without rollover carries nothing", () =>
    assert.equal(foldCarry(history([500, 0], false)), 0));

  // The guard §11.2 asks for: base and carry stay separate all the way to the
  // screen, so 2,000 − 1,800 never renders as "a 200 budget".
  check("effective budget is base + carry, and both survive the trip", () => {
    assert.equal(effectiveBudget(2000, -1800), 200);
    assert.equal(effectiveBudget(1000, 250), 1250);
  });

  const squeezed = pace({ budget: effectiveBudget(2000, -1800), spent: 300, elapsed: 5, total: 31 });
  check("spending against an exhausted carry reads as Over, not as a small budget", () =>
    assert.equal(squeezed.verdict, "Over"));
}

console.log("\n[7] NET WORTH OVER TIME READS CARDS THROUGH toView() (§11.1 chart 4)");
{
  const { accounts } = await netWorthOf(july.db);

  await july.db.exec(`
    INSERT INTO balance_snapshots (account_id, balance, source, as_of) VALUES
      ('${july.ids.checking}', 10000.00, 'sms', '2026-07-25T09:00:00+03'),
      ('${july.ids.checking}', 15200.00, 'sms', '2026-08-08T09:00:00+03'),
      -- The card reports AVAILABLE credit, and a purchase lowers it.
      ('${july.ids.card}',      9200.00, 'sms', '2026-07-27T09:00:00+03'),
      ('${july.ids.card}',     10000.00, 'sms', '2026-08-01T09:00:00+03')`);

  const snapshots = (
    await rows(
      july.db,
      `SELECT account_id, local_date(as_of)::text AS day, balance
         FROM balance_snapshots ORDER BY as_of`,
    )
  ).map((s) => ({ accountId: s.account_id, day: s.day, balance: Number(s.balance) }));

  const series = netWorthSeries(accounts, snapshots, "2026-07-25", "2026-08-10");

  check("one point per day across the window", () => assert.equal(series.length, 17));
  check("the series has shape, so it is worth drawing", () =>
    assert.equal(hasShape(series), true));

  const at = (day) => series.find((p) => p.day === day).value;

  // On 27 July the card reports 9,200 available against a 10,000 limit: 800 of
  // debt. Read the other way it would be an 9,200 asset — an 18,400 swing.
  check("a card mid-cycle contributes limit − available as DEBT", () =>
    assert.equal(round(at("2026-07-27") - at("2026-07-26")), -800));
  check("and paying it off returns exactly that", () =>
    assert.equal(round(at("2026-08-01") - at("2026-07-31")), 800));

  // Accounts that never snapshot sit at their opening balance rather than at
  // zero: SAIB states no balance in any message (§3.3b), and dropping those
  // accounts would draw a rise that never happened.
  check("an account with no snapshot holds its opening balance", () =>
    assert.equal(round(at("2026-07-25")), 10000 + 5000 - 0 - 50000));
}

console.log("\n[8] ALERTS RANK BY SEVERITY, AND THE DERIVED ONE CANNOT BE DISMISSED (§11.6)");
{
  const now = new Date("2026-08-11T10:00:00Z");
  const row = (id, type, severity, payload = {}) => ({
    id,
    type,
    severity,
    payload,
    createdAt: now,
  });

  const ranked = rankAlerts(
    [
      row("1", "card_due", "info", { account: "Visa", days: 3, slug: "card" }),
      row("2", "reconciliation_drift", "critical", { account: "Current", delta: 240, slug: "checking" }),
      row("3", "budget_overspend", "warning", { category: "Groceries", over: 120 }),
    ],
    reviewQueueAlert(4),
  );

  check("most severe first", () => assert.equal(ranked[0].type, "reconciliation_drift"));
  check("each alert lands on the page that can resolve it", () => {
    assert.equal(ranked[0].href, "/accounts/checking");
    assert.equal(ranked.find((a) => a.type === "card_due").href, "/accounts/card");
    assert.equal(ranked.find((a) => a.type === "review_queue").href, "/review");
  });
  check("the parked-queue alert is derived, so it is not dismissible", () =>
    assert.equal(ranked.find((a) => a.type === "review_queue").dismissible, false));
  check("an empty queue raises nothing", () => assert.equal(reviewQueueAlert(0).length, 0));
  check("an unknown type still renders rather than being dropped", () => {
    const [only] = rankAlerts([row("9", "some_future_thing", "warning")]);
    assert.equal(only.title, "Some future thing");
  });
}

console.log("\n[9] CHART WINDOWS ARE LABELLED AT THE GRAIN THEY ARE DRAWN AT");
{
  check("a cycle's axis label names the month it ENDS in", () =>
    assert.equal(shortLabel("cycle", JULY), "Aug"));
  check("a week's names its Sunday", () =>
    assert.equal(shortLabel("week", "2026-08-11"), "9 Aug"));

  // §5.3 — the in-progress bucket is the one that must be marked partial, and
  // it is the only one in a trailing window that can be.
  const { start } = periodBounds("week", "2026-08-11");
  const elapsed = daysElapsed("week", start, "2026-08-11");
  check("a week containing today is 3 of 7 days, not 7", () => assert.equal(elapsed, 3));
  check("a week that has closed is whole", () =>
    assert.equal(daysElapsed("week", "2026-08-02", "2026-08-11"), 7));
  check("a cycle in progress reports its real elapsed day", () =>
    assert.equal(daysElapsed("cycle", JULY, "2026-08-11"), 18));
}

await july.db.close();
console.log(`\n${"=".repeat(62)}\nALL ${n} HOME-AGGREGATE CHECKS PASS\n${"=".repeat(62)}`);
