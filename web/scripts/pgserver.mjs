/**
 * Throwaway Postgres for the integration tests.
 *
 * PGlite is real Postgres compiled to WASM, exposed here over the actual
 * Postgres wire protocol so psycopg connects to it exactly as it would to
 * Supabase. That matters: the things worth testing at this layer — ON CONFLICT
 * DO NOTHING, FOR UPDATE SKIP LOCKED, NUMERIC rounding — are all behaviours a
 * mock would simply agree with.
 *
 * Applies the current Drizzle migrations, so a schema change that breaks the
 * parser service fails here rather than in production.
 *
 * Usage: node tests/pgserver.mjs [port]   — prints READY when connectable.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, "..", "drizzle");
const PORT = Number(process.argv[2] ?? 5433);

const db = await new PGlite();

const files = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error(`no migrations in ${MIGRATIONS} — run: cd web && npx drizzle-kit generate`);
  process.exit(1);
}

for (const file of files) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
    try {
      await db.exec(stmt);
    } catch (err) {
      console.error(`migration ${file} failed:\n${stmt.slice(0, 300)}\n${err.message}`);
      process.exit(1);
    }
  }
}

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();
console.log(`READY ${files.length} migration(s) on port ${PORT}`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await server.stop();
    process.exit(0);
  });
}
