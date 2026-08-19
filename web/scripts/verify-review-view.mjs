/**
 * The Review screen — SPEC §10.7, §11.6, §6.
 *
 * Two things are checked here, and they fail in opposite ways.
 *
 * **The queue grouping** is the value of the workbench: failures arrive in
 * format-shaped clusters, so a queue that lists forty identical messages
 * individually is a queue nobody works through. Grouping wrong — merging two
 * senders, or splitting one format apart — makes the bulk actions dangerous
 * rather than useful. That half is pure and needs no database.
 *
 * **The health panel** is the honest counterpart to a dashboard that claims to
 * know your finances, and its most consequential figure is §6's master
 * invariant: `Δ net worth == income − expense`. §6 says it "catches
 * classification errors that no individual balance reconciliation would", so
 * the test for it has to be a real misclassification in a real database, not
 * three numbers handed to a comparison. Section [11] builds §6's worked example
 * against the actual migrations, asserts the invariant holds, then files the
 * card payment as a purchase — a leg the bank reports identically, that
 * reconciles perfectly on both accounts, and that overstates spending by 800 —
 * and asserts the panel reports FAIL with exactly that delta.
 *
 * Everything the checks filter with is imported from `src/db/predicates.ts` and
 * everything they judge with is imported from `src/lib/`. A test that retypes
 * the rule it is checking agrees with the bug.
 *
 * Run: npm run test:review
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
  groupByShape,
  parseRate,
  ingestionStale,
  parsingStalled,
  templateHitRate,
  llmStatus,
  QUEUE_STALL_MS,
  LLM_DAILY_CAP,
  NO_METHODS,
} = await load("lib/review.ts");
const { masterInvariant, explain, TOLERANCE } = await load("lib/invariant.ts");
const { backupState, EXPORT_INTERVAL_DAYS } = await load("lib/backup.ts");
const { raiseExportReminder, stampExport, EXPORT_REMINDER } = await load("db/backup.ts");
const { rankAlerts, reviewQueueAlert, toAlertView } = await load("lib/alerts.ts");
const { IS_EARNED_SQL, IS_EXPENSE_SQL, IS_PASSIVE_SQL, SIGNED_AMOUNT_SQL } =
  await load("db/predicates.ts");

let n = 0;
const check = (name, fn) => {
  // Refuses an async assertion rather than printing PASS for a promise nobody
  // awaited. Resolve the query first and assert on the value.
  const result = fn();
  if (result && typeof result.then === "function") {
    throw new Error(`check("${name}") was given an async function — await the value first`);
  }
  n++;
  console.log(`  PASS  ${name}`);
};

const msg = (over) => ({
  id: over.id ?? "1",
  sender: "STC Bank",
  body: "body",
  receivedAt: new Date("2026-08-10T10:00:00Z"),
  status: "needs_review",
  shapeHash: "aaaa",
  lastError: "no template matched",
  ignoredReason: null,
  attempts: 0,
  ...over,
});

/** A Health with nothing in it — the shape the page gets on a database that
 *  has never received a message. Spread rather than retyped so a new field on
 *  `Health` cannot quietly default to undefined in half these checks. */
const health0 = {
  lastReceived: null,
  oldestQueued: null,
  pending: 0,
  processing: 0,
  parsed: 0,
  ignored: 0,
  needsReview: 0,
  failed: 0,
  byMethod: { ...NO_METHODS },
  llmThisMonth: 0,
};

console.log("\n[1] CLUSTERING");
{
  const groups = groupByShape([
    msg({ id: "1" }),
    msg({ id: "2" }),
    msg({ id: "3", shapeHash: "bbbb" }),
  ]);
  check("same shape and sender collapse into one group", () =>
    assert.equal(groups.length, 2));
  check("the big cluster leads", () => assert.equal(groups[0].count, 2));
  check("every id is carried for bulk action", () =>
    assert.deepEqual([...groups[0].ids].sort(), ["1", "2"]));
}

console.log("\n[2] SENDERS ARE NEVER MERGED");
{
  // Two banks can send structurally identical messages. Merging them would
  // offer one "retry" across senders whose templates are unrelated.
  const groups = groupByShape([
    msg({ id: "1", sender: "SAIB" }),
    msg({ id: "2", sender: "STC Bank" }),
  ]);
  check("identical shape, different sender, stays separate", () =>
    assert.equal(groups.length, 2));
}

