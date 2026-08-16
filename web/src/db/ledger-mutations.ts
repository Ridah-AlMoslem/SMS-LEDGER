/**
 * Every write the ledger screen can make, as database transactions.
 *
 * Kept out of the server actions so `npm run test:ledger` can run them against
 * real Postgres, for the same reason `db/account-edit.ts` is: the guarantees
 * here are not ones a unit test can reach.
 *
 *   §9.4 — a field you edit by hand is added to `locked_fields`, and replay
 *   leaves it alone forever after. If this is wrong, an improved parser
 *   silently reverts every correction you have ever made, and the only symptom
 *   is that your categories are subtly wrong again some morning. That is the
 *   failure that ends trust in the whole app, so the lock is applied here — in
 *   the same statement as the edit — rather than by any caller remembering to.
 *
 *   §9.4.3 — deleting a transaction marks its raw message ignored, or the next
 *   parser tick books it again.
 *
 *   §3.3 — editing an amount moves a balance that is derived from it. The
 *   trigger in migration 0008 recomputes the account and re-derives its open
 *   reconciliation alerts; an INSERT is the one path that trigger deliberately
 *   does not cover, so `createManual` calls the same function itself.
 *
 * Takes the db as an argument and imports nothing from `next/*`, so the tested
 * path and the shipped path are the same function.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { parseAmount } from "../lib/account-edit.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- the transaction handle
 * is deliberately structural: the app runs on postgres-js and the test runs the
 * same functions on PGlite, and drizzle gives those two different (very large)
 * database types. Naming either would mean the tested path and the shipped path
 * are not the same code. Every query below is still typed by the schema. */

