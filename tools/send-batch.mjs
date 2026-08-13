/**
 * Send a whole collected batch to a deployed ingest endpoint, in order.
 *
 *   INGEST_SECRET=... BASE_URL=https://<app>.vercel.app \
 *     node tools/send-batch.mjs samples/batch4_raw.txt
 *
 * `tools/send.mjs` sends one message and is the right tool for proving a
 * deployment works. This one is for landing a batch that accumulated while
 * the phone was not yet forwarding — a backfill, in other words, which is a
 * different job with a different failure mode.
 *
 * The difference that matters is `received_at`. send.mjs deliberately omits
 * it, because that is what the Shortcut does and testing a path the phone
 * never takes is pointless. A backfill is the opposite case: the messages
 * arrived hours or days ago, and letting the server default to now() has two
 * consequences, one cosmetic and one not.
 *
 *   - Cosmetic: `raw_messages.received_at` records the backfill, not the SMS.
 *   - Not: `body_hash` folds received_at in at minute precision (§10.2), so
 *     the same file sent twice produces two different hashes, dedup does not
 *     fire, and every transaction in it posts twice. A backfill script that
 *     is not safe to re-run is a script you cannot use when it fails halfway.
 *
 * So each block carries its own arrival time, and re-running is a no-op.
 *
 * Dates in the message BODY are unaffected by any of this — the parser reads
 * the bank's own printed timestamp and validates it against received_at
 * (§10.4.1). Note that validation rejects anything more than 72 hours older
 * than its arrival time, which is exactly what you want for live traffic and
 * exactly what will park an old backfill in review. Write down the real
 * arrival times and this does not arise.
 */

import { readFileSync } from "node:fs";

const [file] = process.argv.slice(2);
const secret = process.env.INGEST_SECRET;
const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const dryRun = process.argv.includes("--dry-run");

if (!file || !secret || !base) {
  console.error(
    "usage: INGEST_SECRET=... BASE_URL=https://<app>.vercel.app \\\n" +
      "         node tools/send-batch.mjs samples/batch4_raw.txt [--dry-run]\n\n" +
      "Each block is separated by a line of '=' and starts with a header:\n" +
      "    <sender> @ <ISO 8601 with offset>\n" +
      "The offset is not optional. A naive timestamp is read as UTC by the\n" +
      "server, which shifts a Riyadh evening back into the previous day and,\n" +
      "for a salary, into the previous cycle.",
  );
  process.exit(1);
}

/** Split on the separator, then peel the header line off each block. */
function parseBatch(text) {
  return text
    .split(/^={10,}$/m)
    .map((block) => block.replace(/^\n+/, "").replace(/\s+$/, ""))
    .filter(Boolean)
    .map((block) => {
      const newline = block.indexOf("\n");
      const header = (newline === -1 ? block : block.slice(0, newline)).trim();
      const body = newline === -1 ? "" : block.slice(newline + 1);
      const m = header.match(/^(.+?)\s*@\s*(\S+)$/);
      return m
        ? { sender: m[1].trim(), receivedAt: m[2], body }
        : { header, body, malformed: true };
    })
    // The preamble at the top of the file has no header and no body worth
    // sending. Anything else malformed is an error, not something to skip
    // quietly — see below.
    .filter((b) => !(b.malformed && !/^\S+\s*@/.test(b.header ?? "")) || b.body);
}

const blocks = parseBatch(readFileSync(file, "utf8")).filter((b) => !b.malformed);

if (blocks.length === 0) {
  console.error(`No message blocks found in ${file}.`);
  process.exit(1);
}

for (const b of blocks) {
  if (Number.isNaN(Date.parse(b.receivedAt))) {
    console.error(`Unparseable timestamp in header: ${b.sender} @ ${b.receivedAt}`);
    process.exit(1);
  }
}

console.log(`${blocks.length} message(s) from ${file}\n`);

let sent = 0;
let duplicate = 0;

for (const [i, b] of blocks.entries()) {
  const label = `${String(i + 1).padStart(2)}. ${b.sender} @ ${b.receivedAt}`;
  const preview = b.body.split("\n")[0].slice(0, 34);

  if (dryRun) {
    console.log(`${label}\n    ${preview}  (${b.body.length} chars) — not sent`);
    continue;
  }

  let res;
  try {
    res = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        sender: b.sender,
        body: b.body,
        received_at: b.receivedAt,
        device_id: "batch",
      }),
    });
  } catch (err) {
    console.error(`${label}\n    could not reach ${base} — ${err.cause?.code ?? err.message}`);
    process.exit(1);
  }

  const text = await res.text();
  let status = text;
  try {
    status = JSON.parse(text).status ?? text;
  } catch {
    /* keep the raw text — a non-JSON body is itself the diagnostic */
  }

  console.log(`${label}\n    ${preview}  →  ${res.status} ${status}`);

  // Stop on the first real failure. Continuing would bury a 401 under four
  // more 401s and leave you guessing which message the run actually got to.
  if (res.status !== 202) {
    console.error(`\nStopped at message ${i + 1}. ${text}`);
    process.exit(1);
  }
  if (status === "duplicate") duplicate += 1;
  else sent += 1;
}

if (dryRun) {
  console.log("\n--dry-run: nothing was sent.");
  process.exit(0);
}

console.log(`\n${sent} accepted, ${duplicate} already present.`);
console.log(
  "\nThey are stored, not yet parsed. pg_cron drives /api/parse-tick once a\n" +
    "minute; watch it land with:\n\n" +
    "  select sender, status, last_error, left(body, 32)\n" +
    "    from raw_messages order by received_at;\n",
);
