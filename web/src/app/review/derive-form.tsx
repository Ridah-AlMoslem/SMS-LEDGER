"use client";

import { useActionState, useState } from "react";

import { type DeriveResult, deriveTemplate } from "./actions";

const KINDS = [
  "purchase", "withdrawal", "transfer", "salary", "profit", "fee",
  "bill_payment", "card_payment", "cashback_accrual", "cashback_redeem",
];

// Must stay in step with ledger/dates.py FORMATS.
const DATE_FORMATS = ["ISO", "D/M/YY", "YY/M/D", "DD-MM-YYYY", "MM-DD", "DD-MM"];

const FIELDS: { name: string; label: string; hint?: string }[] = [
  { name: "amount", label: "Amount", hint: "required" },
  { name: "merchant", label: "Merchant" },
  { name: "balance", label: "Balance after" },
  { name: "date_raw", label: "Date", hint: "exactly as written" },
  { name: "card", label: "Card / account" },
  { name: "counterparty", label: "Other party" },
  { name: "fee_amount", label: "Fee" },
  { name: "biller", label: "Biller" },
];

export function DeriveForm({
  messageId,
  accounts,
}: {
  messageId: string;
  accounts: { slug: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<DeriveResult | null, FormData>(
    deriveTemplate,
    null,
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      >
        Teach the parser
      </button>
    );
  }

  return (
    <form action={action} className="w-full rounded-lg border border-black/10 p-3 dark:border-white/15">
      <input type="hidden" name="message_id" value={messageId} />

      <p className="text-sm font-medium">Teach the parser this format</p>
      <p className="mt-1 text-xs opacity-60">
        Copy each value out of the message above, exactly as it appears. Leave the rest blank.
        Everything sharing this format reparses afterwards.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="opacity-70">Type</span>
          <select
            name="kind"
            required
            defaultValue="purchase"
            className="mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{k.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>

        <label className="text-xs">
          <span className="opacity-70">Direction</span>
          <select
            name="direction"
            required
            defaultValue="debit"
            className="mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
          >
            <option value="debit">debit — money out</option>
            <option value="credit">credit — money in</option>
          </select>
        </label>

        <label className="text-xs">
          <span className="opacity-70">Account</span>
          <select
            name="account_hint"
            defaultValue=""
            className="mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
          >
            <option value="">from the card number</option>
            {accounts.map((a) => (
              <option key={a.slug} value={a.slug}>{a.name}</option>
            ))}
          </select>
        </label>

        <label className="text-xs">
          <span className="opacity-70">Date format</span>
          <select
            name="date_format"
            defaultValue=""
            className="mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
          >
            <option value="">no date</option>
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {FIELDS.map((f) => (
          <label key={f.name} className="text-xs">
            <span className="opacity-70">{f.label}</span>
            {f.hint && <span className="ml-1 opacity-40">{f.hint}</span>}
            <input
              name={f.name}
              type="text"
              dir="auto"
              required={f.name === "amount"}
              className="mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
            />
          </label>
        ))}
      </div>

      {state && !state.ok && (
        <p className="mt-3 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          Saved. {state.requeued} message{state.requeued === 1 ? "" : "s"} queued to reparse —
          they will appear on the ledger after the next tick.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
        >
          {pending ? "Checking…" : "Save template"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
      </div>

      <p className="mt-2 text-xs opacity-50">
        The template is tested against this message before it is saved. If it can&rsquo;t
        reproduce the values you entered, it is rejected rather than stored.
      </p>
    </form>
  );
}
