import type { NextRequest } from "next/server";

import { PAGE_SIZE, ledgerPage } from "@/db/ledger";
import { dateScope, readCursor, readFilters } from "@/lib/ledger-filters";
import { readSelection } from "@/lib/period-params";

/**
 * One page of the filtered ledger (SPEC §11.1).
 *
 * A GET route rather than a server action, for two reasons. Infinite scroll
 * wants requests that can overlap, and Next queues server actions one at a
 * time. And this URL takes exactly the parameters the page's own URL does — the
 * same `readFilters` parses both — so "what is the list showing" and "what will
 * the next page contain" cannot drift apart.
 *
 * Not cached: route handlers are uncached by default in this version, which is
 * correct here. A ledger page cached for even a minute would show an edit
 * reverting itself.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const { grain, period } = readSelection(params);
  const filters = readFilters(params);
  const scope = dateScope(filters, grain, period);

  try {
    const page = await ledgerPage(filters, scope, readCursor(params), PAGE_SIZE);
    return Response.json(page);
  } catch (err) {
    // The message, not a bare 500. Every page in this app renders the database
    // error it hit rather than an empty panel, because "can't reach the
    // database" and "no transactions this month" look identical otherwise.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
