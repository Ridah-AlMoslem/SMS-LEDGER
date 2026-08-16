/**
 * Rules: create, dry-run, apply (SPEC §9.5, §11.1).
 *
 * §11.1 asks for "apply to N matching historical transactions". The number in
 * that sentence is a promise, so `matchPredicate` is built once and used by both
 * the preview and the apply — the dry-run is literally the same WHERE clause
 * with a SELECT in front of it. A preview computed by a second, similar query is
 * a preview that is right until the day the two drift, which is the day you
 * confirm a mass re-categorization of four years of history on the strength of a
 * number that was never true.
 *
 * The preview counts what would CHANGE, not what matches. Those differ, always:
 * transactions already in the target category are matched and unaffected, and
 * §9.5 forbids a rule from overriding a hand-locked field, so some matches are
 * deliberately left alone. Reporting the match count as the apply count would
 * report a rule as having done more than it did.
 *
 * Structural db handle and no `next/*` imports, so `npm run test:ledger` runs
 * these functions rather than a copy of them.
 */

import { type SQL, and, eq, inArray, sql } from "drizzle-orm";

import { type Condition, type ParsedRule, type RuleDraft, targetFields } from "../lib/rules.ts";
import type { Db, Result } from "./ledger-mutations.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- see ledger-mutations.ts:
 * the transaction handle is structural so the tested path is the shipped one. */

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

/** Column per match field. A closed map, not string interpolation: `field`
 *  arrives from a jsonb column, and a jsonb column is a place a string can come
 *  from that nobody validated. */
const COLUMNS = {
  merchant_raw: sql`t.merchant_raw`,
  biller: sql`t.biller`,
  description: sql`t.description`,
  type: sql`t.type::text`,
  direction: sql`t.direction::text`,
  account_id: sql`t.account_id::text`,
} as const;

