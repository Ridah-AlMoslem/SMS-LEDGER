/**
 * Load .env.local for standalone scripts.
 *
 * Next.js reads .env.local automatically; nothing else does. drizzle-kit and
 * any script run with plain `node` start with an empty process.env, which is
 * why "DATABASE_URL is not set" shows up right after the app worked fine.
 *
 * Deliberately dependency-free and deliberately non-overriding: a value
 * already exported in the shell wins, so CI and one-off overrides behave the
 * way you'd expect.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadEnv(file = ".env.local") {
  const full = path.join(WEB_ROOT, file);
  if (!fs.existsSync(full)) return;

  for (const line of fs.readFileSync(full, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matched surrounding quotes; connection strings often carry them.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value && !(key in process.env)) process.env[key] = value;
  }
}

loadEnv();
