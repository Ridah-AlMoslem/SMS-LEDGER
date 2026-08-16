import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: Db | null = null;

/**
 * Lazily-built client.
 *
 * Not a module-level singleton on purpose: `next build` imports every page to
 * prerender it, and a top-level connection would make the build fail on any
 * machine without DATABASE_URL set — including CI, where there is no database
 * and no need for one.
 *
 * Supabase pools connections externally, so `max: 1` here is right for
 * serverless: each invocation is short-lived, and a pool per invocation
 * exhausts the free-tier connection limit quickly.
 *
 * The rule that keeps `max: 1` workable is at the call sites, not here: a
 * `Promise.all` of independent queries dispatches them onto one pooler
 * connection in a single tick, and the transaction pooler answers the first two
 * and then stalls the rest permanently — no error, no timeout, and since this
 * client is a module-level singleton, every later request in the process hangs
 * behind them. Home was rebuilt around that once already; the ledger's facets
 * were rebuilt around it again.
 *
 * Widening the pool is not the fix and was measured not to be: 12 concurrent
 * statements stall identically at `max: 4`. Sequential awaits and combined
 * statements are the fix, and they cost one round trip each — see
 * `db/aggregates.ts`, `db/home.ts` and `ledgerFacets` in `db/ledger.ts`.
 */
export function getDb(): Db {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to web/.env.local and fill in " +
        "the Supabase pooled connection string (port 6543).",
    );
  }

  cached = drizzle(postgres(url, { prepare: false, max: 1 }), { schema });
  return cached;
}

export { schema };
