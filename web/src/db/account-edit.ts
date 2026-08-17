/**
 * Applying a hand edit to an account, as one database transaction.
 *
 * Kept out of the server action so it can be run against a real Postgres by
 * `npm run test:account-edit` — the invariant that matters here is one no unit
 * test can reach: after the edit, the parser's own
 * `opening_balance + Σ(posted legs)` must still produce the balance that was
 * typed. If it does not, the next tick silently reverts the edit, and the only
 * symptom is a number that goes back to being wrong overnight.
 *
 * Takes the db as an argument rather than calling `getDb()` for the same
 * reason. Nothing here imports from `next/*`.
 */

import { and, eq, isNull } from "drizzle-orm";

import {
  type AccountDraft,
  type AccountState,
  type Change,
  adjustmentFor,
  diff,
  isLiabilityFor,
  normalise,
  parseAmount,
  validate,
} from "../lib/account-edit.ts";
import * as schema from "./schema.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- the transaction handle
 * is deliberately structural. The app runs on postgres-js and the test runs the
 * same function on PGlite, and drizzle gives those two different (very large)
 * database types; naming either one here would mean the tested path and the
 * shipped path are not the same function. Every query below is still typed by
 * the schema it names. */

/** Structurally what `drizzle()` returns, for either driver. */
type Db = { transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };

export type EditInput = {
  accountId: string;
  /**
   * The settings as the form submitted them, or **null for a balance-only
   * entry**.
   *
   * §3.3b makes one-tap manual balance entry a v1 requirement, not a nicety:
   * SAIB never reports a balance in any message and holds the current account,
   * the savings account and the salary. That control is one field, and it has
   * no business submitting a whole account alongside it — a form that carries
   * nine settings to change one figure is a form that can revert eight of them.
   *
   * Null means "the account keeps whatever it holds": the draft is read from
   * the locked row inside the transaction, so nothing can be reverted to a
   * value the page happened to be rendered with.
   */
  draft: AccountDraft | null;
  /** The balance as the person typed it, or null to leave it alone. */
  targetBalance: string | null;
  /**
   * The balance the form was populated with, if it was populated at all.
   *
   * The balance field arrives pre-filled, so every save submits a figure
   * whether or not anyone touched it — and a balance is not a value the form
   * owns. The parser moves it whenever a message lands, which it can do while
   * the sheet sits open. Without this, renaming an account at the wrong moment
   * books a correction back to whatever the balance was when the page
   * rendered, silently undoing a transaction that had just posted.
   *
   * So a submitted balance equal to the one the form started with is read as
   * "left alone", not as "set it to this".
   */
  knownBalance?: string | null;
  note: string | null;
  /** Injectable so a test can post at a known instant. */
  at?: Date;
};

export type EditOutcome = {
  changed: Record<string, Change>;
  adjustment: { id: string; direction: "credit" | "debit"; amount: string } | null;
};

export type EditResult = { ok: true; outcome: EditOutcome } | { ok: false; error: string };

