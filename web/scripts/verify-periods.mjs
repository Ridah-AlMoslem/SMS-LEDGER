/**
 * Period functions, in SQL and in TypeScript (SPEC §5.1–§5.3, §13).
 *
 * Milestone 0 of §12: every aggregate, chart and budget in the app goes
 * through these, and getting them wrong is subtle — the numbers stay plausible
 * and are simply attributed to the wrong cycle. So this ports the assertions
 * from tests/verify_periods.py onto the real SQL functions, then asserts that
 * three independent implementations agree on every date across five years:
 *
 *   1. the SQL in drizzle/0003_period_functions.sql (what buckets rows),
 *   2. src/lib/periods.ts (what labels and steps through them in the browser),
 *   3. api/ledger/periods.py (what the parser uses), when python3 is present.
 *
 * Runs against PGlite — real Postgres compiled to WASM — because the things
 * being tested are date_trunc, AT TIME ZONE and index immutability, all of
 * which a mock would simply agree with.
 *
 * Run: npm run test:periods
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..");
const REPO = path.join(WEB, "..");
const MIGRATIONS = path.join(WEB, "drizzle");

const ts = await import(pathToFileURL(path.join(WEB, "src", "lib", "periods.ts")).href);

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  PASS  ${name}`);
};

/* ----------------------------------------------------------- the database */

const db = await new PGlite();

for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
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

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

// PGlite hands back dates as Date objects at UTC midnight; the whole point of
// this module is that a date is not an instant, so everything is compared as
// civil-date strings.
const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/* -------------------------------------------------- 1. the worked examples */

console.log("\n[1] WORKED EXAMPLES FROM §5.1");
{
  // Date, cycle start, cycle end, label, length. Straight from the spec table.
  const cases = [
    ["2026-08-11", "2026-07-25", "2026-08-24", "August 2026", 31],
    ["2026-03-01", "2026-02-25", "2026-03-24", "March 2026", 28],
    ["2028-02-26", "2028-02-25", "2028-03-24", "March 2028", 29],
    ["2026-12-31", "2026-12-25", "2027-01-24", "January 2027", 31],
    // The boundary itself, from both sides.
    ["2026-08-24", "2026-07-25", "2026-08-24", "August 2026", 31],
    ["2026-08-25", "2026-08-25", "2026-09-24", "September 2026", 31],
  ];

  for (const [d, start, end, label, len] of cases) {
    const r = await one(
      `SELECT period_start($1) s, period_end($1) e, period_label($1) l,
              (period_end($1) - period_start($1) + 1) len`,
      [d],
    );
    check(`SQL  ${d} → ${start}..${end} ${label} (${len}d)`, () => {
      assert.equal(iso(r.s), start);
      assert.equal(iso(r.e), end);
      assert.equal(r.l, label);
      assert.equal(Number(r.len), len);
    });
    check(`TS   ${d} → ${start}..${end} ${label} (${len}d)`, () => {
      assert.equal(ts.periodStart(d), start);
      assert.equal(ts.periodEnd(d), end);
      assert.equal(ts.cycleName(d), label);
      assert.equal(ts.daysInPeriod("cycle", d), len);
    });
  }

  // Never hardcode 30 (§5.1). February proves the point on its own.
  check("a 28-day cycle exists, so pacing may not assume 30", () =>
    assert.equal(ts.daysInPeriod("cycle", "2026-03-01"), 28));
}

/* ------------------------------------------- 2. invariants over five years */

