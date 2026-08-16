/**
 * Replay: re-deriving transactions from the messages they came from, without
 * destroying the corrections made since (SPEC §9.4, §3.1).
 *
 * §3.1 keeps every raw message forever so that an improved parser can re-derive
 * history. That promise is only safe if replay cannot clobber manual work, and
 * §9.4 states the three rules that make it safe:
 *
 *   1. Replay never touches a transaction with `origin='manual'`.
 *   2. Replay never overwrites a field listed in `locked_fields`.
 *   3. A deleted transaction's message is `ignored`, so replay does not
 *      resurrect it.
 *
 * Plus a fourth that makes the other three reviewable: replay is scoped, and
 * always dry-runs first. Without a diff, the first replay over a few thousand
 * transactions is an unreviewable mass mutation of your own financial history.
 *
 * ---
 *
 * What this module is NOT: a parser. The parser is Python and normalizes
 * Arabic, matches templates and resolves accounts; re-implementing any of that
 * here would give two parsers that agree until they don't. Legs arrive already
 * parsed — from the parser service in the app, from a fixture in the test — and
 * this module owns the part §9.4 is actually about: which of those legs is
 * allowed to land, and on which fields.
 *
 * That seam is also where rule 3 lives. A caller handing over a leg for a
 * message someone deleted is not a caller doing something wrong; it is exactly
 * what a re-parse of full history produces. Refusing it here means the guard
 * holds no matter who asks.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db, Result } from "./ledger-mutations.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- structural db handle,
 * as in ledger-mutations.ts: the tested path must be the shipped path. */

/**
 * The columns a re-parse may write, and the column name each is locked under.
 *
 * Only these. A replay that could write `notes` or `excluded_from_analytics`
 * would be a replay that can undo a decision no parser could ever have made,
 * and no lock list would be complete enough to defend against it.
 */
export const REPLAYABLE = {
  postedAt: "posted_at",
  amount: "amount",
  direction: "direction",
  type: "type",
  state: "state",
  merchantRaw: "merchant_raw",
  biller: "biller",
  billerService: "biller_service",
  invoiceNumber: "invoice_number",
  isInternalTransfer: "is_internal_transfer",
  reportedBalance: "reported_balance",
  feeAmount: "fee_amount",
  originalAmount: "original_amount",
  originalCurrency: "original_currency",
  fxRate: "fx_rate",
  country: "country",
  cardLast4: "card_last4",
  parserKind: "parser_kind",
  confidence: "confidence",

  /**
   * The categorization pass of a replay (§9.5).
   *
   * A full replay is two steps — re-parse, then re-run the rules — and the
   * second one writes these. They are listed here rather than left to the rules
   * engine alone because §9.4's guard is a property of the column, not of
   * whichever pass is writing it: the LLM path (§10.5) can also return a
   * category suggestion, and a lock has to hold against both.
   */
  categoryId: "category_id",
  merchantId: "merchant_id",
} as const;

export type ReplayField = keyof typeof REPLAYABLE;
export type ReplayFields = Partial<Record<ReplayField, unknown>>;

/** One leg as the parser would produce it, keyed the way the ledger's
 *  idempotency constraint is: (raw_message_id, account_id, direction). */
export type ReplayLeg = {
  rawMessageId: string;
  accountId: string;
  direction: "debit" | "credit";
  fields: ReplayFields;
};

export type ReplayScope = {
  accountId?: string;
  /** Local dates, inclusive. */
  from?: string;
  to?: string;
};

export type FieldChange = { column: string; from: string | null; to: string | null };

export type ReplayChange = {
  transactionId: string;
  rawMessageId: string;
  /** Fields that would move, locks already removed. */
  changes: FieldChange[];
  /** Fields the parser would have changed and was not allowed to (§9.4.2).
   *  Shown in the dry-run: a replay silently declining to fix something is as
   *  confusing as one silently breaking it. */
  blocked: FieldChange[];
};

