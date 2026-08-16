"use client";

/**
 * The client cache and every mutation that writes through it.
 *
 * Optimistic, with a visible rollback. §11.1 aside, the reason is simple: this
 * is a finance app being used one-handed on a phone, and an edit that appears
 * to work and silently didn't is worse than one that takes a second. So every
 * mutation here patches the list immediately, and on failure puts the old value
 * back AND says what happened. Neither half is optional — a row that snaps back
 * with no message reads as a rendering bug, and a message with no snap-back
 * leaves a figure on screen that is not in the database.
 *
 * Server actions return `{ok: false, error}` rather than throwing, so every
 * mutationFn here re-throws that error. Otherwise React Query would treat a
 * refused edit as a success and leave the optimistic value in place — which is
 * exactly the silent-drop failure this file exists to prevent.
 */

import {
  type InfiniteData,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { LedgerPage, LedgerRow } from "@/db/ledger";
import type { BulkPatch, ManualInput, SplitInput, TransactionPatch } from "@/db/ledger-mutations";
import type { RuleDraft } from "@/lib/rules";

import {
  addManual,
  bulkApply,
  moveCycle,
  removeTransaction,
  runRule,
  saveRule,
  saveTransaction,
  saveTransactionSplits,
  toManual,
  unlockTransactionField,
} from "./actions";

export type ListKey = readonly ["ledger", string];

type Cached = InfiniteData<LedgerPage> | undefined;

export function useLedgerCache(listKey: string) {
  const qc = useQueryClient();
  const key: ListKey = ["ledger", listKey];

  return {
    key,
    cancel: () => qc.cancelQueries({ queryKey: key }),
    snapshot: () => qc.getQueryData<InfiniteData<LedgerPage>>(key),
    restore: (snap: Cached) => qc.setQueryData(key, snap),

    /** Patch one row wherever it is, across every loaded page. */
    patch: (id: string, patch: Partial<LedgerRow>) =>
      qc.setQueryData<InfiniteData<LedgerPage>>(key, (old) =>
        !old
          ? old
          : {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                rows: page.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
              })),
            },
      ),

    patchMany: (ids: string[], patch: Partial<LedgerRow>) =>
      qc.setQueryData<InfiniteData<LedgerPage>>(key, (old) =>
        !old
          ? old
          : {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                rows: page.rows.map((row) => (ids.includes(row.id) ? { ...row, ...patch } : row)),
              })),
            },
      ),

    /** Drop a row on delete. The day subtotals it carried are left as they are
     *  until the refetch lands — recomputing them here would mean a second,
     *  approximate implementation of §6 living in the browser. */
    drop: (id: string) =>
      qc.setQueryData<InfiniteData<LedgerPage>>(key, (old) =>
        !old
          ? old
          : {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                rows: page.rows.filter((row) => row.id !== id),
              })),
            },
      ),

    /** Every ledger query, not just this filter: an edit changes what other
     *  filtered views contain, and a stale one is a wrong answer waiting behind
     *  a chip. */
    invalidate: () => qc.invalidateQueries({ queryKey: ["ledger"] }),
    invalidateDetail: (id: string) => qc.invalidateQueries({ queryKey: ["transaction", id] }),
  };
}

export type LedgerMutations = ReturnType<typeof useLedgerMutations>;

