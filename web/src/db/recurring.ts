/**
 * The recurring detector's database side — SPEC §11.3.
 *
 * `lib/recurring.ts` holds every rule and every threshold, and is pure. This
 * file does three things and no thinking: gather the charges the detector is
 * allowed to see, write what it concluded, and carry out the actions a person
 * takes on a series.
 *
 * **The gather query refuses internal transfers in SQL, not only in the
 * module.** `isDetectable` refuses them too, so this is the same rule stated
 * twice on purpose. §11.3's exclusion is the one whose failure is invisible: a
 * predicted savings transfer looks exactly like a predicted bill, and the
 * calendar would then contain money that was never leaving. A rule worth two
 * lines is worth stating in both places.
 *
 * **Charges are read from `transactions`, not from `v_categorized_amounts`.**
 * §9.6's rule is about *aggregating*, and this is not an aggregate: the detector
 * needs one row per charge carrying the whole amount. Through the view, a
 * subscription split across two categories would arrive as two half-price
 * charges on the same day — which is how a detector concludes that Netflix costs
 * 26 riyals and bills twice.
 *
 * Human decisions are never overwritten by a re-run. `status`, `confirmed_at`
 * and `dismissed_at` belong to the person; the amounts, the cadence and the
 * dates belong to the detector.
 */

import { sql } from "drizzle-orm";

import {
  DETECTABLE_TYPES,
  type Detected,
  type Occurrence,
  detectSeries,
} from "../lib/recurring.ts";
import type { CivilDate } from "../lib/periods.ts";
import { addMonths } from "../lib/periods.ts";
import type { Db, Result } from "./ledger-mutations.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- see ledger-mutations.ts. */

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

