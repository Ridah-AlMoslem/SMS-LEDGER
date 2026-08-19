import type { NextRequest } from "next/server";

import { EXPORT_LIMIT, ledgerExport } from "@/db/ledger";
import { toCsv } from "@/lib/csv";
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
