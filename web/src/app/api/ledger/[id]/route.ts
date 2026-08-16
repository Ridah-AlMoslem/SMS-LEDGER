import type { NextRequest } from "next/server";

import { transactionDetail } from "@/db/ledger";

/**
 * Everything behind one row: the raw message verbatim, the splits, the FX
 * provenance (SPEC §3.1, §9.6, §7.6).
 *
 * Fetched when the sheet opens rather than carried on every list row. The raw
 * body is the largest field in the schema and the list holds a hundred rows;
 * sending all of them so that one can be read would be most of the payload for
 * none of the screen.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/ledger/[id]">) {
  const { id } = await ctx.params;

  try {
    const detail = await transactionDetail(id);
    if (!detail) {
      return Response.json({ error: "That transaction no longer exists." }, { status: 404 });
    }
    return Response.json(detail);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
