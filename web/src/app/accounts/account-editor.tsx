"use client";

/**
 * The edit sheet behind every account row.
 *
 * Wraps the row rather than replacing it, so the list stays a server component
 * and only this shell ships as client JavaScript.
 *
 * The form is opinionated about three things, all of them §3.3:
 *
 *  - `slug` and `institution` are shown but not editable. The parser addresses
 *    accounts by slug and matches identifiers per institution; they are
 *    identifiers, not labels.
 *  - The balance field is labelled by what the bank means by it. On a card it
 *    is available credit, and the sheet shows the resulting debt as you type,
 *    because that is the number the reader actually cares about and the one
 *    that moves in the opposite direction.
 *  - Saving a new balance says, in the confirmation, that a ledger entry was
 *    booked. An edit that quietly changed a number would be indistinguishable
 *    from the drift it is supposed to correct.
 */

import Link from "next/link";
import { useActionState, useState } from "react";

import { Loader } from "@/components/ui/loader";
import { Sheet } from "@/components/ui/sheet";
import { ACCOUNT_TYPES, fieldLabel, parseAmount } from "@/lib/account-edit";
import { TYPE_LABELS, money } from "@/lib/accounts";
import { timeOfDay } from "@/lib/format";

import { type SaveResult, saveAccount } from "./actions";

export type EditableAccount = {
  id: string;
  slug: string;
  name: string;
  institution: string;
  type: string;
  balanceSemantics: string;
  reconcilable: boolean;
  currentBalance: string;
  creditLimit: string | null;
  statementDay: number | null;
  dueDay: number | null;
  isProfitBearing: boolean;
  profitPayoutDay: number | null;
};

export type EditRecord = {
  id: string;
  accountId: string;
  changed: Record<string, { from: string | null; to: string | null }>;
  note: string | null;
  adjustmentTransactionId: string | null;
  createdAt: string;
};

const field =
  "mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs">
      <span className="opacity-70">{label}</span>
      {hint && <span className="ml-1 opacity-40">{hint}</span>}
      {children}
    </label>
  );
}

function Toggle({
  name,
  label,
  note,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  note: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 py-2">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="mt-0.5 block text-xs opacity-55">{note}</span>
      </span>
    </label>
  );
}

