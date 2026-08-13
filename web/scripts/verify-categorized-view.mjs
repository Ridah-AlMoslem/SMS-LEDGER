/**
 * The categorized-amount view and split integrity (SPEC §9.6, §13).
 *
 * A transaction is categorized either on its own row or across
 * `transaction_splits` — never both. Every aggregate in the app has to handle
 * both, and §9.6 is emphatic that a query which forgets will either
 * double-count split transactions or drop them silently. Both failures produce
 * a number that looks entirely reasonable.
 *
 * So the invariant asserted here is the one from §13: summing
 * `v_categorized_amounts` over a mix of split and unsplit transactions must
 * equal total spend *exactly*. Exactly, not to within rounding — the sums are
 * compared in NUMERIC inside the database, because comparing them in
 * JavaScript floats would be a test that agrees with the bug it is looking for.
 *
 * Run: npm run test:categorized
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, "..", "drizzle");

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  PASS  ${name}`);
};

const db = await new PGlite();

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

const rows = async (sql) => (await db.query(sql)).rows;
const one = async (sql) => (await rows(sql))[0];
const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/** Runs a block in its own transaction and returns the COMMIT-time error, if
 *  any. Deferred constraint triggers fire at commit, not at statement time. */
async function attempt(statements) {
  await db.exec("BEGIN");
  try {
    for (const s of statements) await db.exec(s);
    await db.exec("COMMIT");
    return null;
  } catch (err) {
    await db.exec("ROLLBACK").catch(() => {});
    return err.message;
  }
}

/* ------------------------------------------------------------- the ledger */

const A = "11111111-1111-1111-1111-111111111111"; // account
const C = {
  groceries: "c0000000-0000-0000-0000-000000000001",
  dining: "c0000000-0000-0000-0000-000000000002",
  transport: "c0000000-0000-0000-0000-000000000003",
};
const T = {
  groceries: "d0000000-0000-0000-0000-000000000001", // unsplit, 800.00
  costco: "d0000000-0000-0000-0000-000000000002", // split 3 ways, 300.00
  uncategorized: "d0000000-0000-0000-0000-000000000003", // unsplit, no category
  loan: "d0000000-0000-0000-0000-000000000004", // 2000.00, not an expense
  toSavings: "d0000000-0000-0000-0000-000000000005", // 1000.00 internal
  salary: "d0000000-0000-0000-0000-000000000006", // 12000.00 credit
};

await db.exec(`
  INSERT INTO accounts (id, slug, name, institution, type)
  VALUES ('${A}', 'checking', 'Checking', 'SAIB', 'checking');

  INSERT INTO categories (id, name) VALUES
    ('${C.groceries}', 'Groceries'),
    ('${C.dining}', 'Dining'),
    ('${C.transport}', 'Transport');

  INSERT INTO transactions
    (id, account_id, posted_at, amount, direction, type, category_id,
     is_internal_transfer, excluded_from_analytics)
  VALUES
    ('${T.groceries}',     '${A}', '2026-08-11T10:00:00+03', 800.00,   'debit',  'purchase',     '${C.groceries}', false, false),
    ('${T.costco}',        '${A}', '2026-08-12T10:00:00+03', 300.00,   'debit',  'purchase',     NULL,             false, false),
    ('${T.uncategorized}', '${A}', '2026-08-13T10:00:00+03', 45.50,    'debit',  'purchase',     NULL,             false, false),
    ('${T.loan}',          '${A}', '2026-08-14T10:00:00+03', 2000.00,  'debit',  'loan_payment', NULL,             false, false),
    ('${T.toSavings}',     '${A}', '2026-08-15T10:00:00+03', 1000.00,  'debit',  'transfer',     NULL,             true,  false),
    ('${T.salary}',        '${A}', '2026-07-25T10:00:00+03', 12000.00, 'credit', 'income',       NULL,             false, false);

  INSERT INTO transaction_splits (transaction_id, category_id, amount) VALUES
    ('${T.costco}', '${C.groceries}', 100.00),
    ('${T.costco}', '${C.dining}',    150.00),
    ('${T.costco}', '${C.transport}',  50.00);
`);

/* ------------------------------------------------------- 1. shape of the view */

