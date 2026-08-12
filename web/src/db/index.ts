import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Supabase pools connections externally, so keep this client small. Serverless
// invocations are short-lived and each one holding a pool would exhaust the
// free-tier connection limit fast.
const client = postgres(url, { prepare: false, max: 1 });

export const db = drizzle(client, { schema });
export { schema };
