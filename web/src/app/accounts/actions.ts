"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db";
import { type EditOutcome, applyAccountEdit } from "@/db/account-edit";
import { type ResolveResult, resolveDrift } from "@/db/reconciliation";

export type SaveResult =
  | { ok: true; outcome: EditOutcome }
  | { ok: false; error: string };

/** Every screen a booked adjustment moves. The leg is a transaction: it has a
 *  date, sits in the ledger, and shifts the net-worth figure on Home.
 *
 *  Review is in the list because the master invariant (§6) reads the same legs:
 *  an adjustment moves net worth without being income or expense, so a balance
 *  corrected here changes what that panel has to explain. It is also where the
 *  drift alert this closes is listed a second time. */
function revalidateAll(slug?: string | null) {
  revalidatePath("/accounts");
  if (slug) revalidatePath(`/accounts/${slug}`);
  revalidatePath("/ledger");
  revalidatePath("/review");
  revalidatePath("/");
}

/**
 * Save an edited account (SPEC §3.3, §9.4).
 *
 * Thin on purpose: FormData in, `applyAccountEdit` out. The rules live in
 * `lib/account-edit.ts` and the write in `db/account-edit.ts`, both of which
 * run under test — a server action cannot be called from a test file without
 * a Next runtime around it, so anything that lives here is effectively
 * unverified.
 */
export async function saveAccount(_prev: SaveResult | null, form: FormData): Promise<SaveResult> {
  const str = (k: string) => (form.get(k) as string | null)?.trim() ?? "";
  const opt = (k: string) => str(k) || null;
  const bool = (k: string) => form.get(k) === "on";
  const int = (k: string) => {
    const v = str(k);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  };

  const accountId = str("id");
  if (!accountId) return { ok: false, error: "No account was submitted." };

  const days = { statementDay: int("statement_day"), dueDay: int("due_day"), profitPayoutDay: int("profit_payout_day") };
  for (const value of Object.values(days)) {
    if (Number.isNaN(value)) return { ok: false, error: "A day must be a whole number." };
  }

  let result;
  try {
    result = await applyAccountEdit(getDb(), {
      accountId,
      draft: {
        name: str("name"),
        type: str("type"),
        balanceSemantics: str("balance_semantics") || "balance",
        reconcilable: bool("reconcilable"),
        creditLimit: opt("credit_limit"),
        ...days,
        isProfitBearing: bool("is_profit_bearing"),
      },
      targetBalance: opt("balance"),
      // What the field was pre-filled with, so a balance nobody touched is
      // left alone rather than re-asserted over whatever the parser has
      // posted since the sheet opened.
      knownBalance: opt("balance_was"),
      note: opt("note"),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) return result;

  revalidateAll(opt("slug"));

  return result;
}

/**
 * §3.3b's third compensating control: one-tap manual balance entry.
 *
 * A v1 requirement rather than a nicety — SAIB never states a balance in any
 * message and holds the current account, the savings account and the salary, so
 * without this those three are derived from message flow alone forever, with
 * nothing to check them against.
 *
 * It submits one figure and no settings. `applyAccountEdit` reads the rest of
 * the account from the row it locks, which is what stops a control this small
 * from being able to revert anything: there is nothing else in the form to
 * revert it to.
 */
export async function enterBalance(
  _prev: SaveResult | null,
  form: FormData,
): Promise<SaveResult> {
  const str = (k: string) => (form.get(k) as string | null)?.trim() ?? "";

  const accountId = str("id");
  if (!accountId) return { ok: false, error: "No account was submitted." };

  const balance = str("balance");
  if (!balance) return { ok: false, error: "Enter the balance your bank is showing." };

  let result;
  try {
    result = await applyAccountEdit(getDb(), {
      accountId,
      // Nothing but the balance. See `EditInput.draft`.
      draft: null,
      targetBalance: balance,
      // Deliberately absent: this control exists to assert a figure read off
      // the bank's own app, so it is always a claim about now, never a
      // resubmission of what the page was rendered with.
      knownBalance: null,
      note: str("note") || null,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) return result;

  revalidateAll(str("slug"));

  return result;
}

/**
 * Close a drift alert with the reason it was closed (§3.3).
 *
 * Does not touch the balances. If the ledger and the bank still disagree, the
 * next reconciliation pass raises the same alert again — which is correct, and
 * which the sheet says out loud, because a button that looks like it fixes a
 * number it does not touch is worse than no button.
 */
export async function resolveAlert(
  _prev: ResolveResult | null,
  form: FormData,
): Promise<ResolveResult> {
  const str = (k: string) => (form.get(k) as string | null)?.trim() ?? "";

  const alertId = str("alert_id");
  if (!alertId) return { ok: false, error: "No alert was submitted." };

  let result;
  try {
    result = await resolveDrift(getDb(), { alertId, note: str("note") });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) return result;

  revalidateAll(str("slug"));

  return result;
}