/** Structurally what `drizzle()` returns, for either driver. */
export type Db = { transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

/* --------------------------------------------------------------- locking */

/**
 * Patch field → the column name that goes into `locked_fields`.
 *
 * Column names, not camelCase property names. Replay's guard is SQL
 * (`locked_fields ? 'category_id'`) and the parser writes columns, so a lock
 * list in the app's naming would be a list the thing it protects against never
 * reads. This map is the only place the two vocabularies meet.
 */
export const LOCKABLE = {
  accountId: "account_id",
  postedAt: "posted_at",
  amount: "amount",
  direction: "direction",
  type: "type",
  categoryId: "category_id",
  merchantRaw: "merchant_raw",
  biller: "biller",
  description: "description",
  notes: "notes",
  isInternalTransfer: "is_internal_transfer",
  excludedFromAnalytics: "excluded_from_analytics",
  cycleOverride: "cycle_override",
  state: "state",
} as const;

export type PatchField = keyof typeof LOCKABLE;

export const FIELD_LABELS: Record<string, string> = {
  account_id: "Account",
  posted_at: "Date",
  amount: "Amount",
  direction: "Direction",
  type: "Type",
  category_id: "Category",
  merchant_raw: "Merchant",
  biller: "Biller",
  description: "Description",
  notes: "Notes",
  is_internal_transfer: "Internal transfer",
  excluded_from_analytics: "Excluded from analytics",
  cycle_override: "Cycle",
  state: "State",
};

export function fieldLabel(column: string): string {
  return FIELD_LABELS[column] ?? column;
}

/** Union, order-preserving. `locked_fields` is read by eye in the sheet and by
 *  `?` in SQL; neither cares about order, and a stable one makes a diff of the
 *  column legible when something goes wrong. */
function addLocks(existing: unknown, columns: string[]): string[] {
  const current = Array.isArray(existing) ? (existing as string[]) : [];
  const out = [...current];
  for (const c of columns) if (!out.includes(c)) out.push(c);
  return out;
}

/* ------------------------------------------------------------- the edit */

export type TransactionPatch = Partial<{
  accountId: string;
  /** ISO-8601, or anything `new Date()` accepts. */
  postedAt: string | Date;
  amount: string;
  direction: "debit" | "credit";
  type: string;
  /** null clears it — "not this category" is a decision worth locking too. */
  categoryId: string | null;
  merchantRaw: string | null;
  biller: string | null;
  description: string | null;
  notes: string | null;
  isInternalTransfer: boolean;
  excludedFromAnalytics: boolean;
  state: string;
}>;

export type Change = { from: string | null; to: string | null };

export type EditOutcome = {
  id: string;
  changed: Record<string, Change>;
  /** The full lock list after the edit, for the sheet's lock markers. */
  locked: string[];
};

const COLUMN_OF: Record<string, string> = LOCKABLE;

function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** NUMERIC(14,2) as the database will hold it, so `"120"` and `"120.00"` stop
 *  registering as a change to an amount nobody touched. */
function storedAmount(input: string): string | null {
  const halalas = parseAmount(input);
  return halalas === null ? null : (halalas / 100).toFixed(2);
}

/**
 * Apply a hand edit to one transaction, locking every field it moved.
 *
 * Only the fields that actually changed are written and locked. Locking a field
 * because the form submitted it unchanged would be almost as bad as not locking
 * one that moved: replay is the mechanism that lets an improved parser fix
 * history (§3.1), and a transaction whose every column is locked because it was
 * once opened in a sheet can never be improved again.
 */
export async function editTransaction(
  db: Db,
  input: { id: string; patch: TransactionPatch; at?: Date },
): Promise<Result<EditOutcome>> {
  const patch = input.patch;

  if (patch.amount !== undefined) {
    const normalised = storedAmount(patch.amount);
    if (normalised === null) {
      return fail("An amount needs to be a number with at most two decimals.");
    }
    if (parseAmount(normalised)! <= 0) {
      // Direction carries the sign in this schema; a negative amount would
      // book a credit as a debit and move the balance the wrong way twice.
      return fail("An amount is always positive — use the direction to say which way it went.");
    }
    patch.amount = normalised;
  }

  if (patch.postedAt !== undefined) {
    const when = patch.postedAt instanceof Date ? patch.postedAt : new Date(patch.postedAt);
    if (Number.isNaN(when.getTime())) return fail("That date could not be read.");
    patch.postedAt = when;
  }

  return db.transaction(async (tx: any): Promise<Result<EditOutcome>> => {
    const [before] = (await tx
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.id))
      .for("update")) as any[];

    if (!before) return fail("That transaction no longer exists.");

    // Editing the amount of a split transaction breaks Σ splits = amount, and
    // the deferred constraint would refuse the commit with a message about a
    // trigger. Refusing here says the useful thing instead: the split has to be
    // re-cut, because only the person editing knows which leg absorbs the
    // difference.
    if (patch.amount !== undefined && patch.amount !== before.amount) {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.transactionSplits)
        .where(eq(schema.transactionSplits.transactionId, input.id))) as { n: number }[];

      if (Number(n) > 0) {
        return fail(
          "This transaction is split across categories. Change the split first — the " +
            "amounts have to add up to the whole, and only you know which one absorbs " +
            "the difference.",
        );
      }
    }

    const changed: Record<string, Change> = {};
    const write: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(patch) as [PatchField, unknown][]) {
      const column = COLUMN_OF[field];
      if (!column) continue;

      const current = before[field as keyof typeof before];

      const same =
        field === "postedAt"
          ? new Date(current as string | Date).getTime() === (value as Date).getTime()
          : field === "amount"
            ? parseAmount(String(current)) === parseAmount(String(value))
            : (current ?? null) === (value ?? null);

      if (same) continue;

      changed[column] = { from: show(current), to: show(value) };
      write[field] = value;
    }

    if (Object.keys(changed).length === 0) {
      return ok({
        id: input.id,
        changed,
        locked: Array.isArray(before.lockedFields) ? before.lockedFields : [],
      });
    }

    const locked = addLocks(before.lockedFields, Object.keys(changed));

    await tx
      .update(schema.transactions)
      .set({ ...write, lockedFields: locked, updatedAt: input.at ?? new Date() })
      .where(eq(schema.transactions.id, input.id));

    return ok({ id: input.id, changed, locked });
  });
}

/**
 * Take a field back out of `locked_fields`.
 *
 * The value is left exactly as it is: unlocking says "the parser may have
 * another go at this", not "undo what I typed". Reverting on unlock would make
 * the lock marker a destructive control, and it is tapped by curiosity.
 */
