"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db";
import { type EditOutcome, applyAccountEdit } from "@/db/account-edit";

export type SaveResult =
  | { ok: true; outcome: EditOutcome }
  | { ok: false; error: string };

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

  revalidatePath("/accounts");
  // The adjustment is a transaction: it belongs to a period, shows on the
  // ledger, and moves the net-worth figure on Home.
  revalidatePath("/ledger");
  revalidatePath("/");

  return result;
}
