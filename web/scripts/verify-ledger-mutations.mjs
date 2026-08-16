/**
 * The ledger's write path, against real Postgres (SPEC §9.4, §9.6, §5.6, §13).
 *
 * §13 calls replay safety "the highest-consequence test in the suite", and the
 * reason is that every failure here is silent. Nothing throws when a replay
 * reverts a category you fixed last month, or when a deleted transaction comes
 * back on the next tick, or when the splits stop adding up to the whole. The
 * ledger simply starts being wrong, plausibly, and you find out by reconciling
 * by hand.
 *
 * So the checks below are the promises the ledger UI makes, each run against
 * the same functions the app calls — not copies of them:
 *
 *   [1] Σ splits = transaction.amount, enforced by the database and not only
 *       by the form.
 *   [2] Editing a field by hand locks it.
 *   [3] A hand-edited category survives a full replay — the parse pass and the
 *       rules pass both.
 *   [4] A manual transaction survives replay unchanged.
 *   [5] A deleted transaction is not resurrected.
 *   [6] A rule's dry-run count is exactly what applying it changes.
 *   [7] cycle_override moves a transaction between cycles and leaves its week
 *       alone.
 *   [8] Editing an amount invalidates the reconciliation state it invalidates.
 *
 * Run: npm run test:ledger
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
  editTransaction,
  unlockField,
  saveSplits,
  setCycleOverride,
  deleteTransaction,
  bulkEdit,
  createManual,
  convertToManual,
} = await load("db/ledger-mutations.ts");
const { previewRule, createRule, applyRule } = await load("db/rules.ts");
const { replay, replayableMessages } = await load("db/replay.ts");
const { ruleFromTransaction } = await load("lib/rules.ts");
const { periodStart, addMonths, weekStart } = await load("lib/periods.ts");

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

// Seeded category ids from migration 0005. Fixed on purpose: a rule that says
// "Starbucks → Coffee" has to mean the same thing after a rebuild.
const COFFEE = "c0000000-0000-4000-a000-000000000203";
const GROCERIES = "c0000000-0000-4000-a000-000000000201";
const RESTAURANTS = "c0000000-0000-4000-a000-000000000202";
const CASH_CAT = "c0000000-0000-4000-a000-000000000901";

await pg.exec(`
  INSERT INTO accounts (slug, name, institution, type, reconcilable,
                        opening_balance, current_balance)
  VALUES ('alrajhi_current', 'AlRajhi Current', 'AlRajhiBank', 'checking', true,
          '10000.00', '10000.00');
  INSERT INTO accounts (slug, name, institution, type, reconcilable,
                        opening_balance, current_balance)
  VALUES ('saib_current', 'SAIB Current', 'SAIB', 'checking', false, '0.00', '0.00');
`);

const account = await one(`SELECT * FROM accounts WHERE slug = 'alrajhi_current'`);
const saib = await one(`SELECT * FROM accounts WHERE slug = 'saib_current'`);

// A category id that exists, whatever the seed calls it — [1] only needs two
// distinct ones and must not depend on the exact tree.
const cashCategory =
  (await one(`SELECT id FROM categories WHERE id = '${CASH_CAT}'`))?.id ?? RESTAURANTS;

/** One raw message and the transaction the parser derived from it. */
let seq = 0;
async function parsed({
  body,
  amount = "100.00",
  direction = "debit",
  type = "purchase",
  merchant = null,
  biller = null,
  postedAt = "2026-08-10T12:00:00+03:00",
  accountId = account.id,
  categoryId = null,
  confidence = null,
}) {
  seq++;
  const message = await one(`
    INSERT INTO raw_messages (sender, body, received_at, body_hash, status, classification)
    VALUES ('AlRajhiBank', ${lit(body)}, '${postedAt}', 'hash-${seq}', 'parsed', 'financial')
    RETURNING *
  `);

  const tx = await one(`
    INSERT INTO transactions (raw_message_id, account_id, posted_at, amount, direction,
                              type, state, merchant_raw, biller, category_id, origin,
                              confidence)
    VALUES ('${message.id}', '${accountId}', '${postedAt}', '${amount}', '${direction}',
            '${type}', 'posted', ${merchant ? lit(merchant) : "NULL"},
            ${biller ? lit(biller) : "NULL"},
            ${categoryId ? `'${categoryId}'` : "NULL"}, 'parsed',
            ${confidence ?? "NULL"})
    RETURNING *
  `);

  return { message, tx };
}