export async function unlockField(
  db: Db,
  input: { id: string; column: string },
): Promise<Result<{ locked: string[] }>> {
  return db.transaction(async (tx: any) => {
    const [row] = (await tx
      .select({ lockedFields: schema.transactions.lockedFields })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.id))
      .for("update")) as { lockedFields: unknown }[];

    if (!row) return fail("That transaction no longer exists.");

    const current = Array.isArray(row.lockedFields) ? (row.lockedFields as string[]) : [];
    const locked = current.filter((f) => f !== input.column);

    await tx
      .update(schema.transactions)
      .set({ lockedFields: locked })
      .where(eq(schema.transactions.id, input.id));

    return ok({ locked });
  });
}

/* -------------------------------------------------------------- splitting */

export type SplitInput = { categoryId: string; amount: string };

/**
 * Replace a transaction's splits (§9.6).
 *
 * Σ splits must equal the amount exactly. Checked here in halalas so the error
 * can say what the remainder is, and checked again by the deferred constraint
 * trigger from migration 0003 at commit — which is the one that actually
 * guarantees it, because it also holds for a write that never came through this
 * function.
 *
 * An empty list removes the split, returning the transaction to being
 * categorized on the row. The row's own `category_id` is cleared when splits
 * exist: `v_categorized_amounts` reads the row category only when there are no
 * splits, so a leftover value there is a second opinion nothing consults and
 * everything displays.
 */