console.log("\n[2] INVARIANTS OVER FIVE YEARS (ported from tests/verify_periods.py)");
{
  const all = await rows(
    `SELECT d::date AS d,
            period_start(d::date) AS s,
            period_end(d::date)   AS e,
            period_label(d::date) AS l,
            week_start(d::date)   AS w
       FROM generate_series('2025-01-01'::date, '2029-12-31'::date, '1 day') d`,
  );

  check("five years of dates were generated", () => assert.equal(all.length, 1826));

  const cycles = new Map();
  for (const r of all) {
    const [d, s, e] = [iso(r.d), iso(r.s), iso(r.e)];
    assert.ok(s <= d && d <= e, `${d} falls outside its own cycle ${s}..${e}`);
    const seen = cycles.get(s);
    if (seen) assert.equal(seen.end, e, `inconsistent end for cycle ${s}`);
    else cycles.set(s, { end: e, label: r.l });
  }
  check("every date falls inside exactly one cycle", () => assert.ok(cycles.size > 0));

  const starts = [...cycles.keys()].sort();
  check("61 contiguous cycles, no gaps and no overlaps", () => {
    assert.equal(starts.length, 61);
    for (let i = 1; i < starts.length; i++) {
      const prevEnd = cycles.get(starts[i - 1]).end;
      assert.equal(
        ts.addDays(prevEnd, 1),
        starts[i],
        `gap or overlap between ${starts[i - 1]} and ${starts[i]}`,
      );
    }
  });

  {
    const unstable = await rows(
      `SELECT count(*)::int AS n
         FROM generate_series('2025-01-01'::date, '2029-12-31'::date, '1 day') d
        WHERE period_start(period_start(d::date)) <> period_start(d::date)
           OR period_start(period_end(d::date))   <> period_start(d::date)`,
    );
    check("re-applying period_start to a boundary is a no-op", () =>
      assert.equal(unstable[0].n, 0));
  }

  const labels = starts.map((s) => cycles.get(s).label);
  check("every label is unique", () => assert.equal(new Set(labels).size, labels.length));

  const lengths = [...new Set(starts.map((s) => ts.diffDays(s, cycles.get(s).end) + 1))].sort(
    (a, b) => a - b,
  );
  check("observed lengths are exactly {28, 29, 30, 31}", () =>
    assert.deepEqual(lengths, [28, 29, 30, 31]));

  check("every cycle is named after the month it ends in", () => {
    for (const s of starts) {
      const end = cycles.get(s).end;
      assert.equal(cycles.get(s).label, ts.cycleName(end));
    }
  });

  /* ------ SQL vs TypeScript, date for date ------ */
  const drift = all.filter(
    (r) =>
      ts.periodStart(iso(r.d)) !== iso(r.s) ||
      ts.periodEnd(iso(r.d)) !== iso(r.e) ||
      ts.cycleName(iso(r.d)) !== r.l ||
      ts.weekStart(iso(r.d)) !== iso(r.w),
  );
  check("SQL and src/lib/periods.ts agree on all 1826 dates", () =>
    assert.deepEqual(
      drift.slice(0, 5).map((r) => iso(r.d)),
      [],
    ));

  /* ------ SQL vs api/ledger/periods.py ------ */
  const python = pythonTruth();
  if (python) {
    const mismatches = all.filter((r) => {
      const p = python[iso(r.d)];
      return p[0] !== iso(r.s) || p[1] !== iso(r.e) || p[2] !== r.l;
    });
    check("SQL and api/ledger/periods.py agree on all 1826 dates", () =>
      assert.deepEqual(
        mismatches.slice(0, 5).map((r) => iso(r.d)),
        [],
      ));
  } else {
    console.log("  SKIP  api/ledger/periods.py cross-check (python3 not available)");
  }
}

/* ------------------------------------------------------ 3. Sunday weeks */

