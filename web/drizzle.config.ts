import fs from "node:fs";
import path from "node:path";

import type { Config } from "drizzle-kit";

// Inlined rather than imported from scripts/env.mjs: drizzle-kit bundles this
// config through esbuild, and keeping it self-contained avoids resolution
// surprises. Same rules — shell values win, quotes stripped.
function loadEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value && !(key in process.env)) process.env[key] = value;
  }
}

loadEnvLocal();

/**
 * Migrations run over DIRECT_URL (port 5432), not DATABASE_URL (6543).
 *
 * The pooler runs in transaction mode: it hands out a different backend per
 * statement and does not support the session-level state that DDL and
 * advisory locks rely on. Migrations against it fail in confusing,
 * inconsistent ways — sometimes only partway through, which is worse than
 * failing outright.
 */
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DIRECT_URL is not set. Add the Session pooler string (port 5432) to " +
      "web/.env.local — the pooled 6543 connection cannot run migrations.",
  );
}

// Supabase's "Direct connection" host is IPv6-only. On an IPv4-only network
// drizzle-kit hangs after "Using 'postgres' driver" with no error at all, which
// is a genuinely difficult symptom to diagnose. Catch it here instead.
if (/db\.[a-z0-9]+\.supabase\.co/.test(url)) {
  throw new Error(
    "DIRECT_URL uses the IPv6-only direct connection, which hangs on IPv4-only " +
      "networks. Use the Session pooler: same host as DATABASE_URL, port 5432, " +
      "username postgres.<project-ref>.",
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
