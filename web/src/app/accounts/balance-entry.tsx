"use client";

/**
 * One-tap manual balance entry — SPEC §3.3b, compensating control 3.
 *
 * "**Manual balance entry is a v1 requirement rather than a nicety**", and the
 * reason is specific: SAIB never states a balance in any message, and it holds
 * the current account, the savings account and the salary. Those three are
 * otherwise derived from message flow alone, with nothing to check them
 * against — so a missed message there is permanent and invisible. Typing what
 * the bank app shows "restores the guarantee from that point forward".
 *
 * Three things this control deliberately is not:
 *
 *   - **Not an account form.** It submits one figure. The other nine settings
 *     are read from the locked row by `applyAccountEdit`, so this cannot revert
 *     something it never carried (`EditInput.draft`).
 *   - **Not a write to `current_balance`.** That column is derived and would be
 *     recomputed away within the minute (web/CLAUDE.md). The figure is booked as
 *     an `adjustment` leg, and the confirmation says so — a correction with no
 *     entry behind it is indistinguishable from the drift it was meant to fix.
 *   - **Not a reconciliation.** The snapshot it writes is `source='manual'`, so
 *     `reconcile()` in `api/db.py` keeps comparing against what the *bank* said.
 *     Treating your own figure as the bank's would let a typo close a real
 *     drift alert.
 */

import { useActionState, useState } from "react";

import { Loader } from "@/components/ui/loader";
import { Sheet } from "@/components/ui/sheet";
import { parseAmount } from "@/lib/account-edit";
import { money } from "@/lib/accounts";

import { type SaveResult, enterBalance } from "./actions";

export type BalanceTarget = {
  id: string;
  slug: string;
  name: string;
  institution: string;
  balanceSemantics: string;
  creditLimit: string | null;
  currentBalance: string;
  reconcilable: boolean;
};

const field =
  "mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

export function BalanceEntry({
  account,
  variant = "compact",
}: {
  account: BalanceTarget;
  /** `compact` is the list row's chip; `full` is the detail page's button. */
  variant?: "compact" | "full";
}) {
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState("");
  const [state, action, pending] = useActionState<SaveResult | null, FormData>(
    enterBalance,
    null,
  );

  const availableCredit = account.balanceSemantics === "available_credit";
  const limit = account.creditLimit === null ? null : parseAmount(account.creditLimit);

  // §3.3a, live: on a card a HIGHER figure means LESS debt. Stating the
  // consequence as it is typed is the cheapest defence there is against
  // entering what you owe where what you can spend was asked for.
  const owed = (() => {
    if (!availableCredit || limit === null) return null;
    const typed = parseAmount(balance);
    return typed === null ? null : (limit - typed) / 100;
  })();

  const label = availableCredit ? "Available credit" : "Balance";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          variant === "compact"
            ? "shrink-0 rounded-full border border-black/10 px-2.5 py-1 text-[11px] leading-none opacity-70 hover:bg-black/[0.04] hover:opacity-100 dark:border-white/20 dark:hover:bg-white/[0.08]"
            : "rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        }
      >
        Enter balance{variant === "full" ? " now" : ""}
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={`${account.name} — enter balance`}>
        <p className="-mt-1 text-xs opacity-55">
          {account.reconcilable
            ? "Type what the bank app shows right now. The difference is booked to the ledger, so the figure survives the next parse and everything after it reconciles forward from here."
            : "This bank never states a balance in a message, so nothing checks this account automatically (§3.3b). Typing what the bank app shows is what anchors it — from this point forward a missed message shows up as drift instead of disappearing."}
        </p>

        <form action={action} className="mt-4">
          <input type="hidden" name="id" value={account.id} />
          <input type="hidden" name="slug" value={account.slug} />

          <label className="block text-xs">
            <span className="opacity-70">{label}</span>
            <span className="ml-1 opacity-40">as the bank states it</span>
            <input
              name="balance"
              type="text"
              inputMode="decimal"
              autoFocus
              required
              placeholder={account.currentBalance}
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className={`${field} tabular`}
            />
          </label>

          <p className="mt-1.5 text-xs opacity-55">
            We currently make it{" "}
            <span className="tabular">{money(Number(account.currentBalance))}</span>
            {owed !== null && (
              <>
                {" "}
                · you would owe{" "}
                <span className="tabular font-medium text-rose-600 dark:text-rose-400">
                  {owed < 0 && "−"}
                  {money(owed)}
                </span>
              </>
            )}
          </p>

          <label className="mt-3 block text-xs">
            <span className="opacity-70">Note</span>
            <span className="ml-1 opacity-40">optional — kept with the entry</span>
            <input
              name="note"
              type="text"
              dir="auto"
              placeholder="read off the SAIB app"
              className={field}
            />
          </label>

          {state && !state.ok && (
            <p className="mt-3 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
              {state.error}
            </p>
          )}

          {state?.ok && (
            <p className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              {state.outcome.adjustment ? (
                <>
                  Booked a{" "}
                  <span className="tabular font-medium">
                    {state.outcome.adjustment.direction === "credit" ? "+" : "−"}
                    {state.outcome.adjustment.amount}
                  </span>{" "}
                  adjustment and recorded the balance. It counts as neither income nor spending.
                </>
              ) : (
                <>That is the figure we already had, so nothing was booked.</>
              )}
            </p>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
            >
              {pending && <Loader size={16} variant="arrows" label="Recording the balance" />}
              {pending ? "Recording…" : "Record balance"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
            >
              {state?.ok ? "Done" : "Cancel"}
            </button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
