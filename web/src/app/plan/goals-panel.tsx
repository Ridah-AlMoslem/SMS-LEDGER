"use client";

/**
 * Savings goals — SPEC §11.2.
 *
 * "Goals are virtual buckets over a real account. Progress reads from the linked
 * account's actual balance, not a separate counter, so a withdrawal reduces goal
 * progress automatically and the number can never drift from reality."
 *
 * Which means this panel has nothing to update and nothing to reconcile: every
 * figure on it is derived, on render, from `accounts.current_balance` — itself
 * derived from the posted legs (§3.3). The only stored number is the allocation,
 * because that is the part a person decides.
 *
 * The account line above each group is not decoration. §11.2 requires the
 * unallocated remainder to be displayed always, and it is the only place the
 * over-allocated case can be shown honestly: when the balance falls below the
 * sum of the buckets, every goal's progress drops in proportion and the
 * shortfall is named rather than absorbed.
 */

import { useOptimistic, useState, useTransition } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import { Sheet } from "@/components/ui/sheet";
import { type Bucket, type Goal, type GoalView, bucketsFor, viewGoal } from "@/lib/goals";
import { type CivilDate, civilShort } from "@/lib/periods";

import { removeGoal, storeGoal } from "./actions";

export type GoalAccount = {
  id: string;
  name: string;
  institution: string;
  balance: number;
  /** Mean net contribution per completed cycle. null with no history. */
  runRate: number | null;
};