console.log("\n[3] FAILED AND NEEDS_REVIEW ARE DISTINCT");
{
  const groups = groupByShape([
    msg({ id: "1", status: "needs_review" }),
    msg({ id: "2", status: "failed", lastError: "ValueError: boom" }),
  ]);
  check("a crash is not grouped with an unmatched template", () =>
    assert.equal(groups.length, 2));
  check("a crash reports its error", () =>
    assert.equal(groups.find((g) => g.status === "failed").reason, "ValueError: boom"));
}

console.log("\n[4] MESSAGES WITHOUT A SHAPE STAY VISIBLE");
{
  // A null shape must not collapse unrelated messages into one bucket, which
  // would hide them behind a single misleading sample.
  const groups = groupByShape([
    msg({ id: "1", shapeHash: null }),
    msg({ id: "2", shapeHash: null }),
  ]);
  check("unhashed messages are listed individually", () =>
    assert.equal(groups.length, 2));
}

console.log("\n[5] SAMPLE AND TIME RANGE");
{
  const groups = groupByShape([
    msg({ id: "old", receivedAt: new Date("2026-08-01T10:00:00Z") }),
    msg({ id: "new", receivedAt: new Date("2026-08-09T10:00:00Z") }),
  ]);
  check("the newest message is the example shown", () =>
    assert.equal(groups[0].sample.id, "new"));
  check("range spans oldest to newest", () =>
    assert.equal(groups[0].oldest.toISOString(), "2026-08-01T10:00:00.000Z"));
}

console.log("\n[6] PARSE RATE EXCLUDES IGNORED MESSAGES");
{
  // An OTP correctly discarded is a success, not a parse. Counting ignored
  // messages would let a flood of promo junk inflate the rate while real
  // failures pile up unnoticed.
  const rate = parseRate({ parsed: 8, needsReview: 2, failed: 0, ignored: 990,
                           pending: 0, lastReceived: null });
  check("990 ignored messages do not inflate the rate", () =>
    assert.equal(rate, 0.8));
  check("nothing attempted returns null, not a misleading 100%", () =>
    assert.equal(parseRate({ parsed: 0, needsReview: 0, failed: 0, ignored: 5,
                             pending: 0, lastReceived: null }), null));
}

console.log("\n[7] STALE INGESTION DETECTION");
{
  const now = new Date("2026-08-12T12:00:00Z");
  check("silence over 24h is stale", () =>
    assert.equal(ingestionStale(new Date("2026-08-11T09:00:00Z"), now), true));
  check("recent traffic is fine", () =>
    assert.equal(ingestionStale(new Date("2026-08-12T09:00:00Z"), now), false));
  check("never having received anything is not 'stale'", () =>
    assert.equal(ingestionStale(null, now), false));
}

console.log("\n[8] STALLED PARSING DETECTION");
{
  // The counterpart to [7], and the gap a real message fell through: a message
  // that arrived and was never drained is `pending` or `processing`, and
  // neither status appears in any list on this page. Ingestion reads healthy —
  // a message DID arrive — the parse rate reads healthy, because it judges only
  // messages that reached a verdict, and the message itself is nowhere.
  const now = new Date("2026-08-12T12:00:00Z");
  check("queued over 15 minutes means the tick is not draining", () =>
    assert.equal(parsingStalled(new Date("2026-08-12T11:30:00Z"), now), true));
  check("queued a moment ago is just the next tick's work", () =>
    assert.equal(parsingStalled(new Date("2026-08-12T11:59:30Z"), now), false));
  check("an empty queue is not a stall", () =>
    assert.equal(parsingStalled(null, now), false));
  check("the threshold sits well clear of the one-minute tick", () =>
    assert.ok(QUEUE_STALL_MS >= 5 * 60 * 1000));
}

