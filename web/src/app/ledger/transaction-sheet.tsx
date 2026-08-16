"use client";

/**
 * One transaction, everything about it, and every way to change it.
 *
 * A bottom sheet rather than a route push, because it is a layer over the list
 * you were reading and not a place you navigated to — you close it and you are
 * still at the same scroll position, in the same filtered view.
 *
 * The raw SMS is at the top, verbatim, in `.sms-body` (§3.1). Everything below
 * it is derived from those few lines, and showing the source is what makes an
 * edit decision possible: "the parser read 86.37 and the message says 88.36" is
 * a judgement anyone can make in a second, and an impossible one to make from
 * the parsed fields alone.
 *
 * Two behaviours here are load-bearing:
 *
 *   - Writing a field by hand locks it (§9.4), and the lock is shown as a
 *     marker you can tap to release. Without the marker, the guarantee is
 *     invisible; without the release, a mistyped correction would be permanent.
 *   - The category picker is the one field that saves on change rather than on
 *     submit. It is the edit made most often, and it is where the rule offer
 *     belongs — every correction should reduce the number of future
 *     corrections (§9.5).
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import { Sheet } from "@/components/ui/sheet";
import type { Facets, LedgerRow, TransactionDetail } from "@/db/ledger";
import type { RulePreview } from "@/db/rules";
import { fieldLabel } from "@/db/ledger-mutations";
import { fromLocalInput, toLocalInput } from "@/lib/format";
import { TRANSACTION_TYPES, TYPE_LABELS } from "@/lib/ledger-filters";
import { addMonths, civilShort, cycleName, periodStart } from "@/lib/periods";
import { ruleFromTransaction } from "@/lib/rules";

import { RuleOffer } from "./rule-offer";
import { SplitEditor } from "./split-editor";
import type { useLedgerMutations } from "./use-ledger";

const field =
  "mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

export function TransactionSheet({
  row,
  facets,
  mutations,
  onClose,
}: {
  row: LedgerRow | null;
  facets: Facets;
  mutations: ReturnType<typeof useLedgerMutations>;
  onClose: () => void;
}) {
  const id = row?.id ?? null;

  const detail = useQuery({
    queryKey: ["transaction", id],
    enabled: id !== null,
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/ledger/${id}`, { signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "That transaction could not be loaded.");
      return body as TransactionDetail;
    },
  });

  const label = row ? (row.merchantRaw ?? row.biller ?? row.description ?? row.type) : "";

  return (
    <Sheet open={row !== null} onClose={onClose} title={label}>
      {row === null ? null : detail.isPending ? (
        <div className="flex justify-center py-10">
          <Loader size={36} label="Loading the transaction" />
        </div>
      ) : detail.isError ? (
        <p className="py-6 text-sm text-rose-600 dark:text-rose-400">
          {detail.error instanceof Error ? detail.error.message : String(detail.error)}
        </p>
      ) : (
        <Body
          key={row.id}
          detail={detail.data}
          facets={facets}
          mutations={mutations}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function Body({
  detail,
  facets,
  mutations,
  onClose,
}: {
  detail: TransactionDetail;
  facets: Facets;
  mutations: ReturnType<typeof useLedgerMutations>;
  onClose: () => void;
}) {
  const row = detail.row;
  const locked = new Set(row.lockedFields);

  return (
    <div className="pb-2">
      <RawMessage detail={detail} />

      <CategoryField detail={detail} facets={facets} mutations={mutations} locked={locked} />

      <Fields detail={detail} facets={facets} mutations={mutations} locked={locked} />

      {detail.fx.originalCurrency && <FxProvenance fx={detail.fx} amount={row.amount} />}

      <Splits detail={detail} facets={facets} mutations={mutations} />

      <Actions detail={detail} mutations={mutations} onClose={onClose} />
    </div>
  );
}

/* --------------------------------------------------------------- the source */

