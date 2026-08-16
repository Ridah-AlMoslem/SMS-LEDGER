import type { NextRequest } from "next/server";

import { EXPORT_LIMIT, ledgerExport } from "@/db/ledger";
import { dateScope, exportName, readFilters } from "@/lib/ledger-filters";
import { readSelection } from "@/lib/period-params";

/**
 * The current filtered view, as CSV or JSON (SPEC §11.6).
 *
 * §11.6 makes export a v1 requirement under "data ownership", and the scoping
 * is what makes it useful: the file contains what the screen contains, because
 * both are drawn by `readFilters` over the same query string. An export that
 * silently meant "everything" would be a different document from the one the
 * button appeared to offer.
 *
 * A GET route so the button is a plain link. A download started by script from
 * a blob is a download that fails differently in every browser, and this one
 * has to work from a phone.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const { grain, period } = readSelection(params);
  const filters = readFilters(params);
  const scope = dateScope(filters, grain, period);
  const format = params.get("format") === "json" ? "json" : "csv";

  let rows;
  try {
    rows = await ledgerExport(filters, scope);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const filename = exportName(scope, filters, format);
  const truncated = rows.length >= EXPORT_LIMIT;

  const headers: Record<string, string> = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    // Says so in a header rather than by quietly returning a short file. An
    // export that is missing rows and does not mention it is worse than one
    // that refuses.
    ...(truncated ? { "X-Ledger-Truncated": String(EXPORT_LIMIT) } : {}),
  };

  if (format === "json") {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return new Response(toCsv(rows), {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
  });
}

/**
 * RFC 4180, plus two concessions to the two programs that will actually open
 * this file.
 *
 * The BOM is for Excel: without it, Excel reads a UTF-8 CSV as the local
 * codepage and every Arabic merchant name and biller in the file becomes
 * mojibake. It is invisible to everything else.
 *
 * The leading apostrophe on `=`, `+` and `@` is formula injection: a spreadsheet
 * treats a cell beginning with one as a formula, and these cells contain
 * attacker-adjacent text — SMS bodies from whoever sent them. `-` is left alone
 * so that a negative figure stays a number.
 */
function toCsv(rows: Record<string, string>[]): string {
  if (rows.length === 0) return "﻿";

  const columns = Object.keys(rows[0]);
  const lines = [columns.map(escape).join(",")];

  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c] ?? "")).join(","));
  }

  return `﻿${lines.join("\r\n")}\r\n`;
}

function escape(value: string): string {
  const guarded = /^[=+@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