console.log("\n[9] TEMPLATE HIT RATE IS MEASURED OVER PARSED MESSAGES ONLY");
{
  // §11.6: the hit rate "should climb toward ~100%". What it measures is
  // whether hand-processing compounds into templates the way §10.7 promises —
  // one message parsed by hand should become forty parsed by regex.
  //
  // The denominator is the trap. Folding the parked queue into it would make
  // the rate FALL when the parser meets a new bank and RISE when you give up
  // and dismiss the queue, which is precisely backwards: those messages have no
  // parse method because they were never parsed.
  const h = (over) => ({
    ...health0,
    parsed: 100,
    needsReview: 40,
    failed: 10,
    ignored: 500,
    byMethod: { ...NO_METHODS, ...over },
  });

  check("90 of 100 parsed by template reads 90%, not 90/150", () =>
    assert.equal(templateHitRate(h({ template: 90, manual: 10 })), 0.9));

  check("40 parked messages do not move the rate", () => {
    const few = templateHitRate({ ...h({ template: 90, manual: 10 }), needsReview: 0, failed: 0 });
    assert.equal(few, templateHitRate(h({ template: 90, manual: 10 })));
  });

  // A hand-parse is a cost, not a hit. Counting it as one would mean the rate
  // reads 100% on a system where every single message is processed manually.
  check("a manual parse counts against the rate, never for it", () =>
    assert.equal(templateHitRate(h({ template: 0, manual: 100 })), 0));

  // An unattributed row is a parse whose method nobody recorded. Folding it
  // into `template` is how a hit rate becomes a number that only goes up.
  check("unattributed parses are not silently counted as template hits", () =>
    assert.equal(templateHitRate(h({ template: 50, unattributed: 50 })), 0.5));

  check("nothing parsed returns null, not a misleading 100%", () =>
    assert.equal(templateHitRate({ ...health0, parsed: 0 }), null));
}

console.log("\n[10] THE LLM ROW IS SHOWN AS NOT-ENABLED, NEVER OMITTED");
{
  // §11.6 asks for "LLM calls this month against the free-tier cap"; §2 defers
  // the Gemini fallback past v1. The honest rendering is a row that says so —
  // an omitted row reads as a feature nobody thought about, and the count has
  // to already be measured so an unexpected call cannot happen unseen.
  const off = llmStatus(0, 31);
  check("with the fallback deferred the row reads not-enabled", () =>
    assert.equal(off.enabled, false));
  check("and states why rather than showing a bare zero", () =>
    assert.match(off.note, /template/i));
  check("no share is claimed against a cap nothing is using", () =>
    assert.equal(off.share, null));

  const on = llmStatus(310, 31);
  check("once calls appear the row becomes a real measurement", () =>
    assert.equal(on.enabled, true));
  check("the monthly budget is the daily cap times the month's real length", () =>
    assert.equal(on.cap, LLM_DAILY_CAP * 31));
  check("a 28-day February gets a smaller budget, not a hardcoded 30", () =>
    assert.equal(llmStatus(1, 28).cap, LLM_DAILY_CAP * 28));
  check("share is against that budget", () =>
    assert.equal(Math.round(on.share * 1000) / 1000, 0.01));
}

/* ========================================================================= */
/* §6's master invariant, against the real migrations.                       */
/* ========================================================================= */

/**
 * §6's worked example as ledger rows — the same fixture
 * `verify-home-aggregates.mjs` builds, and modelled the same way, because the
 * two scripts have to agree about what the example IS before they can disagree
 * about anything else.
 *
 * The loan payment is two legs (1,700 `loan_payment` + 300 `fee`) rather than
 * one leg with an interest attribute, and the loan's counter-leg is a DEBIT
 * because `recompute_balances` uses one uniform sign rule and a loan's stored
 * balance is the debt owed.
 */
const CYCLE = "2026-07-25";
const OPENING = { checking: 10000, savings: 5000, card: 10000, loan: 50000 };
const CARD_LIMIT = 10000;

const IDS = {
  checking: "a0000000-0000-4000-a000-000000000001",
  savings: "a0000000-0000-4000-a000-000000000002",
  card: "a0000000-0000-4000-a000-000000000003",
  loan: "a0000000-0000-4000-a000-000000000004",
};

const CATEGORIES = {
  groceries: "c0000000-0000-4000-a000-000000000201",
  fees: "c0000000-0000-4000-a000-000000000b01",
};