export function useLedgerMutations(listKey: string) {
  const cache = useLedgerCache(listKey);
  const [failure, setFailure] = useState<string | null>(null);
  const clearFailure = useCallback(() => setFailure(null), []);

  /** Shared shape: snapshot, patch, and put it back if the server refuses. */
  const rollback = {
    onMutate: async (optimistic: () => void) => {
      await cache.cancel();
      const snap = cache.snapshot();
      optimistic();
      return snap;
    },
    onError: (error: Error, snap: Cached) => {
      cache.restore(snap);
      setFailure(error.message);
    },
  };

  const edit = useMutation({
    mutationFn: async (vars: {
      id: string;
      patch: TransactionPatch;
      optimistic?: Partial<LedgerRow>;
    }) => {
      const result = await saveTransaction(vars.id, vars.patch);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) => rollback.onMutate(() => cache.patch(vars.id, vars.optimistic ?? {})),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSuccess: (outcome) => {
      // The authoritative lock list, so the sheet's lock markers come from what
      // was written rather than from what the client guessed.
      cache.patch(outcome.id, { lockedFields: outcome.locked });
      setFailure(null);
    },
    onSettled: (_data, _error, vars) => {
      cache.invalidate();
      cache.invalidateDetail(vars.id);
    },
  });

  const unlock = useMutation({
    mutationFn: async (vars: { id: string; column: string }) => {
      const result = await unlockTransactionField(vars.id, vars.column);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) =>
      rollback.onMutate(() => {
        const row = cache
          .snapshot()
          ?.pages.flatMap((p) => p.rows)
          .find((r) => r.id === vars.id);
        if (row) {
          cache.patch(vars.id, { lockedFields: row.lockedFields.filter((f) => f !== vars.column) });
        }
      }),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSettled: (_d, _e, vars) => {
      cache.invalidate();
      cache.invalidateDetail(vars.id);
    },
  });

  const splits = useMutation({
    mutationFn: async (vars: { id: string; splits: SplitInput[] }) => {
      const result = await saveTransactionSplits(vars.id, vars.splits);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) =>
      rollback.onMutate(() =>
        cache.patch(vars.id, {
          splitCount: vars.splits.length,
          categoryId: null,
          categoryName: vars.splits.length > 0 ? "Split" : null,
        }),
      ),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSettled: (_d, _e, vars) => {
      cache.invalidate();
      cache.invalidateDetail(vars.id);
    },
  });

  const cycle = useMutation({
    mutationFn: async (vars: { id: string; postedDay: string; cycleStart: string | null }) => {
      const result = await moveCycle(vars.id, vars.postedDay, vars.cycleStart);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) =>
      rollback.onMutate(() => cache.patch(vars.id, { cycleOverride: vars.cycleStart })),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSettled: (_d, _e, vars) => {
      cache.invalidate();
      cache.invalidateDetail(vars.id);
    },
  });

  const remove = useMutation({
    mutationFn: async (vars: { id: string }) => {
      const result = await removeTransaction(vars.id);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) => rollback.onMutate(() => cache.drop(vars.id)),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSettled: () => cache.invalidate(),
  });

  const bulk = useMutation({
    mutationFn: async (vars: {
      ids: string[];
      patch: BulkPatch;
      optimistic?: Partial<LedgerRow>;
    }) => {
      const result = await bulkApply(vars.ids, vars.patch);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) =>
      rollback.onMutate(() => cache.patchMany(vars.ids, vars.optimistic ?? {})),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSettled: () => cache.invalidate(),
  });

  const manual = useMutation({
    mutationFn: async (vars: ManualInput) => {
      const result = await addManual(vars);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    // Not optimistic: a new row's place in the list depends on its posting date
    // and on a day subtotal computed in SQL, and a client that guesses either
    // shows the transaction in the wrong day for as long as the refetch takes.
    onError: (error: Error) => setFailure(error.message),
    onSettled: () => cache.invalidate(),
  });

  const convert = useMutation({
    mutationFn: async (vars: { id: string }) => {
      const result = await toManual(vars.id);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onMutate: (vars) => rollback.onMutate(() => cache.patch(vars.id, { origin: "manual" })),
    onError: (error, _vars, snap) => rollback.onError(error, snap),
    onSettled: (_d, _e, vars) => {
      cache.invalidate();
      cache.invalidateDetail(vars.id);
    },
  });

  /** Writes the rule and returns its dry run. Applies nothing (§11.1). */
  const rule = useMutation({
    mutationFn: async (draft: RuleDraft) => {
      const result = await saveRule(draft);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onError: (error: Error) => setFailure(error.message),
  });

  /** The separate, explicit apply. */
  const applyRuleToHistory = useMutation({
    mutationFn: async (vars: { ruleId: string }) => {
      const result = await runRule(vars.ruleId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    onError: (error: Error) => setFailure(error.message),
    onSettled: () => cache.invalidate(),
  });

  return {
    cache,
    failure,
    clearFailure,
    edit,
    unlock,
    splits,
    cycle,
    remove,
    bulk,
    manual,
    convert,
    rule,
    applyRuleToHistory,
  };
}