export async function saveSplits(
  db: Db,
  input: { transactionId: string; splits: SplitInput[] },
): Promise<Result<{ splits: number; remainder: string }>> {
  for (const s of input.splits) {
    if (!s.categoryId) return fail("Every split needs a category.");
    const halalas = parseAmount(s.amount);
    if (halalas === null) return fail("A split amount needs at most two decimals.");
    if (halalas <= 0) return fail("A split of zero is not a split — remove the row instead.");
  }

  return db.transaction(async (tx: any) => {
    const [before] = (await tx
      .select({
        amount: schema.transactions.amount,
        lockedFields: schema.transactions.lockedFields,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .for("update")) as { amount: string; lockedFields: unknown }[];

    if (!before) return fail("That transaction no longer exists.");

    const whole = parseAmount(before.amount)!;
    const total = input.splits.reduce((sum, s) => sum + parseAmount(s.amount)!, 0);

    if (input.splits.length > 0 && total !== whole) {
      const remainder = (whole - total) / 100;
      return fail(
        `The splits come to ${(total / 100).toFixed(2)} of ${(whole / 100).toFixed(2)} — ` +
          `${remainder > 0 ? "" : "−"}${Math.abs(remainder).toFixed(2)} still to allocate.`,
      );
    }

    await tx
      .delete(schema.transactionSplits)
      .where(eq(schema.transactionSplits.transactionId, input.transactionId));

    if (input.splits.length > 0) {
      await tx.insert(schema.transactionSplits).values(
        input.splits.map((s) => ({
          transactionId: input.transactionId,
          categoryId: s.categoryId,
          amount: (parseAmount(s.amount)! / 100).toFixed(2),
        })),
      );
    }

    // Cutting a split by hand IS a categorization decision, so it locks the
    // category the same way typing one would (§9.4). Replay may still re-derive
    // everything else about the transaction.
    await tx
      .update(schema.transactions)
      .set({
        categoryId: null,
        lockedFields: addLocks(before.lockedFields, ["category_id"]),
        updatedAt: new Date(),
      })
      .where(eq(schema.transactions.id, input.transactionId));

    return ok({ splits: input.splits.length, remainder: "0.00" });
  });
}

/* ------------------------------------------------------------ cycle move */

/**
 * Reassign a transaction to a neighbouring cycle (§5.6).
 *
 * The manual escape hatch. `cycle_override` is read by every cycle aggregate
 * through `effective_cycle()`, and by no weekly one — a week is a literal date
 * range and always ignores it. That asymmetry is the whole point: an early
 * salary funds the cycle it opens, but it still landed in the week it landed
 * in, and a week that moved would stop being a date range.
 *
 * Only a neighbour is allowed. Anything further is not a payday-drift
 * correction, it is a transaction filed under a month it has nothing to do
 * with, and there is no way to tell those apart afterwards.
 */
export async function setCycleOverride(
  db: Db,
  input: { id: string; cycleStart: string | null; neighbours: string[] },
): Promise<Result<EditOutcome>> {
  if (input.cycleStart !== null && !input.neighbours.includes(input.cycleStart)) {
    return fail("A transaction can only move to the cycle either side of the one it posted in.");
  }

  return db.transaction(async (tx: any) => {
    const [before] = (await tx
      .select({
        cycleOverride: schema.transactions.cycleOverride,
        lockedFields: schema.transactions.lockedFields,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.id))
      .for("update")) as { cycleOverride: string | null; lockedFields: unknown }[];

    if (!before) return fail("That transaction no longer exists.");
    if ((before.cycleOverride ?? null) === input.cycleStart) {
      return ok({
        id: input.id,
        changed: {},
        locked: Array.isArray(before.lockedFields) ? before.lockedFields : [],
      });
    }

    const locked = addLocks(before.lockedFields, ["cycle_override"]);

    await tx
      .update(schema.transactions)
      .set({ cycleOverride: input.cycleStart, lockedFields: locked, updatedAt: new Date() })
      .where(eq(schema.transactions.id, input.id));

    return ok({
      id: input.id,
      changed: { cycle_override: { from: before.cycleOverride, to: input.cycleStart } },
      locked,
    });
  });
}

/* ---------------------------------------------------------------- delete */

export type DeleteOutcome = {
  id: string;
  /** The message that produced it, now ignored so replay cannot bring it back. */
  rawMessageId: string | null;
  /** Other legs from the same message, which are now orphaned from a message
   *  that will never be reparsed. The sheet warns before this happens. */
  siblingLegs: number;
};

/**
 * Delete a transaction, and stop the pipeline recreating it (§9.4.3, §13).
 *
 * The raw message is marked `ignored` with `ignored_reason='user'` rather than
 * deleted — §3.1 makes raw_messages append-only, and the reason is what tells a
 * later classifier change that a human decided this, not a filter. Without this
 * step the next parser tick re-derives the transaction from the message still
 * sitting there in `parsed` state, and the delete undoes itself with nothing to
 * explain why.
 *
 * A manual entry has no message and simply goes.
 */
export async function deleteTransaction(
  db: Db,
  input: { id: string },
): Promise<Result<DeleteOutcome>> {
  return db.transaction(async (tx: any) => {
    const [row] = (await tx
      .select({
        id: schema.transactions.id,
        rawMessageId: schema.transactions.rawMessageId,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.id))
      .for("update")) as { id: string; rawMessageId: string | null }[];

    if (!row) return fail("That transaction has already been deleted.");

    let siblingLegs = 0;
    if (row.rawMessageId) {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.rawMessageId, row.rawMessageId),
            sql`${schema.transactions.id} <> ${input.id}::uuid`,
          ),
        )) as { n: number }[];
      siblingLegs = Number(n);
    }

    await tx.delete(schema.transactions).where(eq(schema.transactions.id, input.id));

    if (row.rawMessageId) {
      await tx
        .update(schema.rawMessages)
        .set({
          status: "ignored",
          ignoredReason: "user",
          lastError: null,
          processedAt: sql`now()`,
        })
        .where(eq(schema.rawMessages.id, row.rawMessageId));
    }

    return ok({ id: input.id, rawMessageId: row.rawMessageId, siblingLegs });
  });
}

/* ------------------------------------------------------------------ bulk */

export type BulkPatch = {
  categoryId?: string | null;
  excludedFromAnalytics?: boolean;
  isInternalTransfer?: boolean;
};

/**
 * The bulk-select actions: categorize N, exclude N, mark N internal.
 *
 * Every row touched is locked on the fields the bulk action set, exactly as a
 * single edit would be. A bulk action is not a lesser kind of edit — it is the
 * one most likely to be undone en masse by a replay, because it is how you fix
 * a whole misparsed merchant at once.
 */