/** Postgres string literal. The fixtures include Arabic bodies with quotes. */
function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

const txById = (id) => one(`SELECT * FROM transactions WHERE id = '${id}'`);

/* ------------------------------------------------------------------- [1] */

console.log("\n[1] Σ SPLITS = AMOUNT, AND THE DATABASE IS THE ONE ENFORCING IT (§9.6)");
{
  const { tx } = await parsed({ body: "شراء 240.00", amount: "240.00", merchant: "PANDA" });

  const short = await saveSplits(db, {
    transactionId: tx.id,
    splits: [
      { categoryId: GROCERIES, amount: "200.00" },
      { categoryId: RESTAURANTS, amount: "30.00" },
    ],
  });
  check("a split that does not add up is refused", () => assert.equal(short.ok, false));
  check("and the message says what is left to allocate", () =>
    assert.match(short.error, /230\.00 of 240\.00 — 10\.00 still to allocate/));

  await acheck("nothing was written", async () =>
    assert.equal(
      (await rows(`SELECT id FROM transaction_splits WHERE transaction_id = '${tx.id}'`)).length,
      0,
    ));

  // The UI is not the enforcement. This writes the same bad split straight past
  // it, the way a script, a psql session or a future screen would.
  let raised = null;
  try {
    await pg.exec(`
      BEGIN;
      INSERT INTO transaction_splits (transaction_id, category_id, amount)
      VALUES ('${tx.id}', '${GROCERIES}', '200.00');
      COMMIT;
    `);
  } catch (err) {
    raised = err.message;
  }
  check("the database refuses it too, at commit", () =>
    assert.match(raised ?? "", /split total .* does not equal transaction amount/));

  await pg.exec("ROLLBACK").catch(() => {});

  const good = await saveSplits(db, {
    transactionId: tx.id,
    splits: [
      { categoryId: GROCERIES, amount: "200.00" },
      { categoryId: RESTAURANTS, amount: "40.00" },
    ],
  });
  assert.equal(good.ok, true, good.ok ? "" : good.error);

  await acheck("a split that adds up is stored", async () =>
    assert.equal(
      (await rows(`SELECT id FROM transaction_splits WHERE transaction_id = '${tx.id}'`)).length,
      2,
    ));

  await acheck("the row's own category is cleared — the view reads one or the other", async () =>
    assert.equal((await txById(tx.id)).category_id, null));

  await acheck("and cutting a split by hand locks the category (§9.4)", async () =>
    assert.deepEqual((await txById(tx.id)).locked_fields, ["category_id"]));

  await acheck("the view still totals the whole transaction exactly once (§9.6)", async () => {
    const [{ total }] = await rows(`
      SELECT sum(amount) AS total FROM v_categorized_amounts WHERE transaction_id = '${tx.id}'
    `);
    assert.equal(total, "240.00");
  });

  const amountEdit = await editTransaction(db, { id: tx.id, patch: { amount: "300.00" } });
  check("editing the amount of a split transaction is refused, not left to fail at commit", () =>
    assert.equal(amountEdit.ok, false));
  check("and says why the machine cannot decide it", () =>
    assert.match(amountEdit.error, /split across categories/));

  const cleared = await saveSplits(db, { transactionId: tx.id, splits: [] });
  assert.equal(cleared.ok, true);
  await acheck("clearing the split returns the transaction to the row", async () =>
    assert.equal(
      (await rows(`SELECT id FROM transaction_splits WHERE transaction_id = '${tx.id}'`)).length,
      0,
    ));
}

/* ------------------------------------------------------------------- [2] */