/** `recompute_balances` from api/db.py, verbatim — the statement the parser
 *  runs on its next tick. Net worth is therefore derived from the very legs the
 *  aggregates read, which is what makes the check below a test rather than a
 *  restatement of itself. */
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

const day = (offset, time = "10:00") => {
  const d = new Date(`${CYCLE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.toISOString().slice(0, 10)}T${time}:00+03`;
};

async function boot({ rows = true } = {}) {
  const db = new PGlite();

  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) {
      try {
        await db.exec(stmt);
      } catch (err) {
        console.error(`migration ${file} failed:\n${stmt.slice(0, 300)}\n${err.message}`);
        process.exit(1);
      }
    }
  }

  if (!rows) return db;

  await db.exec(`
    INSERT INTO accounts (id, slug, name, institution, type, is_liability,
                          balance_semantics, opening_balance, current_balance,
                          credit_limit, is_profit_bearing, sort_order)
    VALUES
      ('${IDS.checking}', 'checking', 'Current', 'SAIB', 'checking', false,
       'balance', ${OPENING.checking}, ${OPENING.checking}, NULL, false, 1),
      ('${IDS.savings}', 'savings', 'Savings', 'SAIB', 'savings', false,
       'balance', ${OPENING.savings}, ${OPENING.savings}, NULL, true, 2),
      -- §3.3a: the stored figure is AVAILABLE CREDIT. Debt is limit − balance.
      ('${IDS.card}', 'card', 'Visa', 'AlRajhiBank', 'credit_card', true,
       'available_credit', ${OPENING.card}, ${OPENING.card}, ${CARD_LIMIT}, false, 3),
      ('${IDS.loan}', 'loan', 'Car loan', 'AlRajhiBank', 'loan', true,
       'balance', ${OPENING.loan}, ${OPENING.loan}, NULL, false, 4);

    INSERT INTO transactions
      (id, account_id, posted_at, amount, direction, type, income_class, category_id,
       is_internal_transfer)
    VALUES
      -- salary 12,000 — earned income, on the day the cycle opens
      (gen_random_uuid(), '${IDS.checking}', '${day(0)}', 12000.00, 'credit', 'income', 'earned', NULL, false),
      -- 800 of groceries on the card — a purchase IS spending
      (gen_random_uuid(), '${IDS.card}', '${day(2)}', 800.00, 'debit', 'purchase', NULL, '${CATEGORIES.groceries}', false),
      -- the card paid in full — an internal transfer, NOT a second 800 of spend.
      -- This pair is what section [11] deliberately misfiles.
      ('b0000000-0000-4000-a000-000000000001', '${IDS.checking}', '${day(6)}', 800.00, 'debit', 'card_payment', NULL, NULL, true),
      (gen_random_uuid(), '${IDS.card}', '${day(6)}', 800.00, 'credit', 'card_payment', NULL, NULL, true),
      -- loan payment 2,000 = 1,700 principal + 300 interest
      (gen_random_uuid(), '${IDS.checking}', '${day(8)}', 1700.00, 'debit', 'loan_payment', NULL, NULL, false),
      (gen_random_uuid(), '${IDS.loan}', '${day(8)}', 1700.00, 'debit', 'loan_payment', NULL, NULL, false),
      (gen_random_uuid(), '${IDS.checking}', '${day(8)}', 300.00, 'debit', 'fee', NULL, '${CATEGORIES.fees}', false),
      -- 1,000 and 3,000 moved to savings — internal both ways
      (gen_random_uuid(), '${IDS.checking}', '${day(10)}', 1000.00, 'debit', 'transfer', NULL, NULL, true),
      (gen_random_uuid(), '${IDS.savings}', '${day(10)}', 1000.00, 'credit', 'transfer', NULL, NULL, true),
      (gen_random_uuid(), '${IDS.checking}', '${day(12)}', 3000.00, 'debit', 'transfer', NULL, NULL, true),
      (gen_random_uuid(), '${IDS.savings}', '${day(12)}', 3000.00, 'credit', 'transfer', NULL, NULL, true),
      -- 45 of profit — passive income. Excluding it breaks the invariant.
      (gen_random_uuid(), '${IDS.savings}', '${day(14)}', 45.00, 'credit', 'profit', 'passive', NULL, false);
  `);

  await db.exec(RECOMPUTE);
  return db;
}

