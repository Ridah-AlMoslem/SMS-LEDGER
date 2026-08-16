"use client";

/**
 * Cash, typed in (SPEC §9.4, §11.1).
 *
 * The one thing in this ledger that no message will ever describe. §8.1 books
 * an ATM withdrawal as spending the moment it happens, which covers the cash
 * leaving the bank — but a 30 riyal coffee paid from a pocket is invisible to
 * every bank in the country, and a personal ledger that cannot record it has a
 * hole in it exactly the size of however much cash you use.
 *
 * `origin='manual'`, so replay never touches it: there is no message to
 * re-derive it from, and a replay that "corrected" one would simply delete
 * information (§9.4.1).
 *
 * A floating button rather than a menu item, because this is the only thing on
 * this screen that creates something, and it has to be reachable with the same
 * thumb that is already scrolling.
 */

import { useState } from "react";

import { Loader } from "@/components/ui/loader";
import { Sheet } from "@/components/ui/sheet";
import type { Facets } from "@/db/ledger";
import { toLocalInput, fromLocalInput } from "@/lib/format";
import { TRANSACTION_TYPES, TYPE_LABELS } from "@/lib/ledger-filters";

import type { useLedgerMutations } from "./use-ledger";

const field =
  "mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

const ABOVE_TAB_BAR = "calc(57px + env(safe-area-inset-bottom))";

export function ManualEntry({
  accounts,
  categories,
  mutations,
}: {
  accounts: Facets["accounts"];
  categories: Facets["categories"];
  mutations: ReturnType<typeof useLedgerMutations>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add a cash transaction"
        className="fixed right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-2xl leading-none text-[var(--background)] shadow-lg"
        style={{ bottom: `calc(${ABOVE_TAB_BAR} + 1rem)` }}
      >
        <span aria-hidden>+</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Cash transaction">
        {open && (
          <Form
            accounts={accounts}
            categories={categories}
            mutations={mutations}
            onDone={() => setOpen(false)}
          />
        )}
      </Sheet>
    </>
  );
}

function Form({
  accounts,
  categories,
  mutations,
  onDone,
}: {
  accounts: Facets["accounts"];
  categories: Facets["categories"];
  mutations: ReturnType<typeof useLedgerMutations>;
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [postedAt, setPostedAt] = useState(() => toLocalInput(new Date()));
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"debit" | "credit">("debit");
  const [type, setType] = useState("purchase");
  const [categoryId, setCategoryId] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const when = fromLocalInput(postedAt);
    if (!when) {
      setError("That date could not be read.");
      return;
    }
    if (!accountId) {
      setError("Pick the account the money moved on.");
      return;
    }

    setError(null);
    mutations.manual.mutate(
      {
        accountId,
        postedAt: when,
        amount,
        direction,
        type,
        categoryId: categoryId || null,
        description: description.trim() || null,
        notes: notes.trim() || null,
      },
      {
        onSuccess: onDone,
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <div className="pb-2">
      <p className="-mt-1 text-xs opacity-55">
        For money that no message will describe — cash out of a pocket, or a transaction from
        before the ledger started. It is marked manual, so a replay leaves it exactly as typed.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs">
            <span className="opacity-70">Account</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className={field}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[11px] opacity-50">
            Cash spent from a withdrawal was already counted when the withdrawal posted (§8.1) —
            recording it again here would count it twice. This is for cash the ledger has never
            seen.
          </p>
        </div>

        <div className="col-span-2">
          <label className="block text-xs">
            <span className="opacity-70">When</span>
            <input
              type="datetime-local"
              value={postedAt}
              onChange={(e) => setPostedAt(e.target.value)}
              className={`${field} tabular`}
            />
          </label>
        </div>

        <label className="block text-xs">
          <span className="opacity-70">Amount</span>
          <span className="ml-1 opacity-40">SAR</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            autoFocus
            className={`${field} tabular`}
          />
        </label>

        <label className="block text-xs">
          <span className="opacity-70">Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as "debit" | "credit")}
            className={field}
          >
            <option value="debit">Money out</option>
            <option value="credit">Money in</option>
          </select>
        </label>

        <label className="block text-xs">
          <span className="opacity-70">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs">
          <span className="opacity-70">Category</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={field}
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="col-span-2">
          <label className="block text-xs">
            <span className="opacity-70">What it was</span>
            <input
              type="text"
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Coffee, cash"
              className={`${field} sms-body`}
            />
          </label>
        </div>

        <div className="col-span-2">
          <label className="block text-xs">
            <span className="opacity-70">Notes</span>
            <input
              type="text"
              dir="auto"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`${field} sms-body`}
            />
          </label>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={mutations.manual.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {mutations.manual.isPending && (
            <Loader size={16} variant="arrows" label="Adding the transaction" />
          )}
          {mutations.manual.isPending ? "Adding…" : "Add"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