console.log("\n[2] EDITING A FIELD BY HAND LOCKS IT (§9.4.2)");
{
  const { tx } = await parsed({ body: "شراء 55.00 STARBUCKS", amount: "55.00", merchant: "STARBUCS" });

  const noop = await editTransaction(db, { id: tx.id, patch: { merchantRaw: "STARBUCS" } });
  assert.equal(noop.ok, true);
  check("submitting a field unchanged locks nothing", () =>
    assert.deepEqual(noop.value.locked, []));
  check("and reports no change", () => assert.deepEqual(noop.value.changed, {}));

  const edit = await editTransaction(db, {
    id: tx.id,
    patch: { merchantRaw: "STARBUCKS", categoryId: COFFEE },
  });
  assert.equal(edit.ok, true, edit.ok ? "" : edit.error);

  check("both edited fields are locked, under their column names", () =>
    assert.deepEqual(edit.value.locked.sort(), ["category_id", "merchant_raw"]));
  check("the change is reported with both sides", () =>
    assert.deepEqual(edit.value.changed.merchant_raw, { from: "STARBUCS", to: "STARBUCKS" }));

  await acheck("and the lock is in the column replay reads", async () => {
    const [row] = await rows(`
      SELECT locked_fields ? 'category_id' AS locked
        FROM transactions WHERE id = '${tx.id}'
    `);
    assert.equal(row.locked, true);
  });

  const unlocked = await unlockField(db, { id: tx.id, column: "merchant_raw" });
  assert.equal(unlocked.ok, true);
  check("unlocking removes only that field", () =>
    assert.deepEqual(unlocked.value.locked, ["category_id"]));
  await acheck("and leaves the value alone — unlock is not undo", async () =>
    assert.equal((await txById(tx.id)).merchant_raw, "STARBUCKS"));
}

/* ------------------------------------------------------------------- [3] */

console.log("\n[3] A HAND-EDITED CATEGORY SURVIVES A FULL REPLAY (§9.4, §13)");
{
  const { message, tx } = await parsed({
    body: "شراء بمبلغ 42.00 لدى STARBUCKS RIYADH",
    amount: "42.00",
    merchant: "STARBUCKS RIYADH",
    categoryId: RESTAURANTS,
  });

  // The correction: the parser filed a coffee shop under Restaurants.
  const fix = await editTransaction(db, { id: tx.id, patch: { categoryId: COFFEE } });
  assert.equal(fix.ok, true, fix.ok ? "" : fix.error);

  // An improved parser now reads this template better: it gets the amount right
  // (it was reading the subtotal, §7.6), normalises the merchant — and, on the
  // LLM path, guesses a category, which is the field it must not touch.
  const leg = {
    rawMessageId: message.id,
    accountId: account.id,
    direction: "debit",
    fields: {
      amount: "44.10",
      merchantRaw: "STARBUCKS",
      categoryId: RESTAURANTS,
      parserKind: "purchase",
    },
  };

  const dry = await replay(db, { legs: [leg], dryRun: true });
  assert.equal(dry.ok, true);

  const plan = dry.value.changed[0];
  check("the dry run says what would change", () =>
    assert.deepEqual(plan.changes.map((c) => c.column).sort(), [
      "amount",
      "merchant_raw",
      "parser_kind",
    ]));
  check("and names the field it is not allowed to change", () =>
    assert.deepEqual(plan.blocked, [
      { column: "category_id", from: COFFEE, to: RESTAURANTS },
    ]));

  await acheck("a dry run writes nothing at all", async () => {
    const row = await txById(tx.id);
    assert.equal(row.amount, "42.00");
    assert.equal(row.merchant_raw, "STARBUCKS RIYADH");
  });

  const applied = await replay(db, { legs: [leg], dryRun: false });
  assert.equal(applied.ok, true);

  const after = await txById(tx.id);
  check("the parser's improvements land", () => {
    assert.equal(after.amount, "44.10");
    assert.equal(after.merchant_raw, "STARBUCKS");
  });
  check("THE HAND-EDITED CATEGORY DOES NOT MOVE", () =>
    assert.equal(after.category_id, COFFEE));
  check("and the lock is still there for the next replay", () =>
    assert.deepEqual(after.locked_fields, ["category_id"]));

  // The second half of a replay is the rules pass (§9.5). A rule that would
  // have categorized this transaction must be refused by the same lock.
  const rule = await createRule(db, {
    name: "STARBUCKS → Restaurants",
    match: [{ field: "merchant_raw", operator: "equals", value: "STARBUCKS" }],
    actions: { set_category: RESTAURANTS },
  });
  assert.equal(rule.ok, true);

  const ran = await applyRule(db, { ruleId: rule.value.id });
  assert.equal(ran.ok, true);
  check("a rule does not override a locked field either (§9.5)", () =>
    assert.equal(ran.value.applied, 0));
  await acheck("so the category is still the one that was typed", async () =>
    assert.equal((await txById(tx.id)).category_id, COFFEE));

  await pg.exec(`DELETE FROM rules WHERE id = '${rule.value.id}'`);
}

