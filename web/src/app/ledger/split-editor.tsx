"use client";

/**
 * Splitting one transaction across categories (SPEC §9.6).
 *
 * The rule is Σ splits = transaction.amount, exactly, and it is enforced in
 * three places on purpose:
 *
 *   - here, as a running remainder and a disabled Save, so the arithmetic is
 *     visible while you type rather than discovered on submit;
 *   - in `db/ledger-mutations.ts`, so a write that never came through this
 *     screen is refused with the same message;
 *   - in the database, as a deferred constraint trigger (migration 0003), so a
 *     script, a psql session or a future screen cannot get past it either.
 *
 * Only the last of those is a guarantee. This one is a courtesy — but it is the
 * one that makes splitting a 240 into three parts something you can do with a
 * thumb, because the number still to allocate is on screen the whole time.
 */

import { useState } from "react";

import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import type { Facets } from "@/db/ledger";
import type { SplitInput } from "@/db/ledger-mutations";
import { parseAmount } from "@/lib/account-edit";

const field =
  "w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

type Draft = { categoryId: string; amount: string };

export function SplitEditor({
  amount,
  categories,
  initial,
  saving,
  onSave,
  onCancel,
}: {
  /** The whole, as stored. Every split must add up to this. */
  amount: string;
  categories: Facets["categories"];
  initial: { categoryId: string; amount: string }[];
  saving: boolean;
  onSave: (splits: SplitInput[]) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<Draft[]>(
    initial.length > 0
      ? initial.map((s) => ({ categoryId: s.categoryId, amount: s.amount }))
      : // Opening on a two-row draft, the second holding the whole remainder:
        // the first thing a split needs is a second category, and starting from
        // one row makes the reader add it before anything can happen.
        [
          { categoryId: "", amount: "" },
          { categoryId: "", amount: "" },
        ],
  );

  const whole = parseAmount(amount) ?? 0;
  const allocated = rows.reduce((sum, r) => sum + (parseAmount(r.amount) ?? 0), 0);
  const remainder = whole - allocated;

  const incomplete = rows.some((r) => !r.categoryId || parseAmount(r.amount) === null);
  const canSave = remainder === 0 && !incomplete && rows.length > 0;

  const update = (index: number, patch: Partial<Draft>) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/15">
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <select
              value={row.categoryId}
              onChange={(e) => update(index, { categoryId: e.target.value })}
              className={`${field} min-w-0 flex-1`}
            >
              <option value="">Category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
                </option>
              ))}
            </select>

            <input
              inputMode="decimal"
              value={row.amount}
              onChange={(e) => update(index, { amount: e.target.value })}
              placeholder="0.00"
              aria-label={`Split ${index + 1} amount`}
              className={`${field} tabular w-24 shrink-0`}
            />

            <button
              type="button"
              onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              aria-label={`Remove split ${index + 1}`}
              className="shrink-0 px-1 text-sm opacity-45 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setRows((current) => [
              ...current,
              // The new row is pre-filled with what is left, which is what it is
              // almost always for.
              { categoryId: "", amount: remainder > 0 ? (remainder / 100).toFixed(2) : "" },
            ])
          }
          className="rounded-lg border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Add a category
        </button>

        {remainder !== 0 && rows.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setRows((current) =>
                current.map((r, i) =>
                  i === current.length - 1
                    ? {
                        ...r,
                        amount: (((parseAmount(r.amount) ?? 0) + remainder) / 100).toFixed(2),
                      }
                    : r,
                ),
              )
            }
            className="rounded-lg border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            Put the rest on the last row
          </button>
        )}
      </div>

      <p className="mt-3 flex items-baseline justify-between text-xs">
        <span className="opacity-60">
          {remainder === 0 ? "Adds up" : remainder > 0 ? "Still to allocate" : "Over by"}
        </span>
        <Money
          value={Math.abs(remainder) / 100}
          tone={remainder === 0 ? "none" : "auto"}
          sign="never"
          className={remainder === 0 ? "opacity-60" : "font-medium text-rose-600 dark:text-rose-400"}
        />
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!canSave || saving}
          onClick={() =>
            onSave(
              rows.map((r) => ({
                categoryId: r.categoryId,
                amount: ((parseAmount(r.amount) ?? 0) / 100).toFixed(2),
              })),
            )
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/10"
        >
          {saving && <Loader size={16} variant="arrows" label="Saving the split" />}
          {saving ? "Saving…" : "Save the split"}
        </button>

        {initial.length > 0 && (
          <button
            type="button"
            onClick={() => onSave([])}
            className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
          >
            Remove the split
          </button>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
      </div>

      <p className="mt-2 text-[11px] opacity-50">
        A split transaction is categorized across its parts instead of on the row, and counts
        once in every total. Saving one counts as categorizing it by hand, so a replay will leave
        the categories alone.
      </p>
    </div>
  );
}