function RawMessage({ detail }: { detail: TransactionDetail }) {
  if (!detail.raw) {
    return (
      <p className="-mt-1 rounded-lg border border-black/10 px-3 py-2 text-xs opacity-60 dark:border-white/15">
        Typed in by hand — there is no message behind this one. A replay will never touch it
        (§9.4).
      </p>
    );
  }

  return (
    <section className="-mt-1">
      <div className="flex items-baseline justify-between text-[11px] opacity-50">
        <span>{detail.raw.sender}</span>
        <span className="tabular">
          {new Date(detail.raw.receivedAt).toLocaleString("en-GB", {
            timeZone: "Asia/Riyadh",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
      </div>

      {/* Verbatim, and never truncated. Every field below is derived from these
          few lines; a message shown in part is a source you cannot check. */}
      <pre className="sms-body mt-1 rounded-lg bg-black/[0.04] px-3 py-2.5 text-xs leading-relaxed dark:bg-white/[0.06]">
        {detail.raw.body}
      </pre>
    </section>
  );
}

/* ------------------------------------------------------------------ locks */

function Lock({
  column,
  locked,
  id,
  mutations,
}: {
  column: string;
  locked: boolean;
  id: string;
  mutations: ReturnType<typeof useLedgerMutations>;
}) {
  if (!locked) return null;

  return (
    <button
      type="button"
      onClick={() => mutations.unlock.mutate({ id, column })}
      title={`${fieldLabel(column)} was edited by hand, so a replay leaves it alone. Tap to unlock and let the parser have it back.`}
      className="ml-1 text-[10px] opacity-60 hover:opacity-100"
      aria-label={`${fieldLabel(column)} is locked. Unlock it.`}
    >
      🔒
    </button>
  );
}

function FieldLabel({
  column,
  label,
  hint,
  locked,
  id,
  mutations,
  children,
}: {
  column: string;
  label: string;
  hint?: string;
  locked: Set<string>;
  id: string;
  mutations: ReturnType<typeof useLedgerMutations>;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs">
      <span className="opacity-70">{label}</span>
      {hint && <span className="ml-1 opacity-40">{hint}</span>}
      <Lock column={column} locked={locked.has(column)} id={id} mutations={mutations} />
      {children}
    </label>
  );
}

/* --------------------------------------------------------------- category */

function CategoryField({
  detail,
  facets,
  mutations,
  locked,
}: {
  detail: TransactionDetail;
  facets: Facets;
  mutations: ReturnType<typeof useLedgerMutations>;
  locked: Set<string>;
}) {
  const row = detail.row;
  const [saved, setSaved] = useState<{ ruleId: string; preview: RulePreview } | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [offering, setOffering] = useState<{ id: string; name: string } | null>(null);

  const split = detail.splits.length > 0;

  // A merchant or biller to key a rule on. Without one there is nothing to
  // generalise from, and a rule with no condition would match everything.
  const keyable = row.merchantRaw ?? row.biller;

  if (split) {
    return (
      <p className="mt-4 text-xs opacity-60">
        Categorized across {detail.splits.length} categories below, not on the row.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <FieldLabel
        column="category_id"
        label="Category"
        locked={locked}
        id={row.id}
        mutations={mutations}
      >
        <select
          value={row.categoryId ?? ""}
          onChange={(e) => {
            const categoryId = e.target.value || null;
            const category = facets.categories.find((c) => c.id === categoryId);

            // Saves on change, not on submit. This is the edit made most often
            // and the one that should cost a single tap.
            mutations.edit.mutate({
              id: row.id,
              patch: { categoryId },
              optimistic: { categoryId, categoryName: category?.name ?? null },
            });

            setSaved(null);
            setApplied(null);
            setOffering(categoryId && category ? { id: categoryId, name: category.name } : null);
          }}
          className={field}
        >
          <option value="">Uncategorized</option>
          {facets.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
            </option>
          ))}
        </select>
      </FieldLabel>

      {row.matchedRuleName && !offering && (
        <p className="mt-1 text-[11px] opacity-55">
          Categorized by rule: <span className="sms-body">{row.matchedRuleName}</span>
        </p>
      )}

      {offering && keyable && (
        <RuleOffer
          draft={
            ruleFromTransaction(
              { merchantRaw: row.merchantRaw, biller: row.biller },
              offering.id,
              offering.name,
            )!
          }
          saved={saved}
          saving={mutations.rule.isPending}
          applying={mutations.applyRuleToHistory.isPending}
          applied={applied}
          onCreate={() => {
            const draft = ruleFromTransaction(
              { merchantRaw: row.merchantRaw, biller: row.biller },
              offering.id,
              offering.name,
            );
            if (draft) mutations.rule.mutate(draft, { onSuccess: setSaved });
          }}
          onApply={(ruleId) =>
            mutations.applyRuleToHistory.mutate(
              { ruleId },
              { onSuccess: (result) => setApplied(result.applied) },
            )
          }
          onDismiss={() => {
            setOffering(null);
            setSaved(null);
            setApplied(null);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- fields */

const EDITABLE = [
  "accountId",
  "postedAt",
  "amount",
  "direction",
  "type",
  "merchantRaw",
  "biller",
  "description",
  "notes",
] as const;

type Draft = Record<(typeof EDITABLE)[number], string>;

function draftOf(row: LedgerRow): Draft {
  return {
    accountId: row.accountId,
    postedAt: toLocalInput(new Date(row.postedAt)),
    amount: row.amount,
    direction: row.direction,
    type: row.type,
    merchantRaw: row.merchantRaw ?? "",
    biller: row.biller ?? "",
    description: row.description ?? "",
    notes: row.notes ?? "",
  };
}

function Fields({
  detail,
  facets,
  mutations,
  locked,
}: {
  detail: TransactionDetail;
  facets: Facets;
  mutations: ReturnType<typeof useLedgerMutations>;
  locked: Set<string>;
}) {
  const row = detail.row;
  const base = draftOf(row);

  const [draft, setDraft] = useState<Draft>(base);

  // The row is re-fetched after every save, and the form has to follow it —
  // otherwise a value written by a rule, a bulk action or the parser while the
  // sheet sat open would be silently re-asserted by the next Save.
  //
  // Keyed on the VALUES, not on the row object: a refetch hands back a new
  // object every time, and resetting on identity would wipe out whatever was
  // being typed each time one landed. Adjusted during render rather than in an
  // effect, which is what React asks for here — an effect would render the
  // stale draft once before correcting it.
  const signature = JSON.stringify(base);
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setDraft(base);
  }

  const set = (key: keyof Draft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const dirty = EDITABLE.filter((key) => draft[key] !== base[key]);

  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const key of dirty) {
      if (key === "postedAt") {
        const when = fromLocalInput(draft.postedAt);
        if (when) patch.postedAt = when;
        continue;
      }
      // An emptied text field means "there is no value here", not "".
      patch[key] =
        key === "merchantRaw" || key === "biller" || key === "description" || key === "notes"
          ? draft[key].trim() || null
          : draft[key];
    }

    mutations.edit.mutate({
      id: row.id,
      patch,
      optimistic: {
        amount: patch.amount as string | undefined,
        merchantRaw: (patch.merchantRaw as string | null) ?? row.merchantRaw,
        biller: (patch.biller as string | null) ?? row.biller,
        description: (patch.description as string | null) ?? row.description,
        notes: (patch.notes as string | null) ?? row.notes,
        direction: patch.direction as "debit" | "credit" | undefined,
        type: patch.type as string | undefined,
      },
    });
  };

  return (
    <div className="mt-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <FieldLabel
            column="account_id"
            label="Account"
            locked={locked}
            id={row.id}
            mutations={mutations}
          >
            <select
              value={draft.accountId}
              onChange={(e) => set("accountId", e.target.value)}
              className={field}
            >
              {facets.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </FieldLabel>
        </div>

        <div className="col-span-2">
          <FieldLabel
            column="posted_at"
            label="Posted"
            hint="local time"
            locked={locked}
            id={row.id}
            mutations={mutations}
          >
            <input
              type="datetime-local"
              value={draft.postedAt}
              onChange={(e) => set("postedAt", e.target.value)}
              className={`${field} tabular`}
            />
          </FieldLabel>
        </div>

        <FieldLabel
          column="amount"
          label="Amount"
          hint="SAR"
          locked={locked}
          id={row.id}
          mutations={mutations}
        >
          <input
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
            className={`${field} tabular`}
          />
        </FieldLabel>

        <FieldLabel
          column="direction"
          label="Direction"
          locked={locked}
          id={row.id}
          mutations={mutations}
        >
          <select
            value={draft.direction}
            onChange={(e) => set("direction", e.target.value)}
            className={field}
          >
            <option value="debit">Money out</option>
            <option value="credit">Money in</option>
          </select>
        </FieldLabel>

        <div className="col-span-2">
          <FieldLabel column="type" label="Type" locked={locked} id={row.id} mutations={mutations}>
            <select
              value={draft.type}
              onChange={(e) => set("type", e.target.value)}
              className={field}
            >
              {TRANSACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FieldLabel>
        </div>

        <FieldLabel
          column="merchant_raw"
          label="Merchant"
          locked={locked}
          id={row.id}
          mutations={mutations}
        >
          <input
            type="text"
            dir="auto"
            value={draft.merchantRaw}
            onChange={(e) => set("merchantRaw", e.target.value)}
            className={`${field} sms-body`}
          />
        </FieldLabel>

        <FieldLabel
          column="biller"
          label="Biller"
          hint="SADAD"
          locked={locked}
          id={row.id}
          mutations={mutations}
        >
          <input
            type="text"
            dir="auto"
            value={draft.biller}
            onChange={(e) => set("biller", e.target.value)}
            className={`${field} sms-body`}
          />
        </FieldLabel>

        <div className="col-span-2">
          <FieldLabel
            column="description"
            label="Description"
            locked={locked}
            id={row.id}
            mutations={mutations}
          >
            <input
              type="text"
              dir="auto"
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              className={`${field} sms-body`}
            />
          </FieldLabel>
        </div>

        <div className="col-span-2">
          <FieldLabel
            column="notes"
            label="Notes"
            hint="yours, never parsed"
            locked={locked}
            id={row.id}
            mutations={mutations}
          >
            <input
              type="text"
              dir="auto"
              value={draft.notes}
              onChange={(e) => set("notes", e.target.value)}
              className={`${field} sms-body`}
            />
          </FieldLabel>
        </div>
      </div>

      {dirty.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={mutations.edit.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
          >
            {mutations.edit.isPending && (
              <Loader size={16} variant="arrows" label="Saving the transaction" />
            )}
            {mutations.edit.isPending ? "Saving…" : `Save ${dirty.length}`}
          </button>
          <button
            type="button"
            onClick={() => setDraft(base)}
            className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
          >
            Discard
          </button>
          <p className="text-[11px] opacity-50">
            Saving locks {dirty.length === 1 ? "this field" : "these fields"} against the next
            replay.
          </p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- fx */

function FxProvenance({
  fx,
  amount,
}: {
  fx: TransactionDetail["fx"];
  amount: string;
}) {
  return (
    <section className="mt-4 rounded-lg border border-black/10 p-3 text-xs dark:border-white/15">
      <h3 className="font-medium">Foreign purchase</h3>
      <p className="mt-1 opacity-55">
        Read from the message and not editable — this is what the bank stated, and §7.6 takes the
        total due rather than the subtotal, so the {amount} above already includes the fee.
      </p>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {fx.originalAmount && (
          <Pair
            k="Original"
            v={`${fx.originalAmount} ${fx.originalCurrency ?? ""}`.trim()}
          />
        )}
        {fx.fxRate && <Pair k="Rate" v={fx.fxRate} />}
        {fx.feeAmount && <Pair k="Fee and tax" v={fx.feeAmount} />}
        {fx.country && <Pair k="Country" v={fx.country} />}
      </dl>
    </section>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="opacity-55">{k}</dt>
      <dd className="tabular text-right">{v}</dd>
    </>
  );
}

/* ---------------------------------------------------------------- splits */

function Splits({
  detail,
  facets,
  mutations,
}: {
  detail: TransactionDetail;
  facets: Facets;
  mutations: ReturnType<typeof useLedgerMutations>;
}) {
  const [editing, setEditing] = useState(false);
  const row = detail.row;

  return (
    <section className="mt-5 border-t border-black/10 pt-4 dark:border-white/10">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold tracking-wide uppercase opacity-60">Split</h3>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs opacity-60 hover:opacity-100"
          >
            {detail.splits.length > 0 ? "Change" : "Split across categories"}
          </button>
        )}
      </div>

      {detail.splits.length > 0 && !editing && (
        <ul className="mt-2 space-y-1">
          {detail.splits.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between text-sm">
              <span className="sms-body min-w-0 truncate">{s.categoryName}</span>
              <Money value={s.amount} className="shrink-0 text-sm" />
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <SplitEditor
          amount={row.amount}
          categories={facets.categories}
          initial={detail.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount }))}
          saving={mutations.splits.isPending}
          onSave={(splits) => {
            mutations.splits.mutate({ id: row.id, splits });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {detail.splits.length === 0 && !editing && (
        <p className="mt-1 text-xs opacity-50">
          Categorized on the row. A split divides the amount across several categories; it still
          counts once in every total.
        </p>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- actions */

function Actions({
  detail,
  mutations,
  onClose,
}: {
  detail: TransactionDetail;
  mutations: ReturnType<typeof useLedgerMutations>;
  onClose: () => void;
}) {
  const row = detail.row;
  const [confirming, setConfirming] = useState<"delete" | "manual" | null>(null);

  const postedDay = row.localDay;
  const here = periodStart(postedDay);
  const previous = addMonths(here, -1);
  const next = addMonths(here, 1);
  const current = row.cycleOverride ?? here;

  return (
    <section className="mt-5 border-t border-black/10 pt-4 dark:border-white/10">
      <h3 className="text-xs font-semibold tracking-wide uppercase opacity-60">Actions</h3>

      <div className="mt-2 flex flex-wrap gap-2">
        <Action
          onClick={() =>
            mutations.edit.mutate({
              id: row.id,
              patch: { isInternalTransfer: !row.isInternal },
              optimistic: { isInternal: !row.isInternal },
            })
          }
        >
          {row.isInternal ? "Not an internal transfer" : "Mark internal transfer"}
        </Action>

        <Action
          onClick={() =>
            mutations.edit.mutate({
              id: row.id,
              patch: { excludedFromAnalytics: !row.excluded },
              optimistic: { excluded: !row.excluded },
            })
          }
        >
          {row.excluded ? "Include in analytics" : "Exclude from analytics"}
        </Action>

        {row.origin !== "manual" && (
          <Action onClick={() => setConfirming(confirming === "manual" ? null : "manual")}>
            Convert to manual
          </Action>
        )}

        <Action danger onClick={() => setConfirming(confirming === "delete" ? null : "delete")}>
          Delete
        </Action>
      </div>

      <p className="mt-2 text-[11px] opacity-50">
        An internal transfer stays in this list and counts toward no total — moving your own money
        between your own accounts is not spending (§6).
      </p>

      {/* §5.6 — the manual escape hatch. Neighbours only: past that it is not a
          payday-drift correction, it is a transaction filed under a month it has
          nothing to do with. */}
      <div className="mt-4">
        <h4 className="text-xs font-medium opacity-70">
          Cycle{" "}
          <span className="opacity-55">
            — currently {cycleName(current)}
            {row.cycleOverride ? ", moved by hand" : ""}
          </span>
        </h4>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Action
            onClick={() =>
              mutations.cycle.mutate({ id: row.id, postedDay, cycleStart: previous })
            }
          >
            ← {cycleName(previous)}
          </Action>
          {row.cycleOverride && (
            <Action
              onClick={() => mutations.cycle.mutate({ id: row.id, postedDay, cycleStart: null })}
            >
              Back to {cycleName(here)}
            </Action>
          )}
          <Action
            onClick={() => mutations.cycle.mutate({ id: row.id, postedDay, cycleStart: next })}
          >
            {cycleName(next)} →
          </Action>
        </div>
        <p className="mt-1.5 text-[11px] opacity-50">
          Moves which cycle this funds. Its week does not move — a week is a literal date range,
          so this stays in the week beginning {civilShort(row.localDay)}&rsquo;s Sunday.
        </p>
      </div>

      {confirming === "manual" && (
        <Confirm
          title="Convert to a manual transaction?"
          body={
            <>
              A manual transaction is skipped by replay entirely, rather than negotiating field by
              field with its lock list. The message it came from stays linked — it is still where
              this came from.
            </>
          }
          label="Convert"
          pending={mutations.convert.isPending}
          onConfirm={() => {
            mutations.convert.mutate({ id: row.id });
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === "delete" && (
        <Confirm
          danger
          title="Delete this transaction?"
          body={
            <>
              {detail.raw ? (
                <>
                  The message it came from is kept but marked ignored, so the next parser tick
                  does not book it again (§9.4).{" "}
                  {detail.siblingLegs > 0 && (
                    <strong className="font-semibold">
                      {detail.siblingLegs === 1
                        ? "One other transaction came from that same message and will stop being re-derived too."
                        : `${detail.siblingLegs} other transactions came from that same message and will stop being re-derived too.`}
                    </strong>
                  )}
                </>
              ) : (
                <>There is no message behind this one, so nothing else is affected.</>
              )}{" "}
              Balances on the account are recomputed immediately.
            </>
          }
          label="Delete"
          pending={mutations.remove.isPending}
          onConfirm={() => {
            mutations.remove.mutate({ id: row.id });
            setConfirming(null);
            onClose();
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

function Action({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-xs ${
        danger
          ? "border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
          : "border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function Confirm({
  title,
  body,
  label,
  danger,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  label: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={`mt-3 rounded-lg border p-3 text-xs ${
        danger ? "border-rose-500/40 bg-rose-500/5" : "border-black/12 dark:border-white/18"
      }`}
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 opacity-70">{body}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 disabled:opacity-50 ${
            danger
              ? "border-rose-500/50 text-rose-700 hover:bg-rose-500/10 dark:text-rose-300"
              : "border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          }`}
        >
          {pending && <Loader size={14} variant="arrows" label="Working" />}
          {label}
        </button>
        <button type="button" onClick={onCancel} className="px-2 py-1.5 opacity-60 hover:opacity-100">
          Cancel
        </button>
      </div>
    </div>
  );
}