const rowsOf = async (db, sql) => (await db.query(sql)).rows;

/** The §6 aggregates, filtered with the app's own predicate text. */
async function measure(db) {
  const [r] = await rowsOf(
    db,
    `SELECT COALESCE(sum(amount) FILTER (WHERE ${IS_EXPENSE_SQL}), 0) AS expense,
            COALESCE(sum(amount) FILTER (WHERE ${IS_EARNED_SQL}), 0)  AS earned,
            COALESCE(sum(amount) FILTER (WHERE ${IS_PASSIVE_SQL}), 0) AS passive
       FROM v_categorized_amounts
      WHERE cycle_start = '${CYCLE}'::date`,
  );
  return {
    expense: Number(r.expense),
    income: Number(r.earned) + Number(r.passive),
  };
}

/**
 * The per-account cycle movement `db/review.ts` reads, built from the same
 * `SIGNED_AMOUNT_SQL` the app's query uses. Retyping the sign rule here would
 * be retyping the thing under test.
 */
async function movementsOf(db) {
  const rows = await rowsOf(
    db,
    `SELECT account_id,
            COALESCE(sum(${SIGNED_AMOUNT_SQL}) FILTER (WHERE state = 'posted'), 0) AS posted,
            COALESCE(sum(${SIGNED_AMOUNT_SQL}) FILTER (
              WHERE state = 'posted' AND excluded_from_analytics), 0)              AS excluded,
            COALESCE(sum(${SIGNED_AMOUNT_SQL}) FILTER (
              WHERE state IN ('pending', 'reversed')
                AND NOT excluded_from_analytics), 0)                               AS unposted
       FROM v_categorized_amounts
      WHERE cycle_start = '${CYCLE}'::date
      GROUP BY account_id`,
  );

  return rows.map((r) => ({
    accountId: r.account_id,
    posted: Number(r.posted),
    excluded: Number(r.excluded),
    unposted: Number(r.unposted),
  }));
}

async function accountsOf(db) {
  const rows = await rowsOf(
    db,
    `SELECT id, slug, name, institution, type::text AS type, is_liability,
            balance_semantics::text AS balance_semantics, reconcilable,
            current_balance, credit_limit, is_profit_bearing, sort_order
       FROM accounts ORDER BY sort_order`,
  );

  return rows.map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    institution: a.institution,
    type: a.type,
    isLiability: a.is_liability,
    balanceSemantics: a.balance_semantics,
    reconcilable: a.reconcilable,
    currentBalance: String(a.current_balance),
    creditLimit: a.credit_limit === null ? null : String(a.credit_limit),
    isProfitBearing: a.is_profit_bearing,
    balanceAsOf: null,
    sortOrder: Number(a.sort_order),
    statementDay: null,
    dueDay: null,
    profitPayoutDay: null,
  }));
}

/** Exactly what the page computes, from exactly what the page reads. */
async function checkInvariant(db) {
  await db.exec(RECOMPUTE);
  const { income, expense } = await measure(db);
  return masterInvariant({
    accounts: await accountsOf(db),
    movements: await movementsOf(db),
    income,
    expense,
  });
}

const round = (v) => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