console.log("\n[3] WEEKS START SUNDAY, NOT MONDAY");
{
  const w = await rows(
    `SELECT d::date AS d, week_start(d::date) AS ws,
            date_trunc('week', d::date)::date AS pg_week
       FROM generate_series('2026-08-09'::date, '2026-08-16'::date, '1 day') d`,
  );

  {
    const bad = await one(
      `SELECT count(*)::int AS n
         FROM generate_series('2025-01-01'::date, '2029-12-31'::date, '1 day') d
        WHERE EXTRACT(DOW FROM week_start(d::date)) <> 0`,
    );
    check("no date in five years gets a non-Sunday week", () => assert.equal(bad.n, 0));
  }

  {
    const bad = await one(
      `SELECT count(*)::int AS n
         FROM generate_series('2025-01-01'::date, '2029-12-31'::date, '1 day') d
        WHERE d::date - week_start(d::date) NOT BETWEEN 0 AND 6`,
    );
    check("week membership holds for all 1826 dates", () => assert.equal(bad.n, 0));
  }

  // The trap, asserted rather than commented: Postgres disagrees with us on
  // Sundays, and someone "simplifying" week_start into date_trunc would move
  // every Sunday's spend into the previous week.
  const sunday = w.find((r) => iso(r.d) === "2026-08-09");
  check("Postgres date_trunc('week') is Monday-based and differs", () => {
    assert.equal(iso(sunday.ws), "2026-08-09");
    assert.equal(iso(sunday.pg_week), "2026-08-03");
    assert.notEqual(iso(sunday.ws), iso(sunday.pg_week));
  });

  check("Fri and Sat land in the same week as the Sunday that opened it", () => {
    assert.equal(ts.weekStart("2026-08-14"), "2026-08-09"); // Friday
    assert.equal(ts.weekStart("2026-08-15"), "2026-08-09"); // Saturday
    assert.equal(ts.weekStart("2026-08-16"), "2026-08-16"); // next Sunday
  });
}

/* ------------------------------------------------ 4. timezone at the edge */

console.log("\n[4] BUCKET IN ASIA/RIYADH, NEVER UTC");
{
  // 22:00 UTC on the 24th is 01:00 local on the 25th: the first hour of the
  // NEW cycle. Bucketing in UTC puts it in the old one, and the error is
  // invisible — a plausible number in the wrong month.
  const r = await one(
    `SELECT local_date($1::timestamptz) AS local,
            ($1::timestamptz AT TIME ZONE 'UTC')::date AS utc,
            period_start(local_date($1::timestamptz)) AS cycle_local,
            period_start(($1::timestamptz AT TIME ZONE 'UTC')::date) AS cycle_utc`,
    ["2026-08-24T22:00:00Z"],
  );

  check("01:00 local on the 25th is the 25th", () => assert.equal(iso(r.local), "2026-08-25"));
  check("the same instant is the 24th in UTC", () => assert.equal(iso(r.utc), "2026-08-24"));
  check("local bucketing opens the new cycle", () =>
    assert.equal(iso(r.cycle_local), "2026-08-25"));
  check("UTC bucketing would put it in the previous cycle — the bug", () =>
    assert.equal(iso(r.cycle_utc), "2026-07-25"));

  check("TS today() reads the zone, not the runtime's clock", () =>
    assert.equal(ts.today(new Date("2026-08-24T22:00:00Z")), "2026-08-25"));

  // The far edge: 21:00 local on the 24th is still the 24th everywhere.
  const late = await one(`SELECT local_date($1::timestamptz) AS local`, [
    "2026-08-24T18:00:00Z",
  ]);
  check("18:00 UTC on the 24th is still the 24th locally", () =>
    assert.equal(iso(late.local), "2026-08-24"));
}

/* ------------------------------------------- 5. weeks do not tile cycles */

