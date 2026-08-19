import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { getDb } from "@/db";
import { raiseExportReminder } from "@/db/backup";
import { closeCycle, unclosedCycles } from "@/db/budgets";
import { runDetection } from "@/db/recurring";
import { today } from "@/lib/periods";

/**
 * The nightly pass behind Plan: close any cycle that has ended, then re-detect
 * recurring series (SPEC §11.2, §11.3).
 *
 * Driven by `pg_cron` through `pg_net`, the same way `/api/parse-tick` is — see
 * DEPLOY.md §3e for the schedule. Nightly rather than per-minute, because
 * neither half of this changes on a minute's notice: a cycle boundary happens
 * once a month, and a series that has been billing for a year is not going to
 * reveal itself between 03:00 and 03:01. The parser tick stays at a minute
 * because a message arriving is exactly the thing that does.
 *
 * Two things are deliberate:
 *
 *   - **Closing comes first.** Detection reads transactions and writes series;
 *     closing reads spend and writes carry. Neither depends on the other, but a
 *     detection failure must not be able to skip a cycle boundary — a carry that
 *     is never written is never written, because nothing recomputes it (§11.2).
 *   - **`unclosedCycles` finds the boundaries rather than assuming one.**
 *     Supabase pauses free projects after 7 days idle, so this endpoint can miss
 *     nights. Asking which cycles still owe a carry makes a missed night cost
 *     nothing, where "close last month" would silently skip whatever happened
 *     while the project was asleep.
 *   - **The backup reminder rides along.** §11.6: "a scheduled monthly export
 *     reminder is worth the two lines it costs". It belongs on a schedule rather
 *     than in the page render for the same reason as everything else here — a
 *     reminder that only exists while you are looking at the Review screen
 *     arrives exactly when you least need it. As an `alerts` row it reaches
 *     Home's banner too. It runs last: it writes one row and nothing depends on
 *     it, so a failure here must not cost a cycle its carry.
 *
 * This path shares its `/api/` prefix with the parser service (`vercel.json`
 * rewrites `/api/(.*)` to it, after the filesystem check that finds this route —
 * the same arrangement `/api/ledger` already relies on). DEPLOY.md's check for
 * this endpoint is a `curl` for exactly that reason: a 404 with a FastAPI body
 * is the signal that the rewrite won.
 */

// Reads and writes Postgres on every call; there is nothing to prerender.
export const dynamic = "force-dynamic";

/** `.strip()` on the secret, like `api/main.py` does and for the same reason: a
 *  value piped into `vercel env add` picks up a trailing newline with no visible
 *  trace, and the only symptom is a 401 indistinguishable from a wrong value. */
const CRON_SECRET = (process.env.CRON_SECRET ?? "").trim();

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length
 *  mismatch, which would itself leak the length. */
function authorised(presented: string): boolean {
  if (!CRON_SECRET) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(CRON_SECRET);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!authorised((request.headers.get("x-cron-secret") ?? "").trim())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = today();
  const db = getDb();

  try {
    // Sequential throughout — never `Promise.all`. Everything here runs on one
    // pooled connection, and a fan-out of independent statements onto Supabase's
    // transaction pooler stalls permanently rather than failing (`db/index.ts`).
    const open = await unclosedCycles(db, { now });

    const closed: { cycle: string; carried: number; settled: number; error?: string }[] = [];
    for (const cycle of open) {
      const result = await closeCycle(db, { cycle, now });
      closed.push(
        result.ok
          ? { cycle, carried: result.value.carried, settled: result.value.settled }
          : { cycle, carried: 0, settled: 0, error: result.error },
      );
    }

    const detection = await runDetection(db, { now });
    const backup = await raiseExportReminder(db);

    return Response.json({
      now,
      closed,
      detection: detection.ok ? detection.value : { error: detection.error },
      backup,
    });
  } catch (err) {
    // The message, not a bare 500. `net._http_response` is where this ends up,
    // and a body that says which statement failed is the difference between a
    // five-minute fix and an afternoon.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