console.log("\n[11] THE MASTER INVARIANT: Δ NET WORTH == INCOME − EXPENSE (§6)");
const live = await boot();
{
  const ok = await checkInvariant(live);

  check("§6's worked example holds", () => assert.equal(ok.ok, true));
  check("Δ net worth is +10,945, from the ledger's own posted legs", () =>
    assert.equal(round(ok.observed), 10945));
  check("income − spending agrees, to the halala", () =>
    assert.equal(round(ok.expected), 10945));
  check("nothing is unexplained", () => assert.equal(round(ok.unexplained), 0));
  check("and the panel says so in words", () =>
    assert.match(explain(ok), /classified consistently/));

  /* -------------------------------------------------------------------- */
  /* The misclassification §6 says nothing else can catch.                 */
  /*                                                                       */
  /* The card payment is refiled as a purchase — which is exactly what an   */
  /* unpaired card-payment leg looks like to the parser. Note what does NOT */
  /* change: the amount, the direction, the account, the balance on either  */
  /* side. Both accounts still reconcile perfectly against every balance    */
  /* their banks printed, so the drift check above this on the page reports */
  /* nothing at all. Only §6 notices.                                       */
  /* -------------------------------------------------------------------- */
  await live.exec(`
    UPDATE transactions
       SET type = 'purchase', is_internal_transfer = false
     WHERE id = 'b0000000-0000-4000-a000-000000000001'
  `);

  const broken = await checkInvariant(live);

  check("counting a card payment as spending FAILS the check", () =>
    assert.equal(broken.ok, false));
  check("net worth is untouched by the misfiling — still +10,945", () =>
    assert.equal(round(broken.observed), 10945));
  check("but income − spending now reads 800 lower", () =>
    assert.equal(round(broken.expected), 10145));
  check("and the delta reported on screen is exactly the 800", () =>
    assert.equal(round(broken.unexplained), 800));
  check("the explanation names overstated spending, not lost income", () =>
    assert.match(explain(broken), /spending is overstated/));

  // The balances are the proof that no per-account reconciliation could have
  // found this: the misfiled leg moved the same money the same way.
  const balances = Object.fromEntries(
    (await rowsOf(live, `SELECT slug, current_balance FROM accounts`)).map((r) => [
      r.slug,
      round(Number(r.current_balance)),
    ]),
  );
  check("every balance is identical to the correctly-classified ledger's", () =>
    assert.deepEqual(balances, {
      checking: 10000 + 12000 - 800 - 1700 - 300 - 1000 - 3000,
      savings: 5000 + 1000 + 3000 + 45,
      card: 10000 - 800 + 800,
      loan: 50000 - 1700,
    }));

  await live.exec(`
    UPDATE transactions
       SET type = 'card_payment', is_internal_transfer = true
     WHERE id = 'b0000000-0000-4000-a000-000000000001'
  `);

  const fixed = await checkInvariant(live);
  check("correcting the classification makes it pass again", () =>
    assert.equal(fixed.ok, true));
  check("with nothing left unexplained", () =>
    assert.equal(round(fixed.unexplained), 0));
}

console.log("\n[12] THE TWO LEGITIMATE REASONS THE SIDES DIFFER ARE NAMED, NOT HIDDEN");
{
  // An alarm that fires on ordinary use is an alarm that gets ignored, and
  // then the 800 above goes unnoticed too. Both of these move one side of the
  // identity and not the other, for reasons the SPEC states.

  // §3.3b — a balance corrected by hand books an `adjustment`, always
  // excluded_from_analytics: money that was already there, so it moves net
  // worth and is neither income nor spending.
  await live.exec(`
    INSERT INTO transactions (account_id, posted_at, amount, direction, type,
                              origin, excluded_from_analytics)
    VALUES ('${IDS.checking}', '${day(16)}', 250.00, 'credit', 'adjustment', 'manual', true)
  `);

  const withAdjustment = await checkInvariant(live);
  check("a hand-booked adjustment does not fail the check", () =>
    assert.equal(withAdjustment.ok, true));
  check("it is reported as its own figure, +250", () =>
    assert.equal(round(withAdjustment.adjustments), 250));
  check("and net worth genuinely moved by it", () =>
    assert.equal(round(withAdjustment.observed), 10945 + 250));

  // §7.2 — a pre-auth is expense the moment it arrives and moves no balance
  // until it settles.
  await live.exec(`
    INSERT INTO transactions (account_id, posted_at, amount, direction, type,
                              state, category_id)
    VALUES ('${IDS.checking}', '${day(18)}', 1.00, 'debit', 'purchase', 'pending',
            '${CATEGORIES.groceries}')
  `);

  const withPending = await checkInvariant(live);
  check("a pending pre-auth does not fail the check either", () =>
    assert.equal(withPending.ok, true));
  check("it is reported separately as −1.00 of not-yet-posted movement", () =>
    assert.equal(round(withPending.unposted), -1));
  check("§6 counts it as spending straight away", () =>
    assert.equal(round(withPending.expected), 10945 - 1));
  check("and no balance reflects it yet", () =>
    assert.equal(round(withPending.observed), 10945 + 250));

  // The point of naming them: a real misclassification landing on top of both
  // is still caught, and still reported at its own size.
  await live.exec(`
    UPDATE transactions SET type = 'purchase', is_internal_transfer = false
     WHERE id = 'b0000000-0000-4000-a000-000000000001'
  `);
  const both = await checkInvariant(live);
  check("an 800 misclassification is still caught through both of them", () => {
    assert.equal(both.ok, false);
    assert.equal(round(both.unexplained), 800);
  });
  check("the tolerance is halalas, not a fudge factor", () =>
    assert.ok(TOLERANCE <= 0.01));
}