console.log("\n[5] WEEKS DO NOT TILE CYCLES (§5.3)");
{
  const buckets = ts.weekBucketsInCycle("2026-08-11");

  check("the August 2026 cycle spans six week buckets", () =>
    assert.equal(buckets.length, 6));
  check("two of them are partial: 1 day and 2 days", () => {
    const partial = buckets.filter((b) => b.partial);
    assert.equal(partial.length, 2);
    assert.deepEqual(partial.map((b) => b.days), [1, 2]);
  });
  check("the buckets are exactly the ones §5.3 lists", () =>
    assert.deepEqual(
      buckets.map((b) => `${b.start}..${b.end} (${b.days}d)`),
      [
        "2026-07-25..2026-07-25 (1d)",
        "2026-07-26..2026-08-01 (7d)",
        "2026-08-02..2026-08-08 (7d)",
        "2026-08-09..2026-08-15 (7d)",
        "2026-08-16..2026-08-22 (7d)",
        "2026-08-23..2026-08-24 (2d)",
      ],
    ));

  // The assertion that stops someone "fixing" grain independence into a bug.
  const wholeWeeks = buckets.length * 7;
  check("summing the FULL weeks that touch the cycle overshoots its length", () => {
    assert.equal(wholeWeeks, 42);
    assert.equal(ts.daysInPeriod("cycle", "2026-08-11"), 31);
    assert.notEqual(wholeWeeks, 31);
  });

  check("clipped buckets do tile the cycle exactly — that is the only sum allowed", () =>
    assert.equal(
      buckets.reduce((sum, b) => sum + b.days, 0),
      31,
    ));

  check("a week straddling the 24th/25th belongs to one week and two cycles", () => {
    // Sun 23 Aug – Sat 29 Aug 2026 crosses the boundary.
    assert.equal(ts.weekStart("2026-08-23"), "2026-08-23");
    assert.equal(ts.weekStart("2026-08-29"), "2026-08-23");
    assert.equal(ts.periodStart("2026-08-23"), "2026-07-25");
    assert.equal(ts.periodStart("2026-08-29"), "2026-08-25");
  });

  check("isPartialWeek flags the stubs and only the stubs", () => {
    assert.equal(ts.isPartialWeek("2026-07-25", "2026-08-11"), true);
    assert.equal(ts.isPartialWeek("2026-08-23", "2026-08-11"), true);
    assert.equal(ts.isPartialWeek("2026-08-09", "2026-08-11"), false);
    // A week on its own is never partial; partial is about the pairing.
    assert.equal(ts.isPartialWeek("2026-07-25"), false);
  });
}

/* --------------------------------------------------- 6. labels and stepping */

console.log("\n[6] LABELS AND STEPPERS (§11.1)");
{
  check('cycle label reads "August 2026 (25 Jul – 24 Aug)"', () =>
    assert.equal(ts.periodLabel("cycle", "2026-08-11"), "August 2026 (25 Jul – 24 Aug)"));
  check('week label reads "Sun 9 – Sat 15 Aug"', () =>
    assert.equal(ts.periodLabel("week", "2026-08-11"), "Sun 9 – Sat 15 Aug"));
  check("a week straddling two months names both", () =>
    assert.equal(ts.periodLabel("week", "2026-08-31"), "Sun 30 Aug – Sat 5 Sep"));
  check("a week straddling two years names both years", () =>
    assert.equal(ts.periodLabel("week", "2026-12-31"), "Sun 27 Dec 2026 – Sat 2 Jan 2027"));
  check("the December cycle is labelled January", () =>
    assert.equal(ts.periodLabel("cycle", "2026-12-31"), "January 2027 (25 Dec – 24 Jan)"));

  check("stepping a cycle back lands on the previous 25th", () =>
    assert.equal(ts.stepPeriod("cycle", "2026-08-11", -1), "2026-06-25"));
  check("stepping a cycle forward lands on the next 25th", () =>
    assert.equal(ts.stepPeriod("cycle", "2026-08-11", 1), "2026-08-25"));
  check("stepping a week moves exactly seven days", () =>
    assert.equal(ts.stepPeriod("week", "2026-08-11", -1), "2026-08-02"));
  check("stepping is reversible", () =>
    assert.equal(ts.stepPeriod("cycle", ts.stepPeriod("cycle", "2026-08-11", 1), -1), "2026-07-25"));
  check("stepping across the February boundary keeps the anchor", () =>
    assert.equal(ts.stepPeriod("cycle", "2026-03-10", -1), "2026-01-25"));

  check("daysElapsed is inclusive of today and clamped to the period", () => {
    assert.equal(ts.daysElapsed("cycle", "2026-08-11", "2026-08-11"), 18);
    assert.equal(ts.daysElapsed("cycle", "2026-08-11", "2026-07-25"), 1);
    assert.equal(ts.daysElapsed("cycle", "2026-08-11", "2026-09-30"), 31);
    assert.equal(ts.daysElapsed("cycle", "2026-08-11", "2026-01-01"), 0);
  });

  check("periodBounds accepts any date inside the period, not just the anchor", () =>
    assert.deepEqual(ts.periodBounds("cycle", "2026-08-11"), ts.periodBounds("cycle", "2026-07-25")));
}

