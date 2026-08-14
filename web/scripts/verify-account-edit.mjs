/**
 * Editing an account, in two tiers (SPEC §3.3, §9.4).
 *
 * The rules first, with no database. Then the write itself against real
 * Postgres, because the invariant that makes this feature work at all is one no
 * unit test can reach:
 *
 *   after a balance is edited, the parser's own
 *   `opening_balance + Σ(posted legs)` must still equal the balance that was
 *   typed.
 *
 * If it does not, the next tick recomputes the balance and silently reverts the
 * edit. The symptom is a number that goes back to being wrong overnight, with
 * nothing in any log to say why — so the formula from `recompute_balances` is
 * copied verbatim below and run against the edited account.
 *
 * Run: npm run test:account-edit
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

const { adjustmentFor, diff, normalise, parseAmount, validate, isLiabilityFor } =
  await load("lib/account-edit.ts");

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

const draft = (over = {}) => ({
  name: "Card",
  type: "credit_card",
  balanceSemantics: "available_credit",
  reconcilable: true,
  creditLimit: "14000.00",
  statementDay: 15,
  dueDay: 5,
  isProfitBearing: false,
  profitPayoutDay: null,
  ...over,
});

console.log("\n[1] MONEY IS COMPARED IN HALALAS, NOT FLOATS");
{
  check("two decimals in, halalas out", () => assert.equal(parseAmount("9610.09"), 961009));
  check("thousands separators are tolerated", () => assert.equal(parseAmount("14,000"), 1400000));
  check("three decimals are refused", () => assert.equal(parseAmount("1.005"), null));
  check("a word is refused", () => assert.equal(parseAmount("لا"), null));

  // 9610.09 − 9500 is 110.09000000000015 in floating point. Stored at
  // NUMERIC(14,2) the leg would round while the balance did not, leaving a
  // one-halala drift behind a correction that was exactly right.
  const a = adjustmentFor("9500.00", "9610.09", "available_credit");
  check("a float-hostile delta is exact", () => assert.equal(a.amount, "110.09"));
}

console.log("\n[2] THE ADJUSTMENT LEG");
{
  const up = adjustmentFor("1000.00", "1250.00", "balance");
  check("more money than we thought is a credit", () => assert.equal(up.direction, "credit"));
  check("of the difference, not the total", () => assert.equal(up.amount, "250.00"));

  const down = adjustmentFor("1000.00", "750.00", "balance");
  check("less is a debit", () => assert.equal(down.direction, "debit"));
  check("the amount is never signed", () => assert.equal(down.amount, "250.00"));

  check("an unchanged balance books nothing", () =>
    assert.equal(adjustmentFor("1000.00", "1000.00", "balance"), null));
  check("and neither does the same figure written differently", () =>
    assert.equal(adjustmentFor("1000.00", "1,000", "balance"), null));

  // §3.3a. On a card the stored figure is available credit, so MORE available
  // is a credit leg and means LESS debt — the arithmetic is the same as an
  // asset's, only the interpretation differs.
  const card = adjustmentFor("9000.00", "9610.09", "available_credit");
  check("raising available credit is still a credit", () => assert.equal(card.direction, "credit"));
  check("and says so in words", () =>
    assert.match(card.description, /^Available credit set to 9,610\.09 \(was 9,000\.00\)$/));

  const overdrawn = adjustmentFor("0.00", "-250.00", "balance");
  check("an overdrawn balance keeps its minus sign", () =>
    assert.match(overdrawn.description, /set to −250\.00/));
}

console.log("\n[3] THE FIELDS THAT DECIDE THE SIGN OF NET WORTH (§3.3a)");
{
  check("a card whose figure is available credit needs a limit", () =>
    assert.match(
      validate(draft({ creditLimit: null }), null),
      /needs a credit limit/,
    ));
  check("because without one the available credit reads as debt", () => {
    // toView() falls through to the plain-liability branch when limit is null:
    // debt = balance, i.e. the 9,610 you can still spend booked as 9,610 owed.
    assert.equal(validate(draft({ creditLimit: "14000.00" }), null), null);
  });
  check("a zero limit is not a limit", () =>
    assert.match(validate(draft({ creditLimit: "0" }), null), /positive/));
  check("is_liability is derived from the type, never typed in", () => {
    assert.equal(isLiabilityFor("credit_card"), true);
    assert.equal(isLiabilityFor("loan"), true);
    assert.equal(isLiabilityFor("savings"), false);
  });
  check("a 31st is refused — not every month has one", () =>
    assert.match(validate(draft({ dueDay: 31 }), null), /between 1 and 28/));
  check("an unparseable balance is refused before it is booked", () =>
    assert.match(validate(draft(), "about 500"), /at most two decimals/));
}

console.log("\n[4] CHANGING THE TYPE TAKES THE CARD FIELDS WITH IT");
{
  const moved = normalise(draft({ type: "savings" }));
  check("available_credit does not survive leaving a card", () =>
    assert.equal(moved.balanceSemantics, "balance"));
  check("nor does the limit", () => assert.equal(moved.creditLimit, null));
  check("nor the statement dates", () =>
    assert.deepEqual([moved.statementDay, moved.dueDay], [null, null]));
  check("a payout day without profit is dropped", () =>
    assert.equal(normalise(draft({ profitPayoutDay: 25 })).profitPayoutDay, null));
}

console.log("\n[5] THE DIFF IS WHAT GETS WRITTEN DOWN");
{
  const before = { ...draft(), isLiability: true, currentBalance: "9000.00" };
  const after = { ...draft({ name: "AlRajhi Visa" }), isLiability: true, currentBalance: "9000.00" };
  const d = diff(before, after);

  check("only the field that moved", () => assert.deepEqual(Object.keys(d), ["name"]));
  check("with both sides of it", () =>
    assert.deepEqual(d.name, { from: "Card", to: "AlRajhi Visa" }));

  check("14000 and 14000.00 are the same limit", () =>
    assert.deepEqual(diff(before, { ...after, name: "Card", creditLimit: "14000" }), {}));

  const retyped = diff(before, {
    ...draft({ type: "savings", balanceSemantics: "balance", creditLimit: null }),
    isLiability: false,
    currentBalance: "9000.00",
  });
  check("becoming an asset is recorded as such", () =>
    assert.deepEqual(retyped.isLiability, { from: "yes", to: "no" }));
  check("in readable words, not enum names", () =>
    assert.deepEqual(retyped.type, { from: "Credit card", to: "Savings" }));
}

/* ------------------------------------------------------------ real Postgres */