export function AccountEditor({
  account,
  history,
  children,
}: {
  account: EditableAccount;
  history: EditRecord[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<SaveResult | null, FormData>(saveAccount, null);

  // Only the fields that change what the rest of the form means are held in
  // state. Everything else is uncontrolled, so the form reads its values from
  // the account and resets to the saved truth when the sheet reopens.
  const [type, setType] = useState(account.type);
  const [semantics, setSemantics] = useState(account.balanceSemantics);
  const [balance, setBalance] = useState(account.currentBalance);
  const [limit, setLimit] = useState(account.creditLimit ?? "");
  const [profitBearing, setProfitBearing] = useState(account.isProfitBearing);
  const [reconcilable, setReconcilable] = useState(account.reconcilable);

  const isCard = type === "credit_card";
  const availableCredit = isCard && semantics === "available_credit";

  // The §3.3a arithmetic, shown live: on a card, typing a HIGHER figure means
  // LESS debt. Stating it on screen is the cheapest possible defence against
  // entering a debt where an available balance was asked for.
  const owed = (() => {
    if (!availableCredit) return null;
    const b = parseAmount(balance);
    const l = parseAmount(limit);
    if (b === null || l === null) return null;
    return (l - b) / 100;
  })();

  return (
    // One element, not a fragment: the account list divides its children with
    // `divide-y`, and a sheet returned as a sibling would collect a border
    // across the top of the viewport.
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-2 rounded-lg text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        <span className="block min-w-0 flex-1">{children}</span>
        <span aria-hidden className="shrink-0 opacity-25 transition-opacity group-hover:opacity-60">
          ›
        </span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={account.name}>
        <p className="-mt-1 text-xs opacity-55">
          {account.institution} · <code>{account.slug}</code> — the slug and institution are how
          the parser addresses this account and how incoming messages are matched to it, so they
          are fixed here.
        </p>

        <form action={action} className="mt-4">
          <input type="hidden" name="id" value={account.id} />
          {/* So the action can revalidate this account's own detail route as
              well as the list — a booked adjustment moves both. */}
          <input type="hidden" name="slug" value={account.slug} />
          {/* What the balance field below was rendered with. A balance moves
              on its own — the parser rewrites it whenever a message lands —
              so submitting this figure back unchanged has to mean "leave it",
              not "set it to what the screen was showing". */}
          <input type="hidden" name="balance_was" value={account.currentBalance} />

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="Name">
                <input name="name" type="text" dir="auto" required defaultValue={account.name} className={field} />
              </Field>
            </div>

            <Field label="Type">
              <select
                name="type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className={field}
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={availableCredit ? "Available credit" : "Balance"}
              hint="as the bank states it"
            >
              <input
                name="balance"
                type="text"
                inputMode="decimal"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                className={`${field} tabular`}
              />
            </Field>
          </div>

          {isCard && (
            <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-black/10 p-3 dark:border-white/15">
              <div className="col-span-2">
                <Field label="The reported figure is">
                  <select
                    name="balance_semantics"
                    value={semantics}
                    onChange={(e) => setSemantics(e.target.value)}
                    className={field}
                  >
                    <option value="available_credit">available credit — what you can spend</option>
                    <option value="balance">a balance — what you owe</option>
                  </select>
                </Field>
              </div>

              <Field label="Credit limit">
                <input
                  name="credit_limit"
                  type="text"
                  inputMode="decimal"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className={`${field} tabular`}
                />
              </Field>

              <div className="self-end pb-1 text-xs">
                {owed === null ? (
                  <span className="opacity-40">Enter a limit to see the debt.</span>
                ) : (
                  <span className="opacity-70">
                    Owed:{" "}
                    <span className="tabular font-medium text-rose-600 dark:text-rose-400">
                      {owed < 0 && "−"}
                      {money(owed)}
                    </span>
                  </span>
                )}
              </div>

              <Field label="Statement day" hint="1–28">
                <input
                  name="statement_day"
                  type="number"
                  min={1}
                  max={28}
                  defaultValue={account.statementDay ?? ""}
                  className={field}
                />
              </Field>
              <Field label="Payment due day" hint="1–28">
                <input
                  name="due_day"
                  type="number"
                  min={1}
                  max={28}
                  defaultValue={account.dueDay ?? ""}
                  className={field}
                />
              </Field>
            </div>
          )}

          <div className="mt-2 divide-y divide-black/8 dark:divide-white/10">
            <Toggle
              name="is_profit_bearing"
              label="Profit-bearing"
              note="Profit counts as income. The rate is variable and is never stored as expected."
              checked={profitBearing}
              onChange={setProfitBearing}
            />
            {profitBearing && (
              <div className="py-2">
                <Field label="Profit payout day" hint="1–28">
                  <input
                    name="profit_payout_day"
                    type="number"
                    min={1}
                    max={28}
                    defaultValue={account.profitPayoutDay ?? ""}
                    className={field}
                  />
                </Field>
              </div>
            )}
            <Toggle
              name="reconcilable"
              label="Messages state a balance"
              note="Off for an account whose bank never prints one. Checking it against nothing would either alarm forever or claim a clean reconciliation it has not earned."
              checked={reconcilable}
              onChange={setReconcilable}
            />
          </div>

          <div className="mt-3">
            <Field label="Note" hint="why — kept with the change">
              <input
                name="note"
                type="text"
                dir="auto"
                placeholder="counted the cash, bank app says…"
                className={field}
              />
            </Field>
          </div>

          {state && !state.ok && (
            <p className="mt-3 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
              {state.error}
            </p>
          )}

          {state?.ok && <Saved result={state.outcome} />}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
            >
              {pending && <Loader size={16} variant="arrows" label="Saving the account" />}
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
            >
              Cancel
            </button>
          </div>

          <p className="mt-3 text-xs opacity-50">
            A new balance is booked as an adjustment in the ledger rather than written over the old
            one. Balances are derived from the transactions beneath them, so a figure typed straight
            in would be recomputed away at the next parse — and a correction with no entry behind it
            is indistinguishable from the drift it was meant to fix.
          </p>
        </form>

        <History records={history} />
      </Sheet>
    </div>
  );
}

function Saved({ result }: { result: Extract<SaveResult, { ok: true }>["outcome"] }) {
  const fields = Object.keys(result.changed);

  if (fields.length === 0 && !result.adjustment) {
    return (
      <p className="mt-3 rounded border border-black/10 px-2 py-1.5 text-xs opacity-60 dark:border-white/15">
        Nothing changed, so nothing was recorded.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
      {fields.length > 0 && (
        <p>
          Saved {fields.map(fieldLabel).join(", ").toLowerCase()}.
        </p>
      )}
      {result.adjustment && (
        <p className={fields.length > 0 ? "mt-1" : ""}>
          Booked a{" "}
          <span className="tabular font-medium">
            {result.adjustment.direction === "credit" ? "+" : "−"}
            {result.adjustment.amount}
          </span>{" "}
          adjustment.{" "}
          <Link href="/ledger" className="underline underline-offset-2">
            See it in the ledger
          </Link>
          . It does not count as income or spending.
        </p>
      )}
    </div>
  );
}

function History({ records }: { records: EditRecord[] }) {
  if (records.length === 0) return null;

  return (
    <section className="mt-6 border-t border-black/10 pt-4 dark:border-white/10">
      <h3 className="text-xs font-semibold tracking-wide uppercase opacity-60">Previous changes</h3>
      <ul className="mt-2 space-y-3">
        {records.map((r) => (
          <li key={r.id} className="text-xs">
            <p className="opacity-50">{timeOfDay(new Date(r.createdAt))}</p>
            <ul className="mt-0.5 space-y-0.5">
              {Object.entries(r.changed).map(([f, c]) => (
                <li key={f} className="opacity-80">
                  <span className="opacity-60">{fieldLabel(f)}:</span>{" "}
                  <span className="line-through opacity-50">{c.from ?? "unset"}</span>{" "}
                  <span aria-hidden>→</span> <span>{c.to ?? "unset"}</span>
                </li>
              ))}
              {r.adjustmentTransactionId && (
                <li className="opacity-80">Balance corrected — booked to the ledger.</li>
              )}
            </ul>
            {r.note && <p className="sms-body mt-0.5 opacity-60">“{r.note}”</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