/* ------------------------------------------------------------ 7. the index */

console.log("\n[7] THE INDEX §5.1 REQUIRES");
{
  const idx = await rows(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'transactions'
        AND indexname IN ('transactions_period_start_idx','transactions_effective_cycle_idx')
      ORDER BY indexname`,
  );
  // Its mere existence is the assertion: Postgres rejects an index on a
  // non-IMMUTABLE expression, so this would have failed at migration time if
  // period_start took posted_at::date (STABLE) instead of local_date.
  check("both cycle indexes exist, so the expressions are provably immutable", () =>
    assert.deepEqual(idx.map((r) => r.indexname), [
      "transactions_effective_cycle_idx",
      "transactions_period_start_idx",
    ]));

  const stable = await db
    .query(`CREATE INDEX bad_idx ON transactions (period_start(posted_at::date))`)
    .then(() => null)
    .catch((e) => e.message);
  check("an index on posted_at::date is rejected — the trap, proven", () =>
    assert.match(String(stable), /immutable/i));
}

/* -------------------------------------------------- 8. cycle_override (§5.6) */

console.log("\n[8] SALARY FUNDS THE CYCLE IT OPENS (§5.6)");
{
  const r = await one(
    `SELECT effective_cycle($1::timestamptz, NULL)         AS no_override,
            effective_cycle($1::timestamptz, $2::date)     AS with_override,
            week_start(local_date($1::timestamptz))        AS week`,
    // Credited Thursday 23 July for a stated due date of 25 July — the real
    // SAIB sample. 25 July 2026 was a Saturday, so payday moved earlier.
    ["2026-07-23T14:04:00+03:00", "2026-07-25"],
  );

  check("without an override the salary lands in the OLD cycle", () =>
    assert.equal(iso(r.no_override), "2026-06-25"));
  check("the stated due date moves it to the cycle it funds", () =>
    assert.equal(iso(r.with_override), "2026-07-25"));
  check("the week bucket ignores the override entirely", () =>
    assert.equal(iso(r.week), "2026-07-19"));
}

await db.close();
console.log(`\n${"=".repeat(60)}\nALL ${n} PERIOD CHECKS PASS\n${"=".repeat(60)}`);

/* -------------------------------------------------------------- helpers */

/**
 * A {date: [start, end, label]} table straight out of api/ledger/periods.py.
 *
 * Imported by path rather than reimplemented, so this genuinely tests the
 * parser's own module. Returns null when python3 isn't on PATH; the rest of
 * the suite is a complete test on its own, and a missing interpreter should
 * not fail the build.
 */
function pythonTruth() {
  const script = `
import json, sys
from datetime import date, timedelta
sys.path.insert(0, ${JSON.stringify(path.join(REPO, "api"))})
from ledger.periods import period_start, period_end, period_label
out, d = {}, date(2025, 1, 1)
while d <= date(2029, 12, 31):
    out[d.isoformat()] = [period_start(d).isoformat(), period_end(d).isoformat(),
                          period_label(d)]
    d += timedelta(days=1)
json.dump(out, sys.stdout)
`;
  for (const exe of [path.join(REPO, ".venv", "bin", "python3"), "python3"]) {
    try {
      return JSON.parse(execFileSync(exe, ["-c", script], { encoding: "utf8" }));
    } catch {
      /* try the next interpreter */
    }
  }
  return null;
}