export async function bulkEdit(
  db: Db,
  input: { ids: string[]; patch: BulkPatch },
): Promise<Result<{ updated: number; locked: string[] }>> {
  if (input.ids.length === 0) return fail("Nothing was selected.");

  const columns = Object.keys(input.patch)
    .map((f) => COLUMN_OF[f])
    .filter(Boolean);

  if (columns.length === 0) return fail("That action would not change anything.");

  return db.transaction(async (tx: any) => {
    const rows = (await tx
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, input.ids))
      .for("update")) as { id: string }[];

    if (rows.length === 0) return fail("Those transactions no longer exist.");

    // One statement, with the lock list unioned in SQL rather than read back
    // and rewritten row by row. Selecting a hundred rows and issuing a hundred
    // updates over a connection a region away is most of a second of a frozen
    // screen, and the union is the only per-row part.
    const updated = (await tx
      .update(schema.transactions)
      .set({
        ...input.patch,
        lockedFields: sql`(
          SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
            FROM jsonb_array_elements_text(
              COALESCE(${schema.transactions.lockedFields}, '[]'::jsonb)
              || ${JSON.stringify(columns)}::jsonb
            ) e
        )`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          schema.transactions.id,
          rows.map((r) => r.id),
        ),
      )
      .returning({ id: schema.transactions.id })) as { id: string }[];

    return ok({ updated: updated.length, locked: columns });
  });
}

/* ------------------------------------------------------------ manual entry */

export type ManualInput = {
  accountId: string;
  postedAt: string | Date;
  amount: string;
  direction: "debit" | "credit";
  type: string;
  categoryId?: string | null;
  merchantRaw?: string | null;
  description?: string | null;
  notes?: string | null;
  excludedFromAnalytics?: boolean;
};

/**
 * A cash transaction, typed in (§9.4, §11.1).
 *
 * `origin='manual'` is the whole contract: replay never touches these, because
 * there is no message to re-derive them from and a replay that "corrected" one
 * would simply delete information. `is_reviewed` is true because a person just
 * entered it — there is nothing left to review.
 *
 * The balance is recomputed here rather than by the trigger in migration 0008,
 * which deliberately ignores INSERT so the parser's batch inserts do not re-sum
 * an account fifty times per tick. This is the path that has to make up for it.
 */
export async function createManual(
  db: Db,
  input: ManualInput,
): Promise<Result<{ id: string }>> {
  const amount = storedAmount(input.amount);
  if (amount === null) return fail("An amount needs to be a number with at most two decimals.");
  if (parseAmount(amount)! <= 0) return fail("An amount has to be more than zero.");

  const when = input.postedAt instanceof Date ? input.postedAt : new Date(input.postedAt);
  if (Number.isNaN(when.getTime())) return fail("That date could not be read.");

  if (!input.accountId) return fail("A transaction has to belong to an account.");

  return db.transaction(async (tx: any) => {
    const [row] = (await tx
      .insert(schema.transactions)
      .values({
        accountId: input.accountId,
        postedAt: when,
        amount,
        direction: input.direction,
        type: input.type as (typeof schema.transactions.$inferInsert)["type"],
        state: "posted",
        categoryId: input.categoryId ?? null,
        merchantRaw: input.merchantRaw ?? null,
        description: input.description ?? null,
        notes: input.notes ?? null,
        excludedFromAnalytics: input.excludedFromAnalytics ?? false,
        origin: "manual",
        isReviewed: true,
      })
      .returning({ id: schema.transactions.id })) as { id: string }[];

    await tx.execute(sql`SELECT refresh_reconciliation(${input.accountId}::uuid)`);

    return ok({ id: row.id });
  });
}

/**
 * Turn a parsed transaction into a manual one.
 *
 * The escape hatch for a row the parser keeps getting wrong: after this, replay
 * skips it entirely rather than negotiating field by field with its lock list.
 * The raw message is left `parsed` and still linked — it is still where this
 * came from, and hiding that would make the row unexplainable.
 */
export async function convertToManual(db: Db, input: { id: string }): Promise<Result<{ id: string }>> {
  return db.transaction(async (tx: any) => {
    const [row] = (await tx
      .update(schema.transactions)
      .set({ origin: "manual", isReviewed: true, updatedAt: new Date() })
      .where(and(eq(schema.transactions.id, input.id), isNull(schema.transactions.supersededBy)))
      .returning({ id: schema.transactions.id })) as { id: string }[];

    if (!row) return fail("That transaction no longer exists.");
    return ok({ id: row.id });
  });
}
