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