export async function applyAccountEdit(db: Db, input: EditInput): Promise<EditResult> {
  const submitted = input.targetBalance === null ? null : input.targetBalance.trim() || null;

  // A submitted draft is refused before the transaction opens. A balance-only
  // entry has no draft to check yet — its fields come from the locked row
  // below, and are validated there against the same rules.
  if (input.draft) {
    const invalid = validate(normalise(input.draft), submitted);
    if (invalid) return { ok: false, error: invalid };
  }

  // Untouched, so not a request at all. Compared as amounts rather than as
  // text: the form renders "1912.40" and a person retyping the same figure may
  // write "1,912.4", and neither is an edit.
  const untouched =
    submitted !== null &&
    input.knownBalance != null &&
    parseAmount(submitted) === parseAmount(input.knownBalance);

  const target = untouched ? null : submitted;

  return db.transaction(async (tx: any): Promise<EditResult> => {
    // FOR UPDATE, because the delta is computed from the balance read one
    // statement earlier. Two saves racing without the lock both subtract from
    // the same stale figure and book one correction twice.
    const [before] = (await tx
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        type: schema.accounts.type,
        isLiability: schema.accounts.isLiability,
        balanceSemantics: schema.accounts.balanceSemantics,
        reconcilable: schema.accounts.reconcilable,
        currentBalance: schema.accounts.currentBalance,
        creditLimit: schema.accounts.creditLimit,
        statementDay: schema.accounts.statementDay,
        dueDay: schema.accounts.dueDay,
        isProfitBearing: schema.accounts.isProfitBearing,
        profitPayoutDay: schema.accounts.profitPayoutDay,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.accountId))
      .for("update")) as (AccountState & { id: string })[];

    if (!before) return { ok: false, error: "That account no longer exists." };

    // A balance-only entry adopts the account's own settings, read under the
    // lock a line above. `diff` will therefore find nothing but the balance,
    // and the UPDATE below touches only the columns it names.
    const draft = input.draft ? normalise(input.draft) : draftOf(before);

    if (!input.draft) {
      // The account may already be in a state that inverts net worth — a card
      // reporting available credit with no limit (§3.3a). Booking a balance
      // onto it would make that inversion look freshly confirmed by hand.
      const invalid = validate(draft, submitted);
      if (invalid) return { ok: false, error: invalid };
    }

    const at = input.at ?? new Date();

    // §4 — derived from the type, never typed in alongside it.
    const isLiability = isLiabilityFor(draft.type);

    // Stored at the column's own scale, so `"14000"` and `"14000.00"` are the
    // same limit and the diff below stops reporting a change that isn't one.
    const creditLimit =
      draft.creditLimit === null ? null : formatStored(draft.creditLimit);

    const adjustment =
      target === null ? null : adjustmentFor(before.currentBalance, target, draft.balanceSemantics);

    const after: AccountState = {
      ...draft,
      creditLimit,
      isLiability,
      currentBalance: adjustment === null ? before.currentBalance : formatStored(target!),
    };

    const changed = diff(before, after);
    const nothingChanged = Object.keys(changed).length === 0 && adjustment === null;
    if (nothingChanged) return { ok: true, outcome: { changed, adjustment: null } };

    let adjustmentId: string | null = null;

    if (adjustment) {
      const [leg] = (await tx
        .insert(schema.transactions)
        .values({
          accountId: before.id,
          postedAt: at,
          amount: adjustment.amount,
          direction: adjustment.direction,
          type: "adjustment",
          state: "posted",
          description: adjustment.description,
          notes: input.note,
          // §9.4 — replay must never touch this leg. It is the only record of
          // the difference, and re-deriving it from messages is impossible by
          // definition: it exists because the messages did not add up.
          origin: "manual",
          // A correction is neither spending nor income. Booking it as either
          // inflates one side of the savings rate (§6) with money that never
          // moved.
          excludedFromAnalytics: true,
          isReviewed: true,
        })
        .returning({ id: schema.transactions.id })) as { id: string }[];

      adjustmentId = leg.id;

      // §3.3b compensating control 3 — the manual balance entry, so an account
      // whose bank never states a balance has a verified point to reconcile
      // forward from. Source 'manual' keeps it out of `reconcile()`, which
      // compares against what the BANK said; treating our own figure as the
      // bank's would let a typo close a real drift alert.
      await tx.insert(schema.balanceSnapshots).values({
        accountId: before.id,
        balance: after.currentBalance,
        source: "manual",
        asOf: at,
      });
    }

    // Only the columns that actually moved. `changed` was computed field by
    // field against the row locked above, so a column nobody edited is not in
    // this SET at all — it keeps whatever it holds, including a value written
    // by something else while the form sat open.
    //
    // Writing the whole row instead would be a form-shaped overwrite of the
    // account: every save would assert the values the page was rendered with,
    // and anything that changed underneath in between would be reverted with
    // no record that it ever held another figure.
    //
    // The keys come from the diff, which only ever emits the fields in the
    // lib's own label table — so this cannot reach a column the sheet does not
    // offer, and `slug`, `institution`, `opening_balance`, `sort_order` and
    // `is_active` are untouchable here by construction.
    const patch: Record<string, unknown> = {};
    for (const field of Object.keys(changed)) {
      patch[field] = after[field as keyof AccountState];
    }

    if (adjustment) {
      // Set here as well as booked, so the screen is right immediately rather
      // than at the next tick. The figure is not a second opinion: it is
      // exactly what recompute_balances arrives at, because the leg above is
      // part of the sum it computes.
      patch.currentBalance = after.currentBalance;
      patch.balanceAsOf = at;
    }

    await tx.update(schema.accounts).set(patch).where(eq(schema.accounts.id, before.id));

    await tx.insert(schema.accountEdits).values({
      accountId: before.id,
      changed,
      note: input.note,
      adjustmentTransactionId: adjustmentId,
    });

    // A hand-entered balance is a claim that the account is now correct, so a
    // drift alert raised against the old figure has been answered — by this
    // edit rather than by a late message. Left open it would keep accusing an
    // account that is no longer wrong.
    if (adjustment) {
      await tx
        .update(schema.reconciliationAlerts)
        .set({ resolvedAt: at, resolutionNote: "balance corrected by hand" })
        .where(
          and(
            eq(schema.reconciliationAlerts.accountId, before.id),
            isNull(schema.reconciliationAlerts.resolvedAt),
          ),
        );
    }

    return {
      ok: true,
      outcome: {
        changed,
        adjustment: adjustmentId
          ? { id: adjustmentId, direction: adjustment!.direction, amount: adjustment!.amount }
          : null,
      },
    };
  });
}

/** The account's current settings, as a draft that changes none of them.
 *  Listed field by field rather than spread, so a column added to the SELECT
 *  above cannot silently become something a balance entry writes. */
function draftOf(before: AccountState): AccountDraft {
  return {
    name: before.name,
    type: before.type,
    balanceSemantics: before.balanceSemantics,
    reconcilable: before.reconcilable,
    creditLimit: before.creditLimit,
    statementDay: before.statementDay,
    dueDay: before.dueDay,
    isProfitBearing: before.isProfitBearing,
    profitPayoutDay: before.profitPayoutDay,
  };
}

/** NUMERIC(14,2) as the database will hold it. */
function formatStored(amount: string): string {
  const halalas = parseAmount(amount);
  return halalas === null ? amount : (halalas / 100).toFixed(2);
}
