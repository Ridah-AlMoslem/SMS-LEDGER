import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { getDb } from "@/db";
import { stampExport } from "@/db/backup";
import { toCsv } from "@/lib/csv";

/**
 * The whole of `raw_messages`, as CSV or JSON (SPEC §11.6, §3.1).
 *
 * **This is the backup.** §11.6: "the raw store is the irreplaceable asset,
 * since everything else can be re-derived from it (§3.1). You're on a free tier
 * that pauses on inactivity and offers no restore guarantees; treat your own
 * export as the backup."
 *
 * That is why this route exists separately from `/api/ledger/export` rather
 * than as another format of it. A ledger export is a *document*: it holds what a
 * screen was showing, in a shape a parser produced, and re-importing it would
 * reinstate whatever that parser got wrong at the time. This file is the input.
 * From it the entire ledger can be rebuilt by a better parser than the one
 * running today, which is the whole promise of §3.1 — "if you only persist the
 * parsed result, every parser bug becomes permanent data loss".
 *
 * Unfiltered and unscoped, deliberately. Every other export in the app narrows
 * to what you were looking at; a backup that quietly meant "this cycle" is not a
 * backup, and the failure would only be discovered on the day it mattered.
 *
 * A GET route so the button is a plain link — a download started by script from
 * a blob fails differently in every browser, and this one has to work from a
 * phone.
 */

export const dynamic = "force-dynamic";

/**
 * Generous, and enforced rather than assumed. Four banks at even a hundred
 * messages a day take a decade to reach this; the cap is here so that the one
 * case where it is exceeded produces a stated truncation instead of a function
 * timeout part-way through writing a file that looks complete.
 */
const DUMP_LIMIT = 200_000;

type Row = Record<string, unknown>;

const COLUMNS = [
  "id",
  "sender",
  "body",
  "received_at",
  "device_sent_at",
  "ingested_at",
  "body_hash",
  "status",
  "processed_at",
  "attempts",
  "last_attempt_at",
  "last_error",
  "ignored_reason",
  "classification",
  "language",
  "shape_hash",
  "template_id",
  "parse_method",
  "llm_response",
];

export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") === "json" ? "json" : "csv";

  let rows: Row[];
  try {
    rows = await getDb().execute<Row>(sql`
      SELECT id, sender, body,
             to_char(received_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at,
             to_char(device_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS device_sent_at,
             to_char(ingested_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ingested_at,
             body_hash,
             status::text AS status,
             to_char(processed_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS processed_at,
             attempts,
             to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_attempt_at,
             last_error,
             ignored_reason::text AS ignored_reason,
             classification::text AS classification,
             language::text AS language,
             shape_hash, template_id,
             parse_method::text AS parse_method,
             llm_response
        FROM raw_messages
       ORDER BY received_at, id
       LIMIT ${DUMP_LIMIT}
    `);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const truncated = rows.length >= DUMP_LIMIT;

  // Stamped only when the file is complete. A truncated dump is not a backup,
  // and recording it as one would silence the reminder precisely in the case
  // where the reminder is right. Failing to stamp must not fail the download —
  // the file in the reader's hands is the thing that matters, and the worst
  // consequence of a missed stamp is one more reminder.
  if (!truncated) {
    try {
      await stampExport(getDb());
    } catch {
      /* the dump succeeded; the bookkeeping is not worth losing it over */
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `raw-messages-${stamp}.${format}`;

  const headers: Record<string, string> = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    ...(truncated ? { "X-Ledger-Truncated": String(DUMP_LIMIT) } : {}),
  };

  if (format === "json") {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const flat = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const c of COLUMNS) {
      const v = r[c];
      out[c] =
        v === null || v === undefined
          ? ""
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
    }
    return out;
  });

  // Columns passed explicitly so an empty table still produces a header row —
  // a backup of zero messages should be recognisable as one, not as a
  // zero-byte file that could equally be a failed download.
  return new Response(toCsv(flat, COLUMNS), {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
  });
}