const { applyAccountEdit } = await load("db/account-edit.ts");

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

/** `recompute_balances` from api/db.py, verbatim, as the parser would run it
 *  on its next tick. */
const recompute = () =>
  pg.exec(`
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
  `);

await pg.exec(`
  -- Seeded as reconcilable; the edit in [6] turns that off, which is the real
  -- SAIB story (§3.3b) and puts a field change and a balance change in one save.
  INSERT INTO accounts (slug, name, institution, type, reconcilable,
                        opening_balance, current_balance)
  VALUES ('saib_current', 'Current', 'SAIB', 'checking', true, '1000.00', '1000.00');
  INSERT INTO accounts (slug, name, institution, type, is_liability,
                        balance_semantics, opening_balance, current_balance, credit_limit)
  VALUES ('ar_card', 'Visa', 'AlRajhiBank', 'credit_card', true,
          'available_credit', '9000.00', '9000.00', '14000.00');
`);

const account = async (slug) => one(`SELECT * FROM accounts WHERE slug = '${slug}'`);
const current = await account("saib_current");
const card = await account("ar_card");

// A parsed transaction already on the account, so the balance under test is a
// derived figure rather than the seeded one.
await pg.exec(`
  INSERT INTO transactions (account_id, posted_at, amount, direction, type, state)
  VALUES ('${current.id}', now() - interval '2 days', '250.00', 'debit', 'purchase', 'posted');
`);
await recompute();