export type ReplaySkip = {
  rawMessageId: string;
  reason: "manual" | "deleted" | "out-of-scope" | "no-transaction";
  transactionId?: string;
};

export type ReplayReport = {
  dryRun: boolean;
  /** Transactions that would change, or did. */
  changed: ReplayChange[];
  /** Legs that were refused, with which rule refused them. */
  skipped: ReplaySkip[];
  /** Legs whose fields all already match — the ordinary case, and the number
   *  that should be large. */
  unchanged: number;
};

function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Numeric columns arrive from Postgres as strings and from a parser as
 *  numbers. `"180.00"` and `180` are the same amount, and a replay that
 *  reported it as a change would produce a diff of thousands of rows that all
 *  say nothing moved. */
function same(column: string, current: unknown, next: unknown): boolean {
  if (current === null || current === undefined) return next === null || next === undefined;
  if (next === null || next === undefined) return false;

  if (current instanceof Date || next instanceof Date) {
    return new Date(current as string).getTime() === new Date(next as string).getTime();
  }

  const numeric = ["amount", "reported_balance", "fee_amount", "original_amount", "fx_rate", "confidence"];
  if (numeric.includes(column)) return Number(current) === Number(next);

  return String(current) === String(next);
}

/**
 * Dry-run or apply a replay.
 *
 * Always call it once with `dryRun: true`, show the diff, and only then call it
 * again with the same legs. §9.4.4 makes that two steps on purpose.
 */
export async function replay(
  db: Db,
  input: { legs: ReplayLeg[]; scope?: ReplayScope; dryRun: boolean },
): Promise<Result<ReplayReport>> {
  const legs = input.legs;
  if (legs.length === 0) {
    return { ok: true, value: { dryRun: input.dryRun, changed: [], skipped: [], unchanged: 0 } };
  }

  return db.transaction(async (tx: any): Promise<Result<ReplayReport>> => {
    const messageIds = [...new Set(legs.map((l) => l.rawMessageId))];

    // §9.4.3 — a message whose transaction was deleted is `ignored`, and an
    // ignored message produces nothing. This is the whole of rule 3: the delete
    // path writes the status, and this read enforces it. Note it is a property
    // of the MESSAGE, so it survives the transaction row being gone — there is
    // nothing left to check against otherwise.
    const messages = (await tx
      .select({
        id: schema.rawMessages.id,
        status: schema.rawMessages.status,
      })
      .from(schema.rawMessages)
      .where(inArray(schema.rawMessages.id, messageIds))) as { id: string; status: string }[];

    const live = new Map(messages.map((m) => [m.id, m.status]));

    const existing = (await tx
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.rawMessageId, messageIds))
      .for("update")) as any[];

    const key = (rawMessageId: string, accountId: string, direction: string) =>
      `${rawMessageId}|${accountId}|${direction}`;

    const byKey = new Map<string, any>();
    for (const row of existing) {
      byKey.set(key(row.rawMessageId, row.accountId, row.direction), row);
    }

    const report: ReplayReport = { dryRun: input.dryRun, changed: [], skipped: [], unchanged: 0 };

    for (const leg of legs) {
      const status = live.get(leg.rawMessageId);

      if (status === "ignored") {
        report.skipped.push({ rawMessageId: leg.rawMessageId, reason: "deleted" });
        continue;
      }

      const row = byKey.get(key(leg.rawMessageId, leg.accountId, leg.direction));

      if (!row) {
        // The message is live but has no transaction for this leg. Creating one
        // is a real replay's job; this module deliberately does not, because
        // creating rows from injected legs is how a replay turns into an
        // import, and an import has no diff to review.
        report.skipped.push({ rawMessageId: leg.rawMessageId, reason: "no-transaction" });
        continue;
      }

      // §9.4.1 — never, on any field, for any reason. A manual transaction has
      // no message behind it worth re-deriving from, and the adjustment legs
      // that correct a balance are manual precisely because they exist to
      // record what the messages could not.
      if (row.origin === "manual") {
        report.skipped.push({
          rawMessageId: leg.rawMessageId,
          reason: "manual",
          transactionId: row.id,
        });
        continue;
      }

      if (!inScope(row, input.scope)) {
        report.skipped.push({
          rawMessageId: leg.rawMessageId,
          reason: "out-of-scope",
          transactionId: row.id,
        });
        continue;
      }

      const locked: string[] = Array.isArray(row.lockedFields) ? row.lockedFields : [];

      const changes: FieldChange[] = [];
      const blocked: FieldChange[] = [];
      const write: Record<string, unknown> = {};

      for (const [field, value] of Object.entries(leg.fields) as [ReplayField, unknown][]) {
        const column = REPLAYABLE[field];
        if (!column) continue;

        const current = row[field];
        if (same(column, current, value)) continue;

        const change = { column, from: show(current), to: show(value) };

        // §9.4.2 — the highest-consequence line in this file.
        if (locked.includes(column)) {
          blocked.push(change);
          continue;
        }

        changes.push(change);
        write[field] = value;
      }

      if (changes.length === 0 && blocked.length === 0) {
        report.unchanged++;
        continue;
      }

      report.changed.push({
        transactionId: row.id,
        rawMessageId: leg.rawMessageId,
        changes,
        blocked,
      });

      if (!input.dryRun && changes.length > 0) {
        await tx
          .update(schema.transactions)
          .set({ ...write, updatedAt: new Date() })
          .where(eq(schema.transactions.id, row.id));
      }
    }

    return { ok: true, value: report };
  });
}