function conditionSql(c: Condition): SQL {
  const column = COLUMNS[c.field];

  switch (c.operator) {
    case "equals":
      // Case-insensitive, because the same merchant arrives as STARBUCKS,
      // Starbucks and starbucks across three messages from one bank.
      return sql`lower(${column}) = lower(${c.value})`;
    case "contains":
      return sql`${column} ILIKE ${`%${escapeLike(c.value)}%`} ESCAPE '\\'`;
    case "starts_with":
      return sql`${column} ILIKE ${`${escapeLike(c.value)}%`} ESCAPE '\\'`;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A rule's conditions as one predicate over `transactions t`.
 *
 * ANDed (§4). Superseded legs are excluded here rather than by every caller:
 * an echoed leg is a duplicate description of one movement (§8.2.1), and
 * categorizing it does nothing except make the preview count larger than the
 * number of transactions a person can see.
 */
export function matchPredicate(match: Condition[]): SQL {
  return sql.join(
    [sql`t.superseded_by IS NULL`, ...match.map(conditionSql)],
    sql` AND `,
  );
}

/**
 * The rows a rule would actually change.
 *
 * Two exclusions, both §9.5:
 *
 *   - A locked field beats a rule. `locked_fields ? 'category_id'` is the same
 *     test replay uses, so a field you protected from an improved parser is
 *     equally protected from a rule you wrote later.
 *   - A row already holding the value the rule would set is not a change. It is
 *     counted separately and shown, because "34 match, 31 would change" is a
 *     more honest sentence than either number alone.
 */
function changeFilter(actions: ParsedRule["actions"]): SQL {
  const clauses: SQL[] = [];

  if ("set_category" in actions) {
    clauses.push(
      actions.set_category === null
        ? sql`t.category_id IS NOT NULL`
        : sql`t.category_id IS DISTINCT FROM ${actions.set_category}::uuid`,
    );
  }
  if ("set_merchant" in actions) {
    clauses.push(
      actions.set_merchant === null
        ? sql`t.merchant_id IS NOT NULL`
        : sql`t.merchant_id IS DISTINCT FROM ${actions.set_merchant}::uuid`,
    );
  }
  if ("mark_internal_transfer" in actions) {
    clauses.push(sql`t.is_internal_transfer IS DISTINCT FROM ${!!actions.mark_internal_transfer}`);
  }
  if ("exclude_from_analytics" in actions) {
    clauses.push(sql`t.excluded_from_analytics IS DISTINCT FROM ${!!actions.exclude_from_analytics}`);
  }

  // Any one of the actions having something to do is enough.
  return clauses.length === 0 ? sql`false` : sql.join(clauses, sql` OR `);
}

/**
 * `NOT (locked_fields ? 'category_id' OR …)` — the fields this rule writes,
 * none of which it may write over a manual edit (§9.4, §9.5).
 *
 * One `?` per field rather than `?|` against an array: `?|` needs `text[]` on
 * the right, and every way of getting a JS array into that position depends on
 * how a particular driver encodes arrays. This form binds plain strings, which
 * every driver agrees about — and this predicate deciding differently under
 * PGlite than under postgres-js would mean the test proves the guard on a query
 * the app does not run.
 */
function notLocked(actions: ParsedRule["actions"]): SQL {
  const fields = targetFields(actions);
  if (fields.length === 0) return sql`true`;

  const tests = fields.map((f) => sql`COALESCE(t.locked_fields, '[]'::jsonb) ? ${f}`);
  return sql`NOT (${sql.join(tests, sql` OR `)})`;
}

export type RulePreviewRow = {
  id: string;
  postedAt: string;
  amount: string;
  direction: string;
  label: string;
  accountName: string;
  categoryName: string | null;
  locked: boolean;
  wouldChange: boolean;
};

export type RulePreview = {
  /** Everything the conditions match, whatever happens to it. */
  matched: number;
  /** What applying would actually write. The number on the confirm button. */
  wouldChange: number;
  /** Matched but protected by a hand edit (§9.4). */
  locked: number;
  /** Matched and already correct. */
  unchanged: number;
  rows: RulePreviewRow[];
};

const PREVIEW_ROWS = 200;

/**
 * The dry run (§11.1: "never apply silently").
 *
 * Returns the list as well as the counts. A count on its own is not reviewable
 * — the whole risk of a rule keyed on a merchant string is that the string is
 * more general than you thought, and the only way to see that is to read the
 * transactions it caught.
 */
export async function previewRule(
  db: Db & { transaction: any },
  input: { match: Condition[]; actions: ParsedRule["actions"] },
): Promise<Result<RulePreview>> {
  if (input.match.length === 0) {
    return fail("A rule with no conditions would match every transaction you have.");
  }

  const where = matchPredicate(input.match);
  const changes = changeFilter(input.actions);
  const unlocked = notLocked(input.actions);

  return db.transaction(async (tx: any) => {
    const rows = (await tx.execute(sql`
      SELECT t.id,
             to_char(t.posted_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS posted_at,
             t.amount, t.direction::text AS direction,
             COALESCE(t.merchant_raw, t.biller, t.description, t.type::text) AS label,
             a.name AS account_name,
             c.name AS category_name,
             NOT (${unlocked})                     AS locked,
             ((${changes}) AND (${unlocked}))      AS would_change
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${where}
       ORDER BY t.posted_at DESC
       LIMIT ${PREVIEW_ROWS}
    `)) as any;

    const list: RulePreviewRow[] = normalise(rows).map((r: any) => ({
      id: String(r.id),
      postedAt: String(r.posted_at),
      amount: String(r.amount),
      direction: String(r.direction),
      label: String(r.label ?? ""),
      accountName: String(r.account_name),
      categoryName: (r.category_name as string | null) ?? null,
      locked: Boolean(r.locked),
      wouldChange: Boolean(r.would_change),
    }));

    // Counted over the whole history, not over the capped list — the list is
    // what you read, the counts are what you are agreeing to.
    const totals = (await tx.execute(sql`
      SELECT count(*)::int                                        AS matched,
             count(*) FILTER (WHERE (${changes}) AND (${unlocked}))::int AS would_change,
             count(*) FILTER (WHERE NOT (${unlocked}))::int        AS locked
        FROM transactions t
       WHERE ${where}
    `)) as any;

    const t0 = normalise(totals)[0] ?? {};
    const matched = Number(t0.matched ?? 0);
    const wouldChange = Number(t0.would_change ?? 0);
    const locked = Number(t0.locked ?? 0);

    return ok({
      matched,
      wouldChange,
      locked,
      unchanged: matched - wouldChange - locked,
      rows: list,
    });
  });
}

/** postgres-js returns rows directly; PGlite returns `{rows}`. One shape out. */
function normalise(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/**
 * Store a rule. Creating it does not apply it (§11.1) — that is a second,
 * explicit step, and the preview sits between them.
 *
 * `priority` defaults to 100 and rules are evaluated in ascending order, first
 * match wins (§9.5). A rule created from a specific transaction gets a lower
 * number than the default so that a hand-made "this merchant → this category"
 * beats a broad rule written earlier, which is the order a person expects and
 * the opposite of what insertion order would give.
 */
export async function createRule(
  db: Db,
  draft: RuleDraft,
): Promise<Result<{ id: string }>> {
  if (draft.match.length === 0) {
    return fail("A rule with no conditions would match every transaction you have.");
  }
  if (targetFields(draft.actions).length === 0) {
    return fail("A rule that does nothing is not a rule.");
  }

  return db.transaction(async (tx: any) => {
    const [row] = (await tx
      .insert(schema.rules)
      .values({
        name: draft.name,
        priority: draft.priority ?? 50,
        enabled: true,
        match: draft.match,
        actions: draft.actions,
      })
      .returning({ id: schema.rules.id })) as { id: string }[];

    return ok({ id: row.id });
  });
}

export type ApplyOutcome = { ruleId: string; applied: number; ids: string[] };

/**
 * Apply a stored rule to history.
 *
 * The `matched_rule_id` written on every row it touches is what makes §9.5's
 * "categorized by rule: Starbucks → Coffee" possible — behaviour that cannot be
 * explained after the fact is behaviour nobody can debug at twenty rules.
 *
 * Note what this does NOT do: it does not add anything to `locked_fields`. A
 * rule is an automatic decision, and locking its result would make an improved
 * parser unable to correct it — the lock means "a person decided this", and a
 * rule is not a person.
 */
export async function applyRule(db: Db, input: { ruleId: string }): Promise<Result<ApplyOutcome>> {
  return db.transaction(async (tx: any) => {
    const [rule] = (await tx
      .select()
      .from(schema.rules)
      .where(eq(schema.rules.id, input.ruleId))) as any[];

    if (!rule) return fail("That rule no longer exists.");

    const parsed = {
      match: rule.match as Condition[],
      actions: rule.actions as ParsedRule["actions"],
    };

    if (!Array.isArray(parsed.match) || parsed.match.length === 0) {
      return fail("That rule has no conditions, so it would match everything.");
    }

    const where = matchPredicate(parsed.match);
    const changes = changeFilter(parsed.actions);
    const unlocked = notLocked(parsed.actions);

    // The ids first, under the same predicate the preview counted, so what is
    // reported as applied is what was applied.
    const found = (await tx.execute(sql`
      SELECT t.id FROM transactions t
       WHERE ${where} AND (${changes}) AND (${unlocked})
       FOR UPDATE
    `)) as any;

    const ids = normalise(found).map((r: any) => String(r.id));
    if (ids.length === 0) return ok({ ruleId: input.ruleId, applied: 0, ids: [] });

    const patch: Record<string, unknown> = { matchedRuleId: input.ruleId, updatedAt: new Date() };
    const actions = parsed.actions;
    if ("set_category" in actions) patch.categoryId = actions.set_category ?? null;
    if ("set_merchant" in actions) patch.merchantId = actions.set_merchant ?? null;
    if ("mark_internal_transfer" in actions) {
      patch.isInternalTransfer = !!actions.mark_internal_transfer;
    }
    if ("exclude_from_analytics" in actions) {
      patch.excludedFromAnalytics = !!actions.exclude_from_analytics;
    }

    await tx
      .update(schema.transactions)
      .set(patch)
      .where(inArray(schema.transactions.id, ids));

    return ok({ ruleId: input.ruleId, applied: ids.length, ids });
  });
}

/** Rules as the settings screen and the sheet's "categorized by rule" note read
 *  them. Managing and reordering is Settings' job (§11.1); this is the read. */
export async function listRules(db: Db & { transaction: any }) {
  return db.transaction(async (tx: any) => {
    const rows = (await tx
      .select()
      .from(schema.rules)
      .where(and(eq(schema.rules.enabled, true)))
      .orderBy(schema.rules.priority)) as any[];
    return rows;
  });
}
