/**
 * Server-side read of the single `settings` row (SPEC §5.5).
 *
 * Separate from src/lib/settings.ts because that module is imported by client
 * components and must stay free of the database client. This one is
 * server-only.
 *
 * Falls back to the constants rather than throwing: a missing row would
 * otherwise take down every page that renders a period label, and the
 * fallbacks are the same values the migration seeds.
 */

import { getDb, schema } from "@/db";
import { DEFAULT_SETTINGS, type PeriodSettings } from "@/lib/settings";

export async function loadSettings(): Promise<PeriodSettings> {
  try {
    const [row] = await getDb()
      .select({
        cycleAnchorDay: schema.settings.cycleAnchorDay,
        weekStartDow: schema.settings.weekStartDow,
        timezone: schema.settings.timezone,
      })
      .from(schema.settings)
      .limit(1);

    return row ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}
