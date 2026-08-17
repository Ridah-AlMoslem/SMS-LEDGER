/**
 * The reason a query failed, not the wrapper around it.
 *
 * Drizzle wraps a driver failure in a `DrizzleQueryError` whose `message` is the
 * SQL it was running, and puts the actual explanation — `column "carry_in" does
 * not exist`, `read ECONNRESET`, `password authentication failed` — in `cause`.
 * A panel that prints only `err.message` therefore shows a screenful of SELECT
 * with the one useful sentence missing, which is how a missing migration comes
 * to look like a broken query.
 *
 * Causes are printed outermost-last, so the specific reason leads and the
 * context follows:
 *
 *   column "carry_in" does not exist — Failed query: SELECT …
 *
 * Every "Can't reach the database" panel in the app goes through here. The depth
 * cap exists because a driver can nest a chain several deep and the fourth link
 * is never the interesting one.
 */

const MAX_DEPTH = 4;

export function reason(err: unknown): string {
  const chain: string[] = [];
  let at: unknown = err;

  while (at instanceof Error && chain.length < MAX_DEPTH) {
    if (at.message) chain.push(at.message);
    at = at.cause;
  }

  if (chain.length === 0) return String(err);
  return chain.reverse().join(" — ");
}