console.log("\n[1] ONE ROW PER (TRANSACTION, CATEGORY, AMOUNT)");
{
  const counts = await rows(`
    SELECT transaction_id, count(*)::int AS rows, bool_and(is_split) AS split
      FROM v_categorized_amounts GROUP BY transaction_id ORDER BY transaction_id`);

  check("the 3-way split emits exactly three rows", () =>
    assert.equal(counts.find((r) => r.transaction_id === T.costco).rows, 3));
  check("every unsplit transaction emits exactly one row", () =>
    assert.deepEqual(
      counts.filter((r) => r.transaction_id !== T.costco).map((r) => r.rows),
      [1, 1, 1, 1, 1],
    ));

  const total = await one(`SELECT count(*)::int AS n FROM v_categorized_amounts`);
  check("eight rows in total", () => assert.equal(total.n, 8));

  // The failure mode §9.6 warns about: a transaction appearing in both
  // branches would double-count it, and the total would still look sane.
  const both = await one(`
    SELECT count(*)::int AS n FROM (
      SELECT transaction_id FROM v_categorized_amounts
       GROUP BY transaction_id HAVING count(DISTINCT is_split) > 1) x`);
  check("no transaction appears in both branches of the UNION", () =>
    assert.equal(both.n, 0));

  const uncat = await one(
    `SELECT category_id FROM v_categorized_amounts WHERE transaction_id = '${T.uncategorized}'`);
  check("an uncategorized transaction is still emitted, with a null category", () =>
    assert.equal(uncat.category_id, null));
}

/* -------------------------------------------- 2. THE invariant, exactly (§13) */

console.log("\n[2] THE SPLIT-INTEGRITY INVARIANT (§13)");
{
  // Compared inside the database, in NUMERIC. 800 + 300 + 45.50 + 2000 + 1000
  // + 12000 = 16145.50, and the split must contribute its 300 once.
  const r = await one(`
    SELECT (SELECT sum(amount) FROM v_categorized_amounts) AS view_total,
           (SELECT sum(amount) FROM transactions)          AS ledger_total,
           (SELECT sum(amount) FROM v_categorized_amounts)
             = (SELECT sum(amount) FROM transactions)      AS equal`);

  check("Σ view = Σ transactions over a mix of split and unsplit, exactly", () =>
    assert.equal(r.equal, true));
  check("and the figure is the expected 16145.50", () =>
    assert.equal(String(r.view_total), "16145.50"));

  // The same invariant restricted to what §6 calls expense: excludes internal
  // transfers, card and loan payments, and anything excluded from analytics.
  const spend = await one(`
    SELECT sum(amount) AS total,
           sum(amount) = 1145.50::numeric AS exact
      FROM v_categorized_amounts
     WHERE direction = 'debit'
       AND NOT is_internal_transfer
       AND type NOT IN ('card_payment', 'loan_payment')
       AND NOT excluded_from_analytics`);

  check("cycle spend is exactly 1145.50 — 800 + 300 split three ways + 45.50", () =>
    assert.equal(spend.exact, true));
  check("the loan payment's 2000 principal is not in it (§6)", () =>
    assert.equal(Number(spend.total) < 2000, true));

  // Per-category rollup: the split leg lands in Groceries alongside the
  // unsplit purchase, which is the entire point of the view.
  const byCat = await rows(`
    SELECT COALESCE(c.name, 'Uncategorized') AS name, sum(v.amount) AS total
      FROM v_categorized_amounts v
      LEFT JOIN categories c ON c.id = v.category_id
     WHERE v.direction = 'debit'
       AND NOT v.is_internal_transfer
       AND v.type NOT IN ('card_payment', 'loan_payment')
     GROUP BY 1 ORDER BY 1`);

  check("Groceries is 900.00 — the unsplit 800 plus the split's 100 leg", () =>
    assert.equal(String(byCat.find((r) => r.name === "Groceries").total), "900.00"));
  check("Dining and Transport get only their legs", () => {
    assert.equal(String(byCat.find((r) => r.name === "Dining").total), "150.00");
    assert.equal(String(byCat.find((r) => r.name === "Transport").total), "50.00");
  });
  check("Uncategorized is a first-class category, not a hidden one (§11.2)", () =>
    assert.equal(String(byCat.find((r) => r.name === "Uncategorized").total), "45.50"));
  check("the per-category rollup sums back to total spend, to the halala", () =>
    assert.equal(byCat.reduce((s, r) => s + Number(r.total), 0).toFixed(2), "1145.50"));
}

/* --------------------------------------------------- 3. Σ splits = amount */