console.log("\n[13] THE PAGE RENDERS WITH AN EMPTY QUEUE");
{
  // The Review tab hides itself when nothing is parked, so this route is
  // reached by URL or from Settings on exactly the days when everything is
  // working. Every figure on it therefore has to have an answer for "nothing
  // has happened", and the failure mode is not a wrong number — it is a
  // .toFixed() on a null taking the whole page down.
  const empty = await boot({ rows: false });

  const statuses = await rowsOf(empty, `SELECT status::text, count(*)::int AS n
                                          FROM raw_messages GROUP BY status`);
  const methods = await rowsOf(empty, `SELECT COALESCE(parse_method::text, 'unattributed') AS method,
                                              count(*)::int AS n
                                         FROM raw_messages WHERE status = 'parsed' GROUP BY 1`);
  const [{ last_received: lastReceived }] = await rowsOf(
    empty,
    `SELECT max(received_at) AS last_received FROM raw_messages`,
  );

  check("an empty raw_messages yields no status rows rather than an error", () =>
    assert.deepEqual([statuses.length, methods.length], [0, 0]));
  check("and no last-received timestamp", () => assert.equal(lastReceived, null));

  const health = { ...health0 };

  check("the queue is empty, not undefined", () =>
    assert.deepEqual(groupByShape([]), []));
  check("parse rate is '—', not 100%", () => assert.equal(parseRate(health), null));
  check("template hit rate is '—', not 100%", () =>
    assert.equal(templateHitRate(health), null));
  check("silence is not reported as stale ingestion when nothing ever arrived", () =>
    assert.equal(ingestionStale(health.lastReceived), false));
  check("an empty queue is not a stalled tick", () =>
    assert.equal(parsingStalled(health.oldestQueued), false));
  check("the LLM row still renders", () => assert.equal(llmStatus(0, 30).enabled, false));

  const blank = masterInvariant({ accounts: [], movements: [], income: 0, expense: 0 });
  check("the invariant passes on an empty ledger and says there is nothing in it", () => {
    assert.equal(blank.ok, true);
    assert.equal(blank.empty, true);
  });

  check("no queue means no derived review-queue alert", () =>
    assert.deepEqual(rankAlerts([], reviewQueueAlert(0)), []));

  // The export section is the reason this page is worth reaching on a quiet
  // day, so it must have something to say when nothing has ever been exported.
  const never = backupState(null, new Date("2026-08-19T09:00:00Z"));
  check("a database that has never been exported says so, loudly", () => {
    assert.equal(never.never, true);
    assert.equal(never.due, true);
    assert.match(never.title, /never been exported/);
  });
}

console.log("\n[14] THE MONTHLY BACKUP REMINDER (§11.6)");
{
  const now = new Date("2026-08-19T09:00:00Z");
  const daysAgo = (d) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  check("a fresh backup is not due", () =>
    assert.equal(backupState(daysAgo(3), now).due, false));
  check("and reports its age in whole days", () =>
    assert.equal(backupState(daysAgo(3), now).days, 3));
  check(`one older than ${EXPORT_INTERVAL_DAYS} days is due`, () =>
    assert.equal(backupState(daysAgo(EXPORT_INTERVAL_DAYS + 1), now).due, true));
  check("the day before the interval is not yet due", () =>
    assert.equal(backupState(daysAgo(EXPORT_INTERVAL_DAYS - 1), now).due, false));

  // §11.6 keeps alerts in-app only, "but every alert is a row… so adding a
  // delivery channel later is a rendering change rather than a rewrite". The
  // reminder therefore has to render as a row like any other.
  const view = toAlertView({
    id: "1",
    type: "export_reminder",
    severity: "info",
    payload: { days: 41, never: false },
    createdAt: now,
  });
  check("the reminder renders as an ordinary alert row", () =>
    assert.match(view.title, /41 days/));
  check("and lands on the page that has the export on it", () =>
    assert.equal(view.href, "/review"));

  const first = toAlertView({
    id: "2",
    type: "export_reminder",
    severity: "info",
    payload: { never: true },
    createdAt: now,
  });
  check("never having backed up is worded as its own situation", () =>
    assert.match(first.title, /never been backed up/));
}

