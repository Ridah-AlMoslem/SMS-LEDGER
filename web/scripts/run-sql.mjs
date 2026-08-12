/**
 * Run a .sql file against the database. Replaces `psql` for setup work.
 *
 *   node scripts/run-sql.mjs scripts/seed.local.sql
 *
 * psql is not installed by default on macOS and pulling in the whole Postgres
 * distribution to run one seed file is a poor trade. The `postgres` package is
 * already a dependency, so this needs nothing new.
 *
 * Uses DIRECT_URL (5432). The seed is one transaction and the pooler's
 * transaction mode gives no guarantee of a stable session across statements.
 */

import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

import "./env.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/run-sql.mjs <file.sql>");
  process.exit(1);
}

const full = path.resolve(process.cwd(), file);
if (!fs.existsSync(full)) {
  console.error(`not found: ${full}`);
  process.exit(1);
}

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DIRECT_URL is not set. Add the direct connection string (port 5432) to web/.env.local.",
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: (n) => console.log(`  notice: ${n.message}`) });

try {
  const text = fs.readFileSync(full, "utf8");
  await sql.unsafe(text);
  console.log(`applied ${path.basename(full)}`);

  // Show what landed, so a silent no-op is visible rather than assumed.
  // ON CONFLICT DO NOTHING makes re-running safe but also makes it quiet.
  const [{ count: accounts }] = await sql`SELECT count(*)::int FROM accounts`;
  const [{ count: identifiers }] = await sql`SELECT count(*)::int FROM account_identifiers`;
  console.log(`  accounts: ${accounts}   identifiers: ${identifiers}`);

  if (accounts > 0) {
    const rows = await sql`
      SELECT slug, type,
             to_char(current_balance, 'FM999,999,990.00') AS balance,
             CASE WHEN is_liability AND balance_semantics = 'available_credit'
                    THEN -(credit_limit - current_balance)
                  WHEN is_liability THEN -current_balance
                  ELSE current_balance END AS net
      FROM accounts ORDER BY sort_order`;

    console.log();
    for (const r of rows) {
      console.log(`  ${r.slug.padEnd(17)} ${r.type.padEnd(16)} ${String(r.balance).padStart(12)}`);
    }
    const net = rows.reduce((a, r) => a + Number(r.net), 0);
    console.log(`\n  net worth: ${net.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    console.log("  (a credit card contributes limit − balance as DEBT, not its balance)");
  }
} catch (err) {
  console.error(`\nfailed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