console.log("\n[3] Σ SPLITS = TRANSACTION AMOUNT, ENFORCED");
{
  const short = await attempt([
    `INSERT INTO transaction_splits (transaction_id, category_id, amount)
     VALUES ('${T.groceries}', '${C.dining}', 700.00)`,
  ]);
  check("legs that do not sum to the whole are rejected at commit", () =>
    assert.match(String(short), /does not equal transaction amount/));

  const dropped = await attempt([
    `DELETE FROM transaction_splits
      WHERE transaction_id = '${T.costco}' AND category_id = '${C.dining}'`,
  ]);
  check("deleting one leg of a split is rejected", () =>
    assert.match(String(dropped), /does not equal transaction amount/));

  const edited = await attempt([
    `UPDATE transactions SET amount = 999.00 WHERE id = '${T.costco}'`,
  ]);
  check("editing the amount out from under existing legs is rejected", () =>
    assert.match(String(edited), /does not equal transaction amount/));

  // What the UI actually does when you re-split: clear the legs and write new
  // ones. Intermediate states are inconsistent by construction, which is why
  // the trigger is DEFERRABLE INITIALLY DEFERRED rather than immediate.
  const resplit = await attempt([
    `DELETE FROM transaction_splits WHERE transaction_id = '${T.costco}'`,
    `INSERT INTO transaction_splits (transaction_id, category_id, amount) VALUES
       ('${T.costco}', '${C.groceries}', 120.00),
       ('${T.costco}', '${C.dining}',    180.00)`,
  ]);
  check("a re-split passing through an inconsistent state is accepted", () =>
    assert.equal(resplit, null));

  const after = await one(`
    SELECT sum(amount) = (SELECT sum(amount) FROM transactions) AS equal
      FROM v_categorized_amounts`);
  check("the invariant still holds after the re-split", () => assert.equal(after.equal, true));

  // Put it back so later sections read against the documented fixture.
  await attempt([
    `DELETE FROM transaction_splits WHERE transaction_id = '${T.costco}'`,
    `INSERT INTO transaction_splits (transaction_id, category_id, amount) VALUES
       ('${T.costco}', '${C.groceries}', 100.00),
       ('${T.costco}', '${C.dining}',    150.00),
       ('${T.costco}', '${C.transport}',  50.00)`,
  ]);

  const unsplit = await attempt([
    `DELETE FROM transaction_splits WHERE transaction_id = '${T.groceries}'`,
  ]);
  check("zero legs is valid — that is a transaction categorized on its row", () =>
    assert.equal(unsplit, null));
}

/* ---------------------------------------- 4. the period columns on the view */

console.log("\n[4] BUCKETS ON THE VIEW (§5.1, §5.2, §5.6)");
{
  const cycles = await rows(`
    SELECT transaction_id, cycle_start, week_start, local_day
      FROM v_categorized_amounts WHERE NOT is_split ORDER BY posted_at`);

  check("every August purchase lands in the 25 Jul – 24 Aug cycle", () =>
    assert.deepEqual(
      [...new Set(cycles.map((r) => iso(r.cycle_start)))],
      ["2026-07-25"],
    ));
  check("weeks are Sunday-anchored", () =>
    assert.equal(
      iso(cycles.find((r) => r.transaction_id === T.groceries).week_start),
      "2026-08-09",
    ));

  const legs = await rows(`
    SELECT DISTINCT cycle_start, week_start
      FROM v_categorized_amounts WHERE transaction_id = '${T.costco}'`);
  check("all legs of one split share its cycle and week", () =>
    assert.equal(legs.length, 1));

  // §5.6 — a salary credited on the 23rd carries an override to the cycle it
  // opens; the week bucket is a literal date range and ignores it.
  await db.exec(`
    UPDATE transactions SET posted_at = '2026-07-23T14:04:00+03',
                            cycle_override = '2026-07-25'
     WHERE id = '${T.salary}'`);

  const salary = await one(`
    SELECT cycle_start, week_start FROM v_categorized_amounts
     WHERE transaction_id = '${T.salary}'`);

  check("the override moves the salary into the cycle it funds", () =>
    assert.equal(iso(salary.cycle_start), "2026-07-25"));
  check("the week bucket ignores the override entirely", () =>
    assert.equal(iso(salary.week_start), "2026-07-19"));

  // The timezone trap, on the view rather than the bare function: 22:30 UTC on
  // the 24th is 01:30 local on the 25th, the first hour of the NEXT cycle.
  await db.exec(`
    INSERT INTO transactions (id, account_id, posted_at, amount, direction, type)
    VALUES ('d0000000-0000-0000-0000-00000000000f', '${A}',
            '2026-08-24T22:30:00Z', 10.00, 'debit', 'purchase')`);

  const edge = await one(`
    SELECT cycle_start, local_day FROM v_categorized_amounts
     WHERE transaction_id = 'd0000000-0000-0000-0000-00000000000f'`);
  check("a 01:30 local purchase on the 25th opens the new cycle, not the old", () => {
    assert.equal(iso(edge.local_day), "2026-08-25");
    assert.equal(iso(edge.cycle_start), "2026-08-25");
  });
}

/* --------------------------------------------- 5. the view is still whole */

console.log("\n[5] THE INVARIANT SURVIVES EVERYTHING ABOVE");
{
  const r = await one(`
    SELECT (SELECT sum(amount) FROM v_categorized_amounts)
             = (SELECT sum(amount) FROM transactions) AS equal,
           (SELECT count(*)::int FROM v_categorized_amounts) AS rows`);
  check("Σ view = Σ transactions after edits, re-splits and an unsplit", () =>
    assert.equal(r.equal, true));
  check("row count reflects the current mix", () => assert.equal(r.rows, 9));
}

await db.close();
console.log(`\n${"=".repeat(60)}\nALL ${n} CATEGORIZED-VIEW CHECKS PASS\n${"=".repeat(60)}`);