export function GoalsPanel({
  goals,
  accounts,
  now,
  cycleLabel,
}: {
  goals: Goal[];
  /** Only accounts a goal can sit over: liabilities are excluded upstream,
   *  because on a card the balance is available credit and a goal reading that
   *  as progress would fill up as the card was spent (§3.3a). */
  accounts: GoalAccount[];
  now: CivilDate;
  cycleLabel: string;
}) {
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Same optimistic-with-visible-rollback rule as the budget rows: the patch is
  // dropped when the transition ends, so a refused save snaps back, and the
  // message beside it says why.
  const [optimistic, patch] = useOptimistic(
    goals,
    (current: Goal[], change: { id: string; remove?: boolean } & Partial<Goal>) =>
      change.remove
        ? current.filter((g) => g.id !== change.id)
        : current.map((g) => (g.id === change.id ? { ...g, ...change } : g)),
  );

  const balances = new Map(accounts.map((a) => [a.id, a.balance]));
  const buckets = bucketsFor(optimistic, balances);

  const views: GoalView[] = optimistic.map((g) =>
    viewGoal(g, g.accountId ? buckets.get(g.accountId) : undefined, {
      now,
      accountRunRate: accounts.find((a) => a.id === g.accountId)?.runRate ?? null,
    }),
  );

  const grouped = accounts
    .map((account) => ({
      account,
      bucket: buckets.get(account.id),
      goals: views.filter((v) => v.accountId === account.id),
    }))
    .filter((g) => g.goals.length > 0);

  const orphans = views.filter((v) => !v.accountId);

  const run = (
    change: { id: string; remove?: boolean } & Partial<Goal>,
    action: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setFailure(null);
    startTransition(async () => {
      patch(change);
      const result = await action();
      if (!result.ok) setFailure(result.error ?? "That change was refused.");
    });
  };

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Goals</h2>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="text-xs font-medium underline underline-offset-2"
          disabled={accounts.length === 0}
        >
          Add a goal
        </button>
      </div>

      {failure && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {failure}
        </p>
      )}

      {accounts.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="No account to save into"
          body="A goal is a bucket over a real account, so it needs one that holds money — not a card or a loan. Add or activate a savings account first."
        />
      ) : views.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="No goals yet"
          body="A goal earmarks part of an account you already have. Progress is read from that account's balance, so it falls when you withdraw and can never drift from what the bank says."
        />
      ) : (
        <div className="mt-4 space-y-6">
          {grouped.map(({ account, bucket, goals: rows }) => (
            <div key={account.id}>
              <AccountLine account={account} bucket={bucket} />
              <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
                {rows.map((view) => (
                  <GoalRow
                    key={view.id}
                    view={view}
                    cycleLabel={cycleLabel}
                    pending={pending}
                    onEdit={() => setEditing(view)}
                    onDelete={() =>
                      run({ id: view.id, remove: true }, () => removeGoal(view.id))
                    }
                  />
                ))}
              </ul>
            </div>
          ))}

          {orphans.length > 0 && (
            <div>
              <p className="text-xs opacity-60">
                These goals lost their account — it was deleted or deactivated. Progress cannot be
                read from a balance that no longer exists, so they show none until they are
                relinked.
              </p>
              <ul className="mt-2 divide-y divide-black/5 dark:divide-white/10">
                {orphans.map((view) => (
                  <GoalRow
                    key={view.id}
                    view={view}
                    cycleLabel={cycleLabel}
                    pending={pending}
                    onEdit={() => setEditing(view)}
                    onDelete={() => run({ id: view.id, remove: true }, () => removeGoal(view.id))}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <GoalSheet
        open={editing !== null}
        goal={editing === "new" ? null : editing}
        accounts={accounts}
        goals={optimistic}
        onClose={() => setEditing(null)}
        onSaved={(error) => {
          if (error) setFailure(error);
          else setFailure(null);
        }}
      />
    </section>
  );
}

/* -------------------------------------------------------------- account line */

function AccountLine({ account, bucket }: { account: GoalAccount; bucket: Bucket | undefined }) {
  const allocated = bucket?.allocated ?? 0;
  const remainder = bucket?.remainder ?? account.balance;
  const over = bucket?.overAllocated ?? false;

  return (
    <div className="rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.06]">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">{account.name}</p>
        <p className="text-sm">
          <Money value={account.balance} />
        </p>
      </div>
      <p className="mt-1 text-xs opacity-60">
        <Money value={allocated} /> allocated ·{" "}
        <span className={over ? "text-rose-600 dark:text-rose-400" : ""}>
          <Money value={remainder} sign="always" /> unallocated
        </span>
        {account.runRate !== null && (
          <>
            {" · "}
            <Money value={account.runRate} sign="always" /> per cycle lately
          </>
        )}
      </p>
      {over && (
        <p className="mt-1.5 text-xs text-rose-700 dark:text-rose-300">
          The goals on this account claim <Money value={allocated} /> but it holds{" "}
          <Money value={account.balance} />. Nothing is wrong with the goals — money left the
          account — so every one of them is showing its share of what is actually there, which is
          less than it was allocated.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- a goal */

function GoalRow({
  view,
  cycleLabel,
  pending,
  onEdit,
  onDelete,
}: {
  view: GoalView;
  cycleLabel: string;
  pending: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const done = view.remaining === 0;
  const width = Math.min(Math.max(view.progress, 0), 1) * 100;

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">
          <span className="sms-body">{view.name}</span>
        </p>
        <p className="shrink-0 text-sm">
          <Money value={view.funded} />
          <span className="opacity-50">
            {" / "}
            <Money value={view.targetAmount} />
          </span>
        </p>
      </div>

      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.10]">
        <div
          className={`h-full rounded-full ${done ? "bg-emerald-500" : "bg-foreground/60"}`}
          style={{ width: `${width}%` }}
        />
      </div>

      <p className="mt-1 text-xs opacity-55">
        <span className="tabular">{Math.round(view.progress * 100)}%</span>
        {view.funded !== view.allocation && (
          <>
            {" · "}
            <Money value={view.allocation} /> allocated,{" "}
            <span className="text-rose-600 dark:text-rose-400">
              only <Money value={view.funded} /> in the account
            </span>
          </>
        )}
        {view.targetDate && (
          <>
            {" · by "}
            {civilShort(view.targetDate)}
          </>
        )}
      </p>

      {view.requiredPerCycle !== null && !done && (
        <p className="mt-1 text-xs">
          <span className="opacity-55">
            needs <Money value={view.requiredPerCycle} /> per cycle
            {view.cyclesLeft !== null && view.cyclesLeft > 0 && (
              <>
                {" over "}
                <span className="tabular">{view.cyclesLeft}</span>
                {view.cyclesLeft === 1 ? " cycle" : " cycles"}
              </>
            )}
          </span>
          {view.overdue ? (
            <span className="text-rose-600 dark:text-rose-400"> · target date has passed</span>
          ) : view.onTrack === true ? (
            <span className="text-emerald-600 dark:text-emerald-400"> · on track at this rate</span>
          ) : view.onTrack === false ? (
            <span className="text-amber-600 dark:text-amber-400">
              {" · "}
              {view.runRate !== null && view.runRate <= 0
                ? "nothing has gone in lately"
                : "the current rate does not get there"}
            </span>
          ) : null}
        </p>
      )}

      {done && (
        <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
          Fully funded as of {cycleLabel}.
        </p>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
        >
          Delete
        </button>
        {pending && <Loader size={14} variant="arrows" label={`Saving ${view.name}`} />}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------- editor */

const field =
  "mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

/**
 * The add/edit sheet.
 *
 * Shows the resulting unallocated remainder as you type, because the rule this
 * form can break — the sum of the buckets exceeding the balance — is invisible
 * from inside a single goal. The server refuses it either way (`db/goals.ts`);
 * this is what stops the refusal being a surprise.
 */
function GoalSheet({
  open,
  goal,
  accounts,
  goals,
  onClose,
  onSaved,
}: {
  open: boolean;
  goal: Goal | null;
  accounts: GoalAccount[];
  goals: Goal[];
  onClose: () => void;
  onSaved: (error: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? goal.targetAmount.toFixed(2) : "");
  const [date, setDate] = useState(goal?.targetDate ?? "");
  const [accountId, setAccountId] = useState(goal?.accountId ?? accounts[0]?.id ?? "");
  const [allocation, setAllocation] = useState(goal ? goal.allocation.toFixed(2) : "0.00");
  const [error, setError] = useState<string | null>(null);

  // Re-seed when a different goal opens the same sheet. `key` on the element
  // would remount it, but this sheet animates in and out — remounting it
  // mid-transition is visible.
  const [seeded, setSeeded] = useState<string | null>(goal?.id ?? null);
  if (open && (goal?.id ?? null) !== seeded) {
    setSeeded(goal?.id ?? null);
    setName(goal?.name ?? "");
    setTarget(goal ? goal.targetAmount.toFixed(2) : "");
    setDate(goal?.targetDate ?? "");
    setAccountId(goal?.accountId ?? accounts[0]?.id ?? "");
    setAllocation(goal ? goal.allocation.toFixed(2) : "0.00");
    setError(null);
  }

  const account = accounts.find((a) => a.id === accountId);
  const claimedByOthers = goals
    .filter((g) => g.accountId === accountId && g.id !== goal?.id)
    .reduce((sum, g) => sum + g.allocation, 0);

  const parsed = Number(allocation);
  const wouldRemain =
    account && Number.isFinite(parsed) ? account.balance - claimedByOthers - parsed : null;

  return (
    <Sheet open={open} onClose={onClose} title={goal ? "Edit goal" : "New goal"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await storeGoal({
              id: goal?.id,
              name,
              targetAmount: target,
              targetDate: date.trim() === "" ? null : date,
              accountId,
              allocation,
            });

            if (result.ok) {
              onSaved(null);
              onClose();
            } else {
              setError(result.error);
              onSaved(null);
            }
          });
        }}
        className="space-y-3 pb-4"
      >
        <label className="block text-xs">
          <span className="opacity-70">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className={`${field} sms-body`}
            placeholder="Emergency fund"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs">
            <span className="opacity-70">Target</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputMode="decimal"
              required
              className={`${field} tabular`}
              placeholder="20000"
            />
          </label>
          <label className="block text-xs">
            <span className="opacity-70">Target date</span>
            <span className="ml-1 opacity-40">optional</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`${field} tabular`}
            />
          </label>
        </div>

        <label className="block text-xs">
          <span className="opacity-70">Account</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={field}
            required
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.institution}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs">
          <span className="opacity-70">Allocated to this goal</span>
          <input
            value={allocation}
            onChange={(e) => setAllocation(e.target.value)}
            inputMode="decimal"
            className={`${field} tabular`}
          />
        </label>

        {account && (
          <p className="text-xs opacity-60">
            {account.name} holds <Money value={account.balance} />.{" "}
            {claimedByOthers > 0 && (
              <>
                <Money value={claimedByOthers} /> is claimed by other goals.{" "}
              </>
            )}
            {wouldRemain !== null && (
              <span className={wouldRemain < 0 ? "text-rose-600 dark:text-rose-400" : ""}>
                <Money value={wouldRemain} sign="always" /> would be left unallocated.
              </span>
            )}
          </p>
        )}

        <p className="text-xs opacity-50">
          Progress is read from the account&apos;s balance, never stored — so a withdrawal lowers it
          the moment the message arrives.
        </p>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
          >
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-[var(--background)] disabled:opacity-50"
          >
            {goal ? "Save goal" : "Create goal"}
          </button>
          {pending && <Loader size={16} variant="arrows" label="Saving goal" />}
        </div>
      </form>
    </Sheet>
  );
}