console.log("\n[6] A BALANCE EDIT BOOKS A LEDGER ENTRY");
{
  await acheck("the balance starts derived, at 750.00", async () =>
    assert.equal((await account("saib_current")).current_balance, "750.00"));

  const res = await applyAccountEdit(db, {
    accountId: current.id,
    draft: {
      name: "Current",
      type: "checking",
      balanceSemantics: "balance",
      reconcilable: false,
      creditLimit: null,
      statementDay: null,
      dueDay: null,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: "1,912.40",
    note: "SAIB app, 14 Aug",
  });

  assert.equal(res.ok, true, res.ok ? "" : res.error);

  const legs = await rows(
    `SELECT * FROM transactions WHERE account_id = '${current.id}' AND type = 'adjustment'`,
  );
  check("exactly one adjustment was booked", () => assert.equal(legs.length, 1));
  check("for the difference", () => assert.equal(legs[0].amount, "1162.40"));
  check("as a credit, because there was more money than we knew", () =>
    assert.equal(legs[0].direction, "credit"));
  check("origin manual, so replay never touches it (§9.4)", () =>
    assert.equal(legs[0].origin, "manual"));
  check("excluded from analytics — a correction is not income (§6)", () =>
    assert.equal(legs[0].excluded_from_analytics, true));
  check("and it says what it is, for the ledger row", () =>
    assert.equal(legs[0].description, "Balance set to 1,912.40 (was 750.00)"));
  check("the note is kept with it", () => assert.equal(legs[0].notes, "SAIB app, 14 Aug"));

  await acheck("the account shows the typed figure immediately", async () =>
    assert.equal((await account("saib_current")).current_balance, "1912.40"));

  // The point of the whole design.
  await recompute();
  await acheck("and the parser's next tick arrives at the same figure", async () =>
    assert.equal((await account("saib_current")).current_balance, "1912.40"));

  await acheck("a manual snapshot was written (§3.3b)", async () => {
    const snap = await one(
      `SELECT * FROM balance_snapshots WHERE account_id = '${current.id}'`,
    );
    assert.equal(snap.source, "manual");
    assert.equal(snap.balance, "1912.40");
  });

  await acheck("the edit is on the record, linked to its leg", async () => {
    const edit = await one(`SELECT * FROM account_edits WHERE account_id = '${current.id}'`);
    assert.equal(edit.adjustment_transaction_id, legs[0].id);
    assert.deepEqual(edit.changed.reconcilable, { from: "yes", to: "no" });
    assert.equal(edit.note, "SAIB app, 14 Aug");
  });
}

console.log("\n[7] AN EDIT THAT CHANGES NOTHING RECORDS NOTHING");
{
  const res = await applyAccountEdit(db, {
    accountId: current.id,
    draft: {
      name: "Current",
      type: "checking",
      balanceSemantics: "balance",
      reconcilable: false,
      creditLimit: null,
      statementDay: null,
      dueDay: null,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    // Resubmitting the same balance the form was populated with. Booking a
    // zero leg for every rename would fill the ledger with entries that
    // describe nothing.
    targetBalance: "1912.40",
    note: null,
  });

  assert.equal(res.ok, true);
  check("no second adjustment", () => assert.equal(res.outcome.adjustment, null));
  await acheck("no second edit record", async () =>
    assert.equal(
      (await rows(`SELECT id FROM account_edits WHERE account_id = '${current.id}'`)).length,
      1,
    ));
}

console.log("\n[8] A RENAME IS RECORDED, BUT NOT AS A TRANSACTION");
{
  const res = await applyAccountEdit(db, {
    accountId: current.id,
    draft: {
      name: "SAIB current",
      type: "checking",
      balanceSemantics: "balance",
      reconcilable: false,
      creditLimit: null,
      statementDay: null,
      dueDay: null,
      isProfitBearing: true,
      profitPayoutDay: 1,
    },
    targetBalance: null,
    note: null,
  });

  assert.equal(res.ok, true);
  check("nothing is booked", () => assert.equal(res.outcome.adjustment, null));
  check("every field that moved is recorded", () =>
    assert.deepEqual(Object.keys(res.outcome.changed).sort(), [
      "isProfitBearing",
      "name",
      "profitPayoutDay",
    ]));
  check("an unset field reads as unset, not as a value", () =>
    assert.deepEqual(res.outcome.changed.profitPayoutDay, { from: null, to: "1" }));
  await acheck("still one adjustment on the account", async () =>
    assert.equal(
      (await rows(
        `SELECT id FROM transactions WHERE account_id = '${current.id}' AND type = 'adjustment'`,
      )).length,
      1,
    ));
  await acheck("the account was actually updated", async () => {
    const a = await account("saib_current");
    assert.equal(a.name, "SAIB current");
    assert.equal(a.profit_payout_day, 1);
  });
}

console.log("\n[9] ON A CARD, A HIGHER FIGURE MEANS LESS DEBT (§3.3a)");
{
  const res = await applyAccountEdit(db, {
    accountId: card.id,
    draft: {
      name: "Visa",
      type: "credit_card",
      balanceSemantics: "available_credit",
      reconcilable: true,
      creditLimit: "14000.00",
      statementDay: 15,
      dueDay: 5,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: "9610.09",
    note: null,
  });

  assert.equal(res.ok, true, res.ok ? "" : res.error);
  check("the leg is a credit", () => assert.equal(res.outcome.adjustment.direction, "credit"));

  await recompute();
  const a = await account("ar_card");
  check("available credit rose to the typed figure", () =>
    assert.equal(a.current_balance, "9610.09"));
  check("so debt FELL — limit minus available", () =>
    assert.equal((Number(a.credit_limit) - Number(a.current_balance)).toFixed(2), "4389.91"));
  check("the account is still a liability", () => assert.equal(a.is_liability, true));
}

console.log("\n[10] A CORRECTED BALANCE ANSWERS AN OPEN DRIFT ALERT (§3.3)");
{
  await pg.exec(`
    INSERT INTO reconciliation_alerts (account_id, computed_balance, reported_balance, delta)
    VALUES ('${card.id}', '9610.09', '9500.00', '110.09');
  `);

  await applyAccountEdit(db, {
    accountId: card.id,
    draft: {
      name: "Visa",
      type: "credit_card",
      balanceSemantics: "available_credit",
      reconcilable: true,
      creditLimit: "14000.00",
      statementDay: 15,
      dueDay: 5,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: "9500.00",
    note: "matched the app",
  });

  await acheck("the alert is closed, and says by what", async () => {
    const al = await one(`SELECT * FROM reconciliation_alerts WHERE account_id = '${card.id}'`);
    assert.notEqual(al.resolved_at, null);
    assert.equal(al.resolution_note, "balance corrected by hand");
  });
}

console.log("\n[11] ONLY THE FIELD THAT CHANGED IS WRITTEN");
{
  // Columns the sheet does not offer, plus one it does but this edit will not
  // touch. A save that writes the whole row would flatten all of them back to
  // whatever the form was rendered with.
  await pg.exec(`
    UPDATE accounts
       SET sort_order = 4, is_active = false, statement_day = 15, due_day = 5
     WHERE slug = 'ar_card'
  `);

  const before = await account("ar_card");

  const res = await applyAccountEdit(db, {
    accountId: card.id,
    draft: {
      name: "AlRajhi Visa Signature",
      type: "credit_card",
      balanceSemantics: "available_credit",
      reconcilable: true,
      creditLimit: "14000.00",
      statementDay: 15,
      dueDay: 5,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: null,
    note: null,
  });

  assert.equal(res.ok, true, res.ok ? "" : res.error);
  check("the rename is the only change reported", () =>
    assert.deepEqual(Object.keys(res.outcome.changed), ["name"]));

  const after = await account("ar_card");
  check("and the only column that moved", () => {
    const moved = Object.keys(after).filter(
      (k) => String(after[k]) !== String(before[k]),
    );
    assert.deepEqual(moved, ["name"]);
  });
  check("the columns the sheet never offers are intact", () => {
    assert.equal(after.sort_order, 4);
    // Untouched by the UPDATE above too — it is the cold-start anchor every
    // balance is derived from, and the sheet has no business writing it.
    assert.equal(after.opening_balance, "9000.00");
    assert.equal(after.is_active, false);
    assert.equal(after.slug, "ar_card");
  });
}

console.log("\n[12] A BALANCE NOBODY TOUCHED IS LEFT ALONE");
{
  // The sheet is open, showing 9,500.00. A message lands and the parser posts
  // a 120.00 purchase, so the real figure is now 9,380.00. The person renames
  // the account and saves — the balance field still holds what the page was
  // rendered with.
  await pg.exec(`
    INSERT INTO transactions (account_id, posted_at, amount, direction, type, state)
    VALUES ('${card.id}', now(), '120.00', 'debit', 'purchase', 'posted');
  `);
  await recompute();
  await acheck("the parser moved it to 9,380.00", async () =>
    assert.equal((await account("ar_card")).current_balance, "9380.00"));

  const res = await applyAccountEdit(db, {
    accountId: card.id,
    draft: {
      name: "AlRajhi Visa",
      type: "credit_card",
      balanceSemantics: "available_credit",
      reconcilable: true,
      creditLimit: "14000.00",
      statementDay: 15,
      dueDay: 5,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: "9500.00",
    knownBalance: "9500.00",
    note: null,
  });

  assert.equal(res.ok, true, res.ok ? "" : res.error);
  check("nothing is booked against the stale figure", () =>
    assert.equal(res.outcome.adjustment, null));
  await acheck("so the purchase that just posted still stands", async () =>
    assert.equal((await account("ar_card")).current_balance, "9380.00"));
  await acheck("and the rename went through", async () =>
    assert.equal((await account("ar_card")).name, "AlRajhi Visa"));
}

console.log("\n[13] A BALANCE SOMEBODY DID TYPE STILL WINS");
{
  // Same stale form, but this time the figure was read off the bank app and
  // typed in. It is an absolute target, so the leg is computed from the CURRENT
  // balance — 9,380.00 — not from the one the page was showing.
  const res = await applyAccountEdit(db, {
    accountId: card.id,
    draft: {
      name: "AlRajhi Visa",
      type: "credit_card",
      balanceSemantics: "available_credit",
      reconcilable: true,
      creditLimit: "14000.00",
      statementDay: 15,
      dueDay: 5,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: "9,000.00",
    knownBalance: "9500.00",
    note: null,
  });

  assert.equal(res.ok, true, res.ok ? "" : res.error);
  check("the leg is the gap from the real balance, not the shown one", () =>
    assert.equal(res.outcome.adjustment.amount, "380.00"));
  await recompute();
  await acheck("and it lands exactly on the typed figure", async () =>
    assert.equal((await account("ar_card")).current_balance, "9000.00"));
}

console.log("\n[14] A REFUSED EDIT CHANGES NOTHING AT ALL");
{
  const res = await applyAccountEdit(db, {
    accountId: card.id,
    draft: {
      name: "Visa",
      type: "credit_card",
      balanceSemantics: "available_credit",
      reconcilable: true,
      creditLimit: null,
      statementDay: 15,
      dueDay: 5,
      isProfitBearing: false,
      profitPayoutDay: null,
    },
    targetBalance: "100.00",
    note: null,
  });

  check("it is refused", () => assert.equal(res.ok, false));
  await acheck("and the balance is untouched", async () =>
    assert.equal((await account("ar_card")).current_balance, "9000.00"));
}

await pg.close();

console.log(`\n${"=".repeat(60)}\nALL ${n} ACCOUNT-EDIT CHECKS PASS\n${"=".repeat(60)}`);
