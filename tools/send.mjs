/**
 * Send one signed message to a deployed ingest endpoint, from a terminal.
 *
 *   INGEST_SECRET=... BASE_URL=https://<app>.vercel.app \
 *     node tools/send.mjs "SAIB" "$(cat message.txt)"
 *
 * The point is to separate two questions that otherwise fail together. If this
 * gets a 202, the deployment, the secret, the database and the schema are all
 * fine, and anything the phone does wrong afterwards is the phone. Debugging a
 * shortcut against an endpoint you have not yet proven is guessing twice.
 *
 * It signs with the same `tools/shortcut-signer.js` the Shortcut runs, so a
 * pass here is evidence about that code specifically, not about node's crypto.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const signer = require("./shortcut-signer.js");

const [sender, bodyArg] = process.argv.slice(2);
const secret = process.env.INGEST_SECRET;
const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");

if (!sender || !bodyArg || !secret || !base) {
  console.error(
    "usage: INGEST_SECRET=... BASE_URL=https://<app>.vercel.app \\\n" +
      '         node tools/send.mjs "<sender>" @path/to/message.txt\n' +
      '         node tools/send.mjs "<sender>" "<body>"\n\n' +
      "Prefer @file. A bank SMS is right-to-left, multi-line, and full of\n" +
      "characters a shell wants to interpret; reading it from a file keeps\n" +
      "the terminal out of the loop entirely. Command substitution also\n" +
      "strips trailing newlines, so \"$(cat f)\" does not send what is in f.",
  );
  process.exit(1);
}

// @file reads the bytes as they are. Anything else is taken literally.
let body = bodyArg;
if (bodyArg.startsWith("@")) {
  const path = bodyArg.slice(1);
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`Could not read ${path} — ${err.code ?? err.message}`);
    process.exit(1);
  }
}

if (!body.trim()) {
  console.error("The message body is empty.");
  process.exit(1);
}

// Posted exactly as the phone posts it: the signer's single output value IS
// the request body. Sending it any other way would test a code path the phone
// never takes, which is the opposite of what this script is for.
const envelope = signer.buildRequest(
  `${sender}\n${body}`,
  secret,
  "cli",
  Date.now(),
);

let res;
try {
  res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: envelope,
  });
} catch (err) {
  // "Couldn't reach it" and "it said no" are different problems, and an
  // undici stack trace makes the first one look like the second.
  console.error(`Could not reach ${base} — ${err.cause?.code ?? err.message}`);
  process.exit(1);
}

console.log(`${res.status} ${res.statusText}`);
console.log(await res.text());

// 401 means the signature or the secret; 422 means the body shape; anything
// 5xx means the service reached the database and did not like what happened.
// Exit non-zero on all of them so this is usable in a script.
process.exit(res.status === 202 ? 0 : 1);
