"use client";

/**
 * Closing a reconciliation alert, with the reason (SPEC §3.3).
 *
 * The note is required and the copy is blunt about what this does and does not
 * do. Two things it does not do:
 *
 *   - **It does not change a balance.** If the ledger and the bank still
 *     disagree, `reconcile()` raises the same alert on the next tick, because
 *     they still disagree. The way to end a drift is to correct the balance,
 *     which books an adjustment and closes the alert as a consequence of the
 *     ledger now adding up.
 *   - **It does not explain anything on its own.** The note is the explanation,
 *     and six weeks later it is the only thing distinguishing "I found the
 *     missing message" from a mis-tap.
 */

import { useActionState, useState } from "react";

import { Loader } from "@/components/ui/loader";
import { Sheet } from "@/components/ui/sheet";
import type { ResolveResult } from "@/db/reconciliation";

import { resolveAlert } from "../actions";

export function ResolveDrift({
  alertId,
  slug,
  delta,
  /** Whether the two figures still disagree right now. Decides the warning. */
  stillOff,
}: {
  alertId: string;
  slug: string;
  delta: number;
  stillOff: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ResolveResult | null, FormData>(
    resolveAlert,
    null,
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-lg border border-black/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      >
        Explain it
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Close this difference">
        <p className="-mt-1 text-xs opacity-55">
          A difference of{" "}
          <span className="tabular">{Math.abs(delta).toFixed(2)}</span> between what the ledger
          computes and what the bank last reported. Usually a message that never arrived.
        </p>

        {stillOff && (
          <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-500">
            The two figures still disagree, so the next reconciliation pass will raise this again —
            closing it here records that you looked, not that it is fixed. To end it, enter the
            balance the bank is showing; that books the difference to the ledger and the alert
            closes because the numbers agree.
          </p>
        )}

        <form action={action} className="mt-4">
          <input type="hidden" name="alert_id" value={alertId} />
          <input type="hidden" name="slug" value={slug} />

          <label className="block text-xs">
            <span className="opacity-70">What explains it</span>
            <span className="ml-1 opacity-40">required</span>
            <textarea
              name="note"
              rows={3}
              dir="auto"
              required
              autoFocus
              placeholder="found the missing SMS and re-ingested it / bank fee that never sent a message"
              className="mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
            />
          </label>

          {state && !state.ok && (
            <p className="mt-3 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
              {state.error}
            </p>
          )}

          {state?.ok && (
            <p className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              Closed, with your note kept against it.
            </p>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={pending || state?.ok === true}
              className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
            >
              {pending && <Loader size={16} variant="arrows" label="Closing the alert" />}
              {pending ? "Closing…" : "Close it"}
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
