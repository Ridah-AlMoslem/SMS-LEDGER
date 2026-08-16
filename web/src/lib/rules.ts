/**
 * What a rule is, in one place (SPEC §9.5, §11.1).
 *
 * `rules.match` is `[{field, operator, value}, ...]`, ANDed, and `rules.actions`
 * is `{set_category, set_merchant, mark_internal_transfer,
 * exclude_from_analytics}`. Both are jsonb, which means the database will store
 * absolutely anything — so the shape is parsed on the way out as well as
 * validated on the way in. A rule that silently stops matching because a field
 * name drifted is a rule that quietly un-categorizes your history.
 *
 * Pure: no database, no drizzle. `db/rules.ts` turns a parsed rule into the one
 * SQL predicate that both the dry-run preview and the apply run against, which
 * is what makes "matches 34 transactions" a promise rather than an estimate.
 *
 * §9.5's semantics that this module encodes:
 *
 *   - First matching rule wins, ascending priority. Not "apply all matching
 *     rules", which makes outcomes depend on invisible interactions.
 *   - A rule never overrides a locked field. An explicit manual edit beats an
 *     automatic rule, always (§9.4).
 */

/** The columns a rule may test. Deliberately short: every one of these is a
 *  value a person can read off the transaction in front of them, which is what
 *  makes "why did this get categorized" answerable. */
export const MATCH_FIELDS = [
  "merchant_raw",
  "biller",
  "description",
  "type",
  "direction",
  "account_id",
] as const;

export type MatchField = (typeof MATCH_FIELDS)[number];

/** Text comparisons are case-insensitive. Bank strings arrive in whatever case
 *  the sender felt like — the same merchant appears as `STARBUCKS`, `Starbucks`
 *  and `starbucks` across three messages — and a rule that distinguishes them
 *  is a rule you have to write three times. */
export const OPERATORS = ["equals", "contains", "starts_with"] as const;
export type Operator = (typeof OPERATORS)[number];

export type Condition = { field: MatchField; operator: Operator; value: string };

export type RuleActions = {
  /** Category id, or null to clear. */
  set_category?: string | null;
  /** Merchant id — normalization (§11.1), not the raw string. */
  set_merchant?: string | null;
  mark_internal_transfer?: boolean;
  exclude_from_analytics?: boolean;
};

export type ParsedRule = {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match: Condition[];
  actions: RuleActions;
};

/** The fields a rule's actions write, as transaction column names. This is what
 *  is checked against `locked_fields` — the list has to be column names, not
 *  action names, or the lock and the rule are talking about different things. */
export function targetFields(actions: RuleActions): string[] {
  const fields: string[] = [];
  if ("set_category" in actions) fields.push("category_id");
  if ("set_merchant" in actions) fields.push("merchant_id");
  if ("mark_internal_transfer" in actions) fields.push("is_internal_transfer");
  if ("exclude_from_analytics" in actions) fields.push("excluded_from_analytics");
  return fields;
}

/* ------------------------------------------------------------- parsing in */

function isCondition(v: unknown): v is Condition {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.value === "string" &&
    (MATCH_FIELDS as readonly string[]).includes(c.field as string) &&
    (OPERATORS as readonly string[]).includes(c.operator as string)
  );
}

/**
 * A stored rule, or null if it is not one.
 *
 * Null rather than an exception, and the caller skips it: one malformed row
 * must not take out the rules screen, and a rule that cannot be understood must
 * not be allowed to match anything at all — an unparseable condition silently
 * treated as "matches everything" would re-categorize the entire ledger.
 */
export function parseRule(row: {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match: unknown;
  actions: unknown;
}): ParsedRule | null {
  if (!Array.isArray(row.match) || row.match.length === 0) return null;
  if (!row.match.every(isCondition)) return null;
  if (!row.actions || typeof row.actions !== "object" || Array.isArray(row.actions)) return null;

  const actions = row.actions as RuleActions;
  if (targetFields(actions).length === 0) return null;

  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled,
    match: row.match as Condition[],
    actions,
  };
}

/* ------------------------------------------------------------ constructing */

export type RuleDraft = { name: string; match: Condition[]; actions: RuleActions; priority?: number };

/**
 * The rule the category picker offers: "always categorize <merchant> as
 * <category>".
 *
 * Keys on `merchant_raw` when there is one and on `biller` otherwise, because
 * a SADAD payment (§7.5) has no merchant and its biller is a *better*
 * categorization key than any merchant string — repeat billers map cleanly to
 * categories, where merchant strings drift with every terminal.
 *
 * Returns null when the transaction offers neither. A rule with no condition
 * matches the entire ledger, and offering that from a one-tap control is how
 * you re-categorize four years of history by accident.
 */
export function ruleFromTransaction(
  tx: { merchantRaw: string | null; biller: string | null },
  categoryId: string,
  categoryName: string,
): RuleDraft | null {
  const field: MatchField = tx.merchantRaw ? "merchant_raw" : tx.biller ? "biller" : "merchant_raw";
  const value = tx.merchantRaw ?? tx.biller;
  if (!value) return null;

  return {
    name: `${value} → ${categoryName}`,
    match: [{ field, operator: "equals", value }],
    actions: { set_category: categoryId },
  };
}

const FIELD_LABELS: Record<MatchField, string> = {
  merchant_raw: "merchant",
  biller: "biller",
  description: "description",
  type: "type",
  direction: "direction",
  account_id: "account",
};

const OPERATOR_LABELS: Record<Operator, string> = {
  equals: "is",
  contains: "contains",
  starts_with: "starts with",
};

/** "merchant is STARBUCKS RIYADH" — the sentence shown above the dry-run, so
 *  what is about to be applied is legible without reading jsonb. */
export function describeCondition(c: Condition): string {
  return `${FIELD_LABELS[c.field]} ${OPERATOR_LABELS[c.operator]} ${c.value}`;
}

export function describeMatch(match: Condition[]): string {
  return match.map(describeCondition).join(" and ");
}

export function validateDraft(draft: RuleDraft): string | null {
  if (!draft.name.trim()) return "A rule needs a name.";
  if (draft.match.length === 0) return "A rule with no conditions would match every transaction.";
  if (draft.match.some((c) => !c.value.trim())) return "A condition needs a value to match on.";
  if (targetFields(draft.actions).length === 0) return "A rule that does nothing is not a rule.";
  return null;
}