/* ------------------------------------------------------------------- [4] */

console.log("\n[4] A MANUAL TRANSACTION SURVIVES REPLAY UNCHANGED (§9.4.1)");
{
  const created = await createManual(db, {
    accountId: account.id,
    postedAt: "2026-08-11T19:30:00+03:00",
    amount: "60.00",
    direction: "debit",
    type: "purchase",
    categoryId: cashCategory,
    description: "Coffee, cash",
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);

  const before = await txById(created.value.id);
  check("it is stored as manual", () => assert.equal(before.origin, "manual"));
  check("with no message behind it", () => assert.equal(before.raw_message_id, null));
  check("and marked reviewed — a person just typed it", () =>
    assert.equal(before.is_reviewed, true));

  await acheck("the balance follows it immediately, not at the next tick", async () => {
    const a = await one(`SELECT current_balance FROM accounts WHERE id = '${account.id}'`);
    // 10,000 opening − 240 − 55 − 44.10 − 60. The others are this file's earlier
    // fixtures; what matters is that the 60 is in it.
    assert.equal(a.current_balance, "9600.90");
  });

  // A parsed transaction that was later converted to manual, which is the other
  // way a row acquires that origin — and the one where replay has a message in
  // hand and must still decline.
  const { message, tx } = await parsed({
    body: "شراء 75.00 لدى SOUQ",
    amount: "75.00",
    merchant: "SOUQ",
  });
  const converted = await convertToManual(db, { id: tx.id });
  assert.equal(converted.ok, true);

  const snapshot = await txById(tx.id);

  const report = await replay(db, {
    legs: [
      {
        rawMessageId: message.id,
        accountId: account.id,
        direction: "debit",
        fields: { amount: "999.00", merchantRaw: "SOMETHING ELSE", type: "transfer" },
      },
    ],
    dryRun: false,
  });
  assert.equal(report.ok, true);

  check("replay refuses it, and says why", () =>
    assert.deepEqual(report.value.skipped, [
      { rawMessageId: message.id, reason: "manual", transactionId: tx.id },
    ]));
  check("it is not in the change list at all", () =>
    assert.equal(report.value.changed.length, 0));

  await acheck("and not one column moved", async () => {
    const after = await txById(tx.id);
    for (const key of Object.keys(snapshot)) {
      assert.equal(String(after[key]), String(snapshot[key]), `column ${key} moved`);
    }
  });
}

/* ------------------------------------------------------------------- [5] */

console.log("\n[5] A DELETED TRANSACTION IS NOT RESURRECTED (§9.4.3, §13)");
{
  const { message, tx } = await parsed({
    body: "سحب نقدي 500.00",
    amount: "500.00",
    type: "withdrawal",
  });

  const deleted = await deleteTransaction(db, { id: tx.id });
  assert.equal(deleted.ok, true, deleted.ok ? "" : deleted.error);
  check("it reports the message it came from", () =>
    assert.equal(deleted.value.rawMessageId, message.id));
  check("and that no other leg came from the same message", () =>
    assert.equal(deleted.value.siblingLegs, 0));

  await acheck("the transaction is gone", async () =>
    assert.equal(await txById(tx.id), undefined));

  await acheck("the message is kept — §3.1 makes raw_messages append-only", async () => {
    const m = await one(`SELECT * FROM raw_messages WHERE id = '${message.id}'`);
    assert.equal(m.status, "ignored");
    assert.equal(m.ignored_reason, "user");
    assert.match(m.body, /سحب نقدي/);
  });

  // The next replay over full history hands back the leg it always did.
  const report = await replay(db, {
    legs: [
      {
        rawMessageId: message.id,
        accountId: account.id,
        direction: "debit",
        fields: { amount: "500.00", type: "withdrawal" },
      },
    ],
    dryRun: false,
  });
  assert.equal(report.ok, true);

  check("replay refuses to bring it back", () =>
    assert.deepEqual(report.value.skipped, [{ rawMessageId: message.id, reason: "deleted" }]));

  await acheck("and there is still no transaction for that message", async () =>
    assert.equal(
      (await rows(`SELECT id FROM transactions WHERE raw_message_id = '${message.id}'`)).length,
      0,
    ));

  await acheck("a scoped replay does not even send it to the parser", async () => {
    const candidates = await replayableMessages(db, {});
    assert.equal(candidates.some((m) => m.id === message.id), false);
  });
}

/* ------------------------------------------------------------------- [6] */

console.log("\n[6] A RULE'S DRY RUN IS EXACTLY ITS APPLY (§11.1)");
{
  const fixtures = [
    // Two that will change.
    { merchant: "JARIR BOOKSTORE", categoryId: null },
    { merchant: "jarir bookstore", categoryId: null },
    // One already in the target category: matched, unaffected.
    { merchant: "JARIR BOOKSTORE", categoryId: GROCERIES },
    // One a person has already categorized by hand: matched, and protected.
    { merchant: "JARIR BOOKSTORE", categoryId: COFFEE, lock: true },
    // One that must not match at all.
    { merchant: "JARIR EXPRESS", categoryId: null },
  ];

  const made = [];
  for (const f of fixtures) {
    const { tx } = await parsed({
      body: `شراء لدى ${f.merchant}`,
      amount: "89.00",
      merchant: f.merchant,
      categoryId: f.categoryId,
    });
    if (f.lock) {
      await pg.exec(
        `UPDATE transactions SET locked_fields = '["category_id"]'::jsonb WHERE id = '${tx.id}'`,
      );
    }
    made.push(tx);
  }

  const draft = ruleFromTransaction(
    { merchantRaw: "JARIR BOOKSTORE", biller: null },
    GROCERIES,
    "Groceries",
  );
  check("the picker's rule keys on the merchant it was opened from", () =>
    assert.deepEqual(draft.match, [
      { field: "merchant_raw", operator: "equals", value: "JARIR BOOKSTORE" },
    ]));

  const preview = await previewRule(db, { match: draft.match, actions: draft.actions });
  assert.equal(preview.ok, true, preview.ok ? "" : preview.error);

  check("the match is case-insensitive — one bank writes it three ways", () =>
    assert.equal(preview.value.matched, 4));
  check("a locked transaction is counted apart", () => assert.equal(preview.value.locked, 1));
  check("so is one already in the target category", () =>
    assert.equal(preview.value.unchanged, 1));
  check("leaving the number the confirm button offers", () =>
    assert.equal(preview.value.wouldChange, 2));
  check("and the list to read before agreeing to it", () =>
    assert.equal(preview.value.rows.length, 4));

  const rule = await createRule(db, draft);
  assert.equal(rule.ok, true);

  await acheck("creating the rule applies nothing on its own (§11.1)", async () => {
    const untouched = await txById(made[0].id);
    assert.equal(untouched.category_id, null);
  });

  const applied = await applyRule(db, { ruleId: rule.value.id });
  assert.equal(applied.ok, true);

  check("THE DRY-RUN COUNT IS THE APPLY COUNT", () =>
    assert.equal(applied.value.applied, preview.value.wouldChange));

  await acheck("the two that needed it were categorized", async () => {
    assert.equal((await txById(made[0].id)).category_id, GROCERIES);
    assert.equal((await txById(made[1].id)).category_id, GROCERIES);
  });
  await acheck("the hand-categorized one was not (§9.5)", async () =>
    assert.equal((await txById(made[3].id)).category_id, COFFEE));
  await acheck("and the merchant that only looked similar was left alone", async () =>
    assert.equal((await txById(made[4].id)).category_id, null));

  await acheck("every row it touched says which rule did it", async () => {
    const row = await txById(made[0].id);
    assert.equal(row.matched_rule_id, rule.value.id);
  });
  await acheck("but the rule did not lock anything — a rule is not a person", async () =>
    assert.equal((await txById(made[0].id)).locked_fields, null));

  const again = await applyRule(db, { ruleId: rule.value.id });
  check("running it a second time changes nothing", () => assert.equal(again.value.applied, 0));

  const after = await previewRule(db, { match: draft.match, actions: draft.actions });
  check("and the dry run now agrees there is nothing left to do", () =>
    assert.equal(after.value.wouldChange, 0));
}

/* ------------------------------------------------------------------- [7] */

console.log("\n[7] cycle_override MOVES THE CYCLE AND NOT THE WEEK (§5.6)");
{
  // 26 July 2026 is a Sunday, four days into the cycle that opened on the 25th.
  const { tx } = await parsed({
    body: "قيد راتب دائن 13,120.45",
    amount: "13120.45",
    direction: "credit",
    type: "income",
    postedAt: "2026-07-26T14:04:00+03:00",
  });

  const buckets = async () =>
    one(`SELECT cycle_start::text, week_start::text
           FROM v_categorized_amounts WHERE transaction_id = '${tx.id}'`);

  const before = await buckets();
  check("it starts in the cycle its posting date falls in", () =>
    assert.equal(before.cycle_start, "2026-07-25"));
  check("and the week beginning the Sunday it landed on", () =>
    assert.equal(before.week_start, "2026-07-26"));

  const posted = "2026-07-26";
  const here = periodStart(posted);
  const neighbours = [addMonths(here, -1), addMonths(here, 1)];

  const tooFar = await setCycleOverride(db, {
    id: tx.id,
    cycleStart: addMonths(here, -3),
    neighbours,
  });
  check("a jump of three cycles is refused", () => assert.equal(tooFar.ok, false));
  check("because past a neighbour it is not payday drift any more", () =>
    assert.match(tooFar.error, /either side/));

  const moved = await setCycleOverride(db, { id: tx.id, cycleStart: neighbours[0], neighbours });
  assert.equal(moved.ok, true, moved.ok ? "" : moved.error);

  const after = await buckets();
  check("THE CYCLE MOVES", () => assert.equal(after.cycle_start, "2026-06-25"));
  check("THE WEEK DOES NOT — a week is a literal date range", () =>
    assert.equal(after.week_start, before.week_start));
  check("and the week is still the one containing the posting date", () =>
    assert.equal(after.week_start, weekStart(posted)));

  await acheck("the override is locked, so a replay cannot undo the reassignment", async () =>
    assert.deepEqual((await txById(tx.id)).locked_fields, ["cycle_override"]));

  const cleared = await setCycleOverride(db, { id: tx.id, cycleStart: null, neighbours });
  assert.equal(cleared.ok, true);
  await acheck("clearing it puts the transaction back where it posted", async () =>
    assert.equal((await buckets()).cycle_start, "2026-07-25"));
}

/* ------------------------------------------------------------------- [8] */

console.log("\n[8] EDITING AN AMOUNT INVALIDATES THE RECONCILIATION IT INVALIDATES (§3.3)");
{
  const { tx } = await parsed({
    body: "شراء 300.00 لدى TAMIMI",
    amount: "300.00",
    merchant: "TAMIMI",
    accountId: saib.id,
  });

  // The bank said 700.00; the ledger computes 0 − 300 = −300. Drift of 1,000,
  // which is what a missed message looks like.
  await pg.exec(`
    INSERT INTO reconciliation_alerts (account_id, computed_balance, reported_balance, delta)
    VALUES ('${saib.id}', '-300.00', '700.00', '-1000.00');
  `);

  const edit = await editTransaction(db, { id: tx.id, patch: { amount: "3000.00" } });
  assert.equal(edit.ok, true, edit.ok ? "" : edit.error);

  await acheck("the account's computed balance follows the edit immediately", async () => {
    const a = await one(`SELECT current_balance FROM accounts WHERE id = '${saib.id}'`);
    assert.equal(a.current_balance, "-3000.00");
  });

  await acheck("and the open alert is re-derived rather than left stating a stale figure", async () => {
    const al = await one(`SELECT * FROM reconciliation_alerts WHERE account_id = '${saib.id}'`);
    assert.equal(al.computed_balance, "-3000.00");
    assert.equal(al.delta, "-3700.00");
    assert.equal(al.resolved_at, null);
  });

  // Now correct it to the figure that makes the ledger agree with the bank.
  const fix = await editTransaction(db, { id: tx.id, patch: { amount: "700.00" } });
  assert.equal(fix.ok, true);
  await pg.exec(`UPDATE transactions SET direction = 'credit' WHERE id = '${tx.id}'`);

  await acheck("an edit that closes the drift closes the alert, and says so", async () => {
    const al = await one(`SELECT * FROM reconciliation_alerts WHERE account_id = '${saib.id}'`);
    assert.equal(al.computed_balance, "700.00");
    assert.notEqual(al.resolved_at, null);
    assert.match(al.resolution_note, /edited by hand/);
  });

  // Deleting a transaction moves the balance too, and the trigger covers it.
  await deleteTransaction(db, { id: tx.id });
  await acheck("deleting one moves the balance back", async () => {
    const a = await one(`SELECT current_balance FROM accounts WHERE id = '${saib.id}'`);
    assert.equal(a.current_balance, "0.00");
  });
}

/* ------------------------------------------------------------------- [9] */

console.log("\n[9] BULK ACTIONS LOCK WHAT THEY SET");
{
  const a = (await parsed({ body: "تحويل 1", amount: "10.00", type: "transfer" })).tx;
  const b = (await parsed({ body: "تحويل 2", amount: "20.00", type: "transfer" })).tx;

  const done = await bulkEdit(db, {
    ids: [a.id, b.id],
    patch: { isInternalTransfer: true, excludedFromAnalytics: true },
  });
  assert.equal(done.ok, true, done.ok ? "" : done.error);
  check("both rows were updated", () => assert.equal(done.value.updated, 2));

  await acheck("and both carry the locks for what was set", async () => {
    for (const id of [a.id, b.id]) {
      const row = await txById(id);
      assert.equal(row.is_internal_transfer, true);
      assert.deepEqual(
        [...row.locked_fields].sort(),
        ["excluded_from_analytics", "is_internal_transfer"],
      );
    }
  });

  const report = await replay(db, {
    legs: [
      {
        rawMessageId: (await txById(a.id)).raw_message_id,
        accountId: account.id,
        direction: "debit",
        fields: { isInternalTransfer: false, amount: "10.00" },
      },
    ],
    dryRun: false,
  });
  assert.equal(report.ok, true);
  await acheck("a replay cannot undo a bulk correction either", async () =>
    assert.equal((await txById(a.id)).is_internal_transfer, true));

  await acheck("an internal transfer is listed but counted nowhere (§6)", async () => {
    const [{ counted }] = await rows(`
      SELECT count(*)::int AS counted FROM v_categorized_amounts
       WHERE transaction_id = '${a.id}'
         AND NOT is_internal_transfer AND NOT excluded_from_analytics
    `);
    const [{ listed }] = await rows(`
      SELECT count(*)::int AS listed FROM v_categorized_amounts WHERE transaction_id = '${a.id}'
    `);
    assert.equal(listed, 1);
    assert.equal(counted, 0);
  });
}

await pg.close();

console.log(`\n${"=".repeat(60)}\nALL ${n} LEDGER-MUTATION CHECKS PASS\n${"=".repeat(60)}`);
