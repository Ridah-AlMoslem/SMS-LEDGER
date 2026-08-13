/**
 * The period anchors — SPEC §5.5.
 *
 * This is the ONLY module in the TypeScript codebase that names 25, 0 or
 * Asia/Riyadh. Everything else takes them as arguments or imports them from
 * here. Inlining "25" at a call site is how a codebase ends up with two
 * definitions of when the month starts, and the resulting numbers stay
 * plausible while being wrong.
 *
 * The database row in `settings` is the runtime source of truth (read it with
 * `loadSettings()` in src/db/settings.ts); these constants are the fallback
 * used when there is no database in reach — during a build, in a pure unit
 * test, or in a client component, none of which can query.
 *
 * Deliberately dependency-free so client components can import it.
 */

export type PeriodSettings = {
  /** Day of month the salary cycle opens. */
  cycleAnchorDay: number;
  /** 0 = Sunday. Postgres's own week is Monday-based; ours is not. */
  weekStartDow: number;
  /** Every boundary is evaluated in this zone. Bucketing in UTC moves a
   *  01:00 purchase on the 25th into the previous cycle. */
  timezone: string;
};

export const DEFAULT_SETTINGS: PeriodSettings = {
  cycleAnchorDay: 25,
  weekStartDow: 0,
  timezone: "Asia/Riyadh",
};