function normalise(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/**
 * How far back a detection pass looks.
 *
 * Fifteen cycles rather than twelve, so a yearly subscription has two charges
 * inside the window and can be seen at all — one charge is not a series. It is
 * also short enough that a subscription cancelled two years ago does not come
 * back to life every night.
 */
const WINDOW_CYCLES = 15;

/** The type list, built from the module's own map so there is one definition of
 *  what is detectable (and one place where `transfer` is absent). */
const DETECTABLE_LIST = sql.join(
  Object.keys(DETECTABLE_TYPES).map((t) => sql`${t}`),
  sql`, `,
);

/**
 * Every charge the detector is allowed to see.
 *
 * The `merchant_key` fallback chain is what lets a salary and a profit payout be
 * detected at all: neither carries a merchant, and a SADAD bill carries a biller
 * instead (§7.5). Anything that reaches the end of the chain with nothing has no
 * identity to recur as, and `isDetectable` drops it.
 */
export function occurrencesQuery(from: CivilDate) {
  return sql`
    SELECT t.id,
           t.type::text AS type,
           local_date(t.posted_at)::text AS day,
           t.amount,
           t.account_id,
           t.merchant_id,
           COALESCE(m.normalized_name,
                    lower(t.biller),
                    lower(t.merchant_raw),
                    lower(t.description),
                    CASE WHEN t.type IN ('income', 'profit')
                         THEN t.type::text || ':' || a.slug END) AS merchant_key,
           COALESCE(m.display_name,
                    t.biller,
                    t.merchant_raw,
                    t.description,
                    CASE t.type
                      WHEN 'income' THEN 'Salary'
                      WHEN 'profit' THEN a.name || ' profit'
                    END) AS label,
           t.is_internal_transfer,
           t.excluded_from_analytics,
           t.state::text AS state
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE local_date(t.posted_at) >= ${from}::date
       AND t.state = 'posted'
       -- §8.2.1 — a superseded leg is a second bank's description of one
       -- movement, not a second charge. Left in, it doubles every cross-bank
       -- series and halves the gap the cadence is measured from.
       AND t.superseded_by IS NULL
       -- §11.3, exclusion one. Savings transfers follow no routine, so any
       -- series found in them is noise, and a false prediction would put money
       -- in the bills calendar that was never leaving.
       AND NOT t.is_internal_transfer
       AND NOT t.excluded_from_analytics
       AND t.type::text IN (${DETECTABLE_LIST})
     ORDER BY t.posted_at
  `;
}

export type DetectionOutcome = {
  scanned: number;
  detected: number;
  written: number;
  /** Series a person has excluded from detection, left untouched. */
  skipped: number;
  /** Transactions linked back to their series (§4). */
  linked: number;
};

/**
 * One detection pass. Driven by the nightly tick.
 *
 * Sequential awaits throughout — never `Promise.all`. Everything here runs on
 * one pooled connection, and a fan-out of independent statements onto the
 * Supabase transaction pooler stalls permanently rather than failing (see
 * `db/index.ts`).
 */
export async function runDetection(
  db: Db,
  input: { now: CivilDate },
): Promise<Result<DetectionOutcome>> {
  const from = addMonths(input.now, -WINDOW_CYCLES);

  return db.transaction(async (tx: any) => {
    const rows = normalise(await tx.execute(occurrencesQuery(from)));

    const occurrences: Occurrence[] = rows.map((r: any) => ({
      transactionId: String(r.id),
      type: String(r.type),
      merchantKey: r.merchant_key === null ? null : String(r.merchant_key),
      merchantId: r.merchant_id === null ? null : String(r.merchant_id),
      label: r.label === null ? "Unnamed" : String(r.label),
      accountId: r.account_id === null ? null : String(r.account_id),
      amount: Number(r.amount),
      day: String(r.day),
      isInternalTransfer: Boolean(r.is_internal_transfer),
      excludedFromAnalytics: Boolean(r.excluded_from_analytics),
      state: String(r.state),
    }));

    const detected = detectSeries(occurrences);

    // The keys a person has told the detector to leave alone. Loaded up front
    // so an excluded series costs nothing per pass and, crucially, so its
    // amounts and cadence stop being updated rather than merely hidden.
    const excluded = new Set<string>(
      normalise(
        await tx.execute(sql`
          SELECT detect_key FROM recurring_series
           WHERE excluded_from_detection AND detect_key IS NOT NULL
        `),
      ).map((r: any) => String(r.detect_key)),
    );

    let written = 0;
    let skipped = 0;
    let linked = 0;

    for (const series of detected) {
      if (excluded.has(series.detectKey)) {
        skipped++;
        continue;
      }

      const id = await upsert(tx, series);
      if (!id) continue;
      written++;

      linked += await link(tx, id, series.transactionIds);
    }

    return ok({
      scanned: occurrences.length,
      detected: detected.length,
      written,
      skipped,
      linked,
    });
  });
}

/**
 * Write one detected series, keyed on its identity.
 *
 * `status` is deliberately absent from the update list. A series a person
 * paused or marked cancelled stays that way even when a charge appears — that
 * charge is exactly the thing worth showing them ("you cancelled this and it
 * billed anyway"), and silently flipping the status back to active would
 * overwrite the observation with a guess.
 */
async function upsert(tx: any, s: Detected): Promise<string | null> {
  const rows = normalise(
    await tx.execute(sql`
      INSERT INTO recurring_series
        (detect_key, label, merchant_id, account_id, kind, cadence, interval_days,
         amount_avg, amount_last, amount_prev, price_change_at, day_of_month,
         next_expected_at, first_seen, last_seen, occurrence_count, confidence)
      VALUES
        (${s.detectKey}, ${s.label}, ${s.merchantId}, ${s.accountId}, ${s.kind}::recurring_kind,
         ${s.cadence}::cadence, ${s.intervalDays},
         ${s.amountAvg.toFixed(2)}, ${s.amountLast.toFixed(2)},
         ${s.amountPrev === null ? null : s.amountPrev.toFixed(2)},
         ${s.priceChangeAt}::date, ${s.dayOfMonth},
         ${s.nextExpectedAt}::date, ${s.firstSeen}::date, ${s.lastSeen}::date,
         ${s.occurrenceCount}, ${s.confidence})
      ON CONFLICT (detect_key) DO UPDATE SET
        label            = EXCLUDED.label,
        merchant_id      = EXCLUDED.merchant_id,
        account_id       = EXCLUDED.account_id,
        cadence          = EXCLUDED.cadence,
        interval_days    = EXCLUDED.interval_days,
        amount_avg       = EXCLUDED.amount_avg,
        amount_last      = EXCLUDED.amount_last,
        amount_prev      = EXCLUDED.amount_prev,
        price_change_at  = EXCLUDED.price_change_at,
        day_of_month     = EXCLUDED.day_of_month,
        next_expected_at = EXCLUDED.next_expected_at,
        first_seen       = EXCLUDED.first_seen,
        last_seen        = EXCLUDED.last_seen,
        occurrence_count = EXCLUDED.occurrence_count,
        confidence       = EXCLUDED.confidence
      RETURNING id
    `),
  );

  return rows.length > 0 ? String(rows[0].id) : null;
}

/** §4 — `transactions.recurring_series_id` links an occurrence back to the
 *  series it belongs to, which is what makes a series row drillable. */
async function link(tx: any, seriesId: string, transactionIds: string[]): Promise<number> {
  if (transactionIds.length === 0) return 0;

  const ids = sql.join(
    transactionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const updated = normalise(
    await tx.execute(sql`
      UPDATE transactions
         SET recurring_series_id = ${seriesId}::uuid
       WHERE id IN (${ids})
         AND (recurring_series_id IS NULL OR recurring_series_id <> ${seriesId}::uuid)
      RETURNING id
    `),
  );

  return updated.length;
}

/* ------------------------------------------------------- actions on a series */

/**
 * §11.3 — "Actions per series: confirm, dismiss as noise, pause, mark
 * cancelled, exclude from detection."
 *
 * Each is one column, and the three that record a human judgement are separate
 * from `status` because they answer a different question. `status` is what the
 * subscription is doing; the timestamps are what the detector is permitted to
 * conclude about it.
 */
export type SeriesAction =
  | "confirm"
  | "dismiss"
  | "restore"
  | "pause"
  | "resume"
  | "cancel"
  | "exclude"
  | "include";

const PATCHES: Record<SeriesAction, ReturnType<typeof sql>> = {
  /** Keeps a real series in the calendar through a missed charge that would
   *  otherwise drop its confidence below the display floor. */
  confirm: sql`confirmed_at = now(), dismissed_at = NULL`,
  /** Noise. The row survives as a tombstone: deleting it would have the
   *  detector rediscover the same pattern tomorrow under a new id. */
  dismiss: sql`dismissed_at = now(), confirmed_at = NULL`,
  restore: sql`dismissed_at = NULL`,
  pause: sql`status = 'paused'`,
  resume: sql`status = 'active'`,
  /** A record, not a deletion. A cancelled subscription that charges again is
   *  the single most useful thing this feature can tell you. */
  cancel: sql`status = 'cancelled'`,
  /** Stronger than dismiss: the detector stops updating this key at all. */
  exclude: sql`excluded_from_detection = true, dismissed_at = now()`,
  include: sql`excluded_from_detection = false, dismissed_at = NULL`,
};

export async function actOnSeries(
  db: Db,
  input: { id: string; action: SeriesAction },
): Promise<Result<{ id: string; action: SeriesAction }>> {
  const patch = PATCHES[input.action];
  if (!patch) return fail(`Unknown action: ${input.action}`);

  return db.transaction(async (tx: any) => {
    const updated = normalise(
      await tx.execute(sql`
        UPDATE recurring_series SET ${patch} WHERE id = ${input.id}::uuid RETURNING id
      `),
    );

    if (updated.length === 0) return fail("That series no longer exists.");
    return ok({ id: input.id, action: input.action });
  });
}
