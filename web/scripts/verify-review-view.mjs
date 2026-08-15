/**
 * Checks the review queue grouping (SPEC §10.7, §11.6).
 *
 * The grouping is the whole value of this screen: failures arrive in
 * format-shaped clusters, so a queue that lists forty identical messages
 * individually is a queue nobody works through. Grouping wrong — merging two
 * senders, or splitting one format apart — makes the bulk actions dangerous
 * rather than useful.
 *
 * Run: npm run test:review
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "lib", "review.ts");

const { groupByShape, parseRate, ingestionStale, parsingStalled, QUEUE_STALL_MS } =
  await import(pathToFileURL(SRC).href);

let n = 0;
const check = (name, fn) => {
  fn();
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

console.log(`\n${"=".repeat(60)}\nALL ${n} REVIEW-VIEW CHECKS PASS\n${"=".repeat(60)}`);