console.log("\n[15] THE REMINDER RAISES, CLEARS, AND NEVER PILES UP");
{
  // The write path, run as the nightly pass runs it — `raiseExportReminder`
  // itself, against real Postgres, not a copy of its logic. Both halves matter:
  // raising without clearing leaves a stale alert sitting on Home after you have
  // already exported, which teaches you that the alerts on this dashboard are
  // not worth reading — and that lesson generalises to the drift alerts, which
  // are the ones that mean something.
  const pg = await boot({ rows: false });
  const db = drizzle(pg);
  const openReminders = async () =>
    (
      await pg.query(
        `SELECT id FROM alerts WHERE type = '${EXPORT_REMINDER}' AND dismissed_at IS NULL`,
      )
    ).rows;

  const now = new Date("2026-08-19T09:00:00Z");

  // Every count is resolved BEFORE `check` sees it: `check` calls its function
  // synchronously, so an async assertion handed to it is a promise nobody
  // awaits — it prints PASS whatever it was going to find.
  const first = await raiseExportReminder(db, { now });
  const afterFirst = (await openReminders()).length;
  check("a database that has never been exported is owed a backup", () => {
    assert.equal(first.due, true);
    assert.equal(first.raised, true);
  });
  check("and the reminder exists as a row, not as a render-time condition", () =>
    assert.equal(afterFirst, 1));

  const second = await raiseExportReminder(db, { now });
  const afterSecond = (await openReminders()).length;
  check("running again the next night does not raise a second one", () =>
    assert.equal(second.raised, false));
  check("still exactly one open reminder", () => assert.equal(afterSecond, 1));

  // Downloading the raw dump is the moment the backup exists — and the moment
  // the reminder is answered. It closes there rather than waiting for the next
  // nightly pass, because up to 24 hours of a banner insisting you have never
  // backed up, right after you did, is how the whole banner stops being read.
  await stampExport(db, now);
  const clearedOnExport = (await openReminders()).length;
  check("downloading the dump closes the reminder immediately", () =>
    assert.equal(clearedOnExport, 0));

  const cleared = await raiseExportReminder(db, { now });
  const afterClear = (await openReminders()).length;
  check("and the nightly pass agrees nothing is owed", () => {
    assert.equal(cleared.due, false);
    assert.equal(cleared.raised, false);
  });
  check("nothing is left open", () => assert.equal(afterClear, 0));

  const later = new Date(now.getTime() + (EXPORT_INTERVAL_DAYS + 1) * 86_400_000);
  const again = await raiseExportReminder(db, { now: later });
  check("and it comes back once the backup goes stale", () =>
    assert.equal(again.raised, true));

  // §11.6 stores it as a row so a channel is a rendering change later; the row
  // has to carry enough payload for that rendering to say something specific.
  const [row] = (
    await pg.query(
      `SELECT severity::text AS severity, payload FROM alerts
        WHERE type = '${EXPORT_REMINDER}' AND dismissed_at IS NULL`,
    )
  ).rows;
  check("housekeeping is 'info' — a warning here devalues the real ones", () =>
    assert.equal(row.severity, "info"));
  check("the payload carries the age the rendering needs", () =>
    assert.equal(row.payload.days, EXPORT_INTERVAL_DAYS + 1));
}

console.log(`\n${"=".repeat(60)}\nALL ${n} REVIEW-VIEW CHECKS PASS\n${"=".repeat(60)}`);