function inScope(row: any, scope?: ReplayScope): boolean {
  if (!scope) return true;
  if (scope.accountId && row.accountId !== scope.accountId) return false;

  if (scope.from || scope.to) {
    // Compared as calendar dates in the configured zone, the same way every
    // bucket in this app is. A UTC comparison would put a 01:00 local
    // transaction on the previous day and quietly drop it from a scoped replay.
    const day = new Date(row.postedAt).toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
    if (scope.from && day < scope.from) return false;
    if (scope.to && day > scope.to) return false;
  }

  return true;
}

/**
 * The messages a scoped replay would re-parse.
 *
 * Ignored ones are excluded here as well as refused in `replay()`. Belt and
 * braces on purpose: this is the query that decides what gets sent to the
 * parser, and a deleted transaction being re-parsed at all — even if the result
 * is then discarded — is a message being reprocessed against the user's
 * explicit decision.
 */
export async function replayableMessages(
  db: Db,
  scope: ReplayScope = {},
): Promise<{ id: string; sender: string; body: string; receivedAt: string }[]> {
  return db.transaction(async (tx: any) => {
    const conditions = [
      eq(schema.rawMessages.status, "parsed" as const),
      sql`NOT EXISTS (
        SELECT 1 FROM transactions t
         WHERE t.raw_message_id = ${schema.rawMessages.id} AND t.origin = 'manual'
      )`,
    ];

    if (scope.accountId) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM transactions t
         WHERE t.raw_message_id = ${schema.rawMessages.id}
           AND t.account_id = ${scope.accountId}::uuid
      )`);
    }
    if (scope.from) conditions.push(sql`local_date(${schema.rawMessages.receivedAt}) >= ${scope.from}::date`);
    if (scope.to) conditions.push(sql`local_date(${schema.rawMessages.receivedAt}) <= ${scope.to}::date`);

    return (await tx
      .select({
        id: schema.rawMessages.id,
        sender: schema.rawMessages.sender,
        body: schema.rawMessages.body,
        receivedAt: schema.rawMessages.receivedAt,
      })
      .from(schema.rawMessages)
      .where(and(...conditions))
      .orderBy(schema.rawMessages.receivedAt)) as any[];
  });
}
