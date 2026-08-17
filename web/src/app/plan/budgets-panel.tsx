"use client";

/**
 * The budget rows — SPEC §11.2.
 *
 * **Budgets are set monthly and viewed at both grains.** There is no weekly
 * budget anywhere: the two weekly figures are derived from the cycle budget on
 * this screen, every time, and nothing stores them. That is why this component
 * is handed cycle-scoped rows plus each week's spend, and why switching the
 * global grain flips the rows here without another request — the numbers for
 * both grains are already in the browser, and the week grain is a different
 * arithmetic over the same data rather than a different query.
 *
 * The three things §11.2 asks for that are easy to get wrong, and what this file
 * does about each:
 *
 *   - **base and carry stay separate numbers.** A 2,000 base against a −1,800
 *     carry has 200 to spend, and rendering only the 200 makes an emergency look
 *     like a policy. Both are printed on every row where the carry is non-zero,
 *     with their sign.
 *   - **Never `cycle_budget ÷ 4`.** A cycle averages 4.43 weeks, so a flat
 *     quarter-split understates the allowance by ~10% and leaves you looking
 *     permanently over budget. `pace()` weights by days, and the day count comes
 *     from `weekBucketsInCycle`, which clips the stub weeks at the cycle edges to
 *     their real length (§5.3).
 *   - **remaining_pace leads.** `fair_share` answers "what should this week
 *     cost?"; `remaining_pace` answers "what can I still spend per week without
 *     blowing the cycle?" — the second is the one that changes behaviour, because
 *     it absorbs the overspend already committed.
 *
 * Uncategorized is a first-class row (§11.2), shown with its count and excluded
 * from every pacing figure. Hiding it makes every other number quietly wrong;
 * pacing against it would be pacing against a budget nobody set.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import { StatCard } from "@/components/ui/stat-card";
import { DEFAULT_GRAIN, PERIOD_PARAM, readGrain } from "@/lib/period-params";
import { pace } from "@/lib/pace";
import { type CivilDate, type WeekBucket, periodLabel, weekStart } from "@/lib/periods";

import { clearCarry, saveBudget, toggleRollover } from "./actions";

export type BudgetRowData = {
  categoryId: string;
  name: string;
  icon: string | null;
  /** null when this category has no budget for this cycle. Different from 0,
   *  which is a decision to spend nothing, and displayed differently. */
  base: number | null;
  /** Signed, stored, settled when the previous cycle closed (§11.2). */
  carry: number;
  rollover: boolean;
  /** Whether the carry has been settled — either by a close or by a reset. */
  carrySettled: boolean;
  /** Expense in this cycle. */
  spent: number;
  /** Expense per week bucket, keyed by the bucket's real Sunday. Grouped by
   *  week *within the cycle*, so an edge week's spend and its day-weighted
   *  allowance cover the same days. */
  weekSpend: Record<string, number>;
};

export type UncategorizedRow = { total: number; count: number };

/** A category that could be budgeted. */
export type CategoryOption = { id: string; name: string; icon: string | null };

export function BudgetsPanel({
  rows,
  catalogue,
  uncategorized,
  cycle,
  cycleDays,
  cycleElapsed,
  weeks,
}: {
  rows: BudgetRowData[];
  /**
   * Every non-income category, budgeted or not.
   *
   * A row only exists for a category that has a budget *or* has been spent in,
   * which leaves no way to budget anything else — you could set a Rent budget
   * only after overspending on rent, and on a cycle with no budgets at all the
   * screen would offer nothing to do. This is what the picker at the bottom is
   * drawn from.
   */
  catalogue: CategoryOption[];
  uncategorized: UncategorizedRow;
  cycle: CivilDate;
  cycleDays: number;
  cycleElapsed: number;
  weeks: WeekBucket[];
}) {
  const params = useSearchParams();
  const grain = readGrain(params) ?? DEFAULT_GRAIN;

  // The selected week, read from the same URL parameter the period header
  // writes. At cycle grain the parameter is a cycle anchor, so it is only
  // consulted at week grain — a cycle start pushed through `weekStart()` would
  // silently name whichever week the 25th happened to fall in.
  const anchor = params.get(PERIOD_PARAM);
  const week =
    grain === "week" && anchor ? (weeks.find((w) => w.weekStart === weekStart(anchor)) ?? null) : null;

  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * Optimistic, with a visible rollback — the rule in `web/CLAUDE.md`, applied
   * without React Query (this screen has no client cache; Ledger is the one that
   * does). `useOptimistic` drops the patch when the transition ends, so a
   * refused edit snaps back on its own; the message beside it is the other half.
   * A row that snaps back with no explanation reads as a rendering bug, and a
   * message with no snap-back leaves a figure on screen that is not in the
   * database.
   */
  const [optimistic, patch] = useOptimistic(
    rows,
    (current: BudgetRowData[], change: Partial<BudgetRowData> & { categoryId: string }) =>
      current.map((r) => (r.categoryId === change.categoryId ? { ...r, ...change } : r)),
  );

  const run = (
    change: Partial<BudgetRowData> & { categoryId: string },
    action: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setFailure(null);
    startTransition(async () => {
      patch(change);
      const result = await action();
      if (!result.ok) setFailure(result.error ?? "That change was refused.");
    });
  };

  const budgeted = optimistic.filter((r) => r.base !== null);
  const cycleBudget = budgeted.reduce((sum, r) => sum + (r.base ?? 0) + r.carry, 0);
  const cycleSpent = optimistic.reduce((sum, r) => sum + r.spent, 0);

  const overall = pace({
    budget: budgeted.length > 0 ? cycleBudget : null,
    spent: budgeted.reduce((sum, r) => sum + r.spent, 0),
    elapsed: cycleElapsed,
    total: cycleDays,
    daysInWeek: week?.days ?? 7,
  });

  // Ranked by share of the budget consumed, the way Home's list is: a 300
  // grocery bill against a 2,000 budget is not news, and a 300 coffee habit
  // against a 250 budget is. Unbudgeted categories can only be ranked by size,
  // so they sort below.
  const ordered = [...optimistic].sort((a, b) => {
    const aShare = a.base === null ? -1 : shareOf(a);
    const bShare = b.base === null ? -1 : shareOf(b);
    if (aShare !== bShare) return bShare - aShare;
    return b.spent - a.spent;
  });

  return (
    <section>
      <Headline
        grain={grain}
        week={week}
        weeks={weeks}
        cycle={cycle}
        cycleDays={cycleDays}
        cycleElapsed={cycleElapsed}
        cycleBudget={budgeted.length > 0 ? cycleBudget : null}
        cycleSpent={cycleSpent}
        pace={overall}
        rows={optimistic}
      />

      {failure && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
        >
          {failure}
        </p>
      )}

      {grain === "week" && !week && (
        <p className="mt-3 text-xs opacity-60">
          This week sits outside the cycle these budgets belong to, so the rows below are the
          cycle&apos;s own figures.
        </p>
      )}

      {ordered.length === 0 && (
        <EmptyState
          className="mt-4"
          title="Nothing budgeted this cycle"
          body={
            <>
              Budgets are set per category per cycle — this one runs {cycleDays} days. The weekly
              view is derived from whatever you set here; there is no separate weekly figure to
              keep in step.
            </>
          }
        />
      )}

      <ul className="mt-4 divide-y divide-black/5 dark:divide-white/10">
        {ordered.map((row) => (
          <Row
            key={row.categoryId}
            row={row}
            cycleDays={cycleDays}
            cycleElapsed={cycleElapsed}
            week={grain === "week" ? week : null}
            pending={pending}
            onAmount={(amount) =>
              run({ categoryId: row.categoryId, base: amount === null ? null : Number(amount) }, () =>
                saveBudget(row.categoryId, cycle, amount),
              )
            }
            onRollover={(rollover) =>
              run({ categoryId: row.categoryId, rollover }, () =>
                toggleRollover(row.categoryId, cycle, rollover),
              )
            }
            onResetCarry={() =>
              run({ categoryId: row.categoryId, carry: 0, carrySettled: true }, () =>
                clearCarry(row.categoryId, cycle),
              )
            }
          />
        ))}
      </ul>

      <AddBudget
        categories={catalogue.filter((c) => !optimistic.some((r) => r.categoryId === c.id))}
        pending={pending}
        onSave={(categoryId, amount) => {
          setFailure(null);
          startTransition(async () => {
            // Deliberately not optimistic: a new row has no place in this list
            // until the server answers, because the order is share-of-budget
            // consumed and this row's share is exactly what is being decided.
            // The same reasoning as `manual` in `app/ledger/use-ledger.ts`.
            const result = await saveBudget(categoryId, cycle, amount);
            if (!result.ok) setFailure(result.error ?? "That budget was refused.");
          });
        }}
      />

      <Uncategorized row={uncategorized} />
    </section>
  );
}

/**
 * Budget a category that has no row yet.
 *
 * Without this the screen can only edit budgets that already exist, or ones for
 * categories that have been spent in — so a category you want to *start*
 * controlling is unreachable, and a cycle with no budgets at all offers nothing
 * to do. Which is every cycle, once.
 */
function AddBudget({
  categories,
  pending,
  onSave,
}: {
  categories: CategoryOption[];
  pending: boolean;
  onSave: (categoryId: string, amount: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [amount, setAmount] = useState("");

  if (categories.length === 0) return null;

  // The list shrinks as budgets are added, so a stale selection has to fall back
  // rather than submit an id that is no longer offered.
  const selected = categories.some((c) => c.id === categoryId) ? categoryId : categories[0].id;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 text-xs font-medium underline underline-offset-2"
      >
        Budget another category
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (amount.trim() === "") return;
        onSave(selected, amount.trim());
        setAmount("");
        setOpen(false);
      }}
      className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.06]"
    >
      <select
        value={selected}
        onChange={(e) => setCategoryId(e.target.value)}
        aria-label="Category"
        className="min-w-0 flex-1 rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.icon ? `${c.icon} ` : ""}
            {c.name}
          </option>
        ))}
      </select>

      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aria-label="Monthly budget for a new category"
        placeholder="0.00"
        className="tabular w-24 rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
      />

      <button type="submit" className="text-xs font-medium underline underline-offset-2">
        Add
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs underline underline-offset-2 opacity-60"
      >
        Cancel
      </button>
      {pending && <Loader size={14} variant="arrows" label="Adding budget" />}
    </form>
  );
}

/** spent ÷ effective, uncapped. Infinity when something was spent against a
 *  budget that rollover has driven to zero — a real state, and one worth
 *  sorting to the top. */
function shareOf(row: BudgetRowData): number {
  const effective = (row.base ?? 0) + row.carry;
  if (effective > 0) return row.spent / effective;
  return row.spent > 0 ? Infinity : 0;
}

/* ---------------------------------------------------------------- headline */

function Headline({
  grain,
  week,
  weeks,
  cycle,
  cycleDays,
  cycleElapsed,
  cycleBudget,
  cycleSpent,
  pace: overall,
  rows,
}: {
  grain: "week" | "cycle";
  week: WeekBucket | null;
  weeks: WeekBucket[];
  cycle: CivilDate;
  cycleDays: number;
  cycleElapsed: number;
  cycleBudget: number | null;
  cycleSpent: number;
  pace: ReturnType<typeof pace>;
  rows: BudgetRowData[];
}) {
  if (grain === "week" && week) {
    const spentThisWeek = rows.reduce((sum, r) => sum + (r.weekSpend[week.weekStart] ?? 0), 0);

    return (
      <>
        <div className="grid grid-cols-2 gap-2.5">
          {/* remaining_pace leads. It is the adaptive number, and the one that
              changes behaviour. */}
          <StatCard
            label="Can spend per week"
            value={
              overall.remainingPace === null ? (
                <span className="opacity-40">—</span>
              ) : (
                <Money value={overall.remainingPace} />
              )
            }
            tone={overall.remainingPace !== null && overall.remainingPace < 0 ? "negative" : "default"}
            hint={
              overall.remainingPace === null
                ? "no budget set"
                : `${overall.weeksLeft.toFixed(1)} weeks left in the cycle`
            }
          />
          <StatCard
            label="Fair share this week"
            value={
              overall.fairShare === null ? (
                <span className="opacity-40">—</span>
              ) : (
                <Money value={overall.fairShare} />
              )
            }
            hint={
              <>
                <Money value={spentThisWeek} /> spent
                {week.partial ? ` · ${week.days} of 7 days` : ""}
              </>
            }
          />
        </div>

        <p className="mt-2.5 text-xs opacity-55">
          Weighted by days, never by dividing the cycle into four: this cycle holds{" "}
          <span className="tabular">{(cycleDays / 7).toFixed(2)}</span> weeks across{" "}
          <span className="tabular">{weeks.length}</span> buckets, so a quarter-split would
          understate the allowance by{" "}
          <span className="tabular">{Math.round((cycleDays / 7 / 4 - 1) * 100)}%</span>. Budgets
          themselves are set monthly — {periodLabel("cycle", cycle)}.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <StatCard
          label="Spent this cycle"
          value={<Money value={cycleSpent} />}
          hint={
            cycleBudget === null ? (
              "nothing budgeted yet"
            ) : (
              <>
                of <Money value={cycleBudget} /> effective
              </>
            )
          }
        />
        <StatCard
          label={overall.verdict ?? "Pacing"}
          value={
            overall.spentShare === null || !Number.isFinite(overall.spentShare) ? (
              <span className="opacity-40">—</span>
            ) : (
              <span className="tabular">{Math.round(overall.spentShare * 100)}%</span>
            )
          }
          tone={
            overall.verdict === "Over"
              ? "negative"
              : overall.verdict === "Ahead"
                ? "positive"
                : "default"
          }
          hint={`${Math.round(overall.elapsedShare * 100)}% through — day ${cycleElapsed} of ${cycleDays}`}
        />
      </div>

      <p className="mt-2.5 text-xs opacity-55">
        Paced against the actual length of this cycle — {cycleDays} days, not 30.
      </p>
    </>
  );
}

/* --------------------------------------------------------------------- row */

function Bar({ share, elapsedShare, over }: { share: number; elapsedShare: number; over: boolean }) {
  const width = Math.min(Math.max(share, 0), 1) * 100;

  return (
    <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.10]">
      <div
        className={`h-full rounded-full ${over ? "bg-rose-500" : "bg-foreground/60"}`}
        style={{ width: `${width}%` }}
      />
      {/* Where the calendar is. §11.2 — "60% spent, 40% through the cycle" is
          the number that changes behaviour, and a bar without the second half is
          only the first. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-foreground/45"
        style={{ left: `${Math.min(Math.max(elapsedShare, 0), 1) * 100}%` }}
      />
    </div>
  );
}

function Row({
  row,
  cycleDays,
  cycleElapsed,
  week,
  pending,
  onAmount,
  onRollover,
  onResetCarry,
}: {
  row: BudgetRowData;
  cycleDays: number;
  cycleElapsed: number;
  week: WeekBucket | null;
  pending: boolean;
  onAmount: (amount: string | null) => void;
  onRollover: (rollover: boolean) => void;
  onResetCarry: () => void;
}) {
  const [editing, setEditing] = useState(false);

  const effective = row.base === null ? null : row.base + row.carry;

  const p = pace({
    budget: effective,
    spent: row.spent,
    elapsed: cycleElapsed,
    total: cycleDays,
    daysInWeek: week?.days ?? 7,
  });

  const over = effective !== null && row.spent > effective;
  const projectedOver = effective !== null && !over && p.projected > effective;

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">
          {row.icon && <span aria-hidden="true">{row.icon} </span>}
          <span className="sms-body">{row.name}</span>
        </p>

        {week ? (
          <p className="shrink-0 text-sm">
            <Money value={row.weekSpend[week.weekStart] ?? 0} />
            {p.fairShare !== null && (
              <span className="opacity-50">
                {" / "}
                <Money value={p.fairShare} />
              </span>
            )}
          </p>
        ) : (
          <p className={`shrink-0 text-sm ${over ? "text-rose-600 dark:text-rose-400" : ""}`}>
            <Money value={row.spent} />
            {effective !== null && (
              <span className="opacity-50">
                {" / "}
                <Money value={effective} />
              </span>
            )}
          </p>
        )}
      </div>

      {week ? (
        <WeekFigures row={row} week={week} p={p} />
      ) : effective === null ? (
        <p className="mt-1 text-xs opacity-55">
          No budget · heading for <Money value={p.projected} /> by the end of the cycle
        </p>
      ) : (
        <>
          <Bar share={p.spentShare ?? 0} elapsedShare={p.elapsedShare} over={over} />
          <p className="mt-1 text-xs opacity-55">
            {/* base and carry, as two numbers. Never folded together. */}
            base <Money value={row.base ?? 0} />
            {row.carry !== 0 && (
              <>
                {row.carry > 0 ? " + carry " : " − carry "}
                <Money value={Math.abs(row.carry)} />
              </>
            )}
            {" · "}
            <Money value={Math.max(effective - row.spent, 0)} /> left
            {" · "}
            <span className={projectedOver ? "text-amber-600 dark:text-amber-400" : ""}>
              heading for <Money value={p.projected} />
            </span>
            {over && (
              <span className="text-rose-600 dark:text-rose-400">
                {" · "}
                <Money value={row.spent - effective} /> over
              </span>
            )}
          </p>
        </>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {editing ? (
          <AmountForm
            initial={row.base}
            onCancel={() => setEditing(false)}
            onSave={(amount) => {
              setEditing(false);
              onAmount(amount);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
          >
            {row.base === null ? "Set a budget" : "Edit amount"}
          </button>
        )}

        {row.base !== null && (
          <label className="flex items-center gap-1.5 text-xs opacity-70">
            <input
              type="checkbox"
              checked={row.rollover}
              onChange={(e) => onRollover(e.target.checked)}
              className="h-3.5 w-3.5 accent-current"
            />
            Rollover
          </label>
        )}

        {row.base !== null && row.carry !== 0 && (
          <button
            type="button"
            onClick={onResetCarry}
            className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
            title="Zero the carried balance and settle it, so the next close does not put it back"
          >
            Reset carry
          </button>
        )}

        {pending && <Loader size={14} variant="arrows" label={`Saving ${row.name} budget`} />}
      </div>
    </li>
  );
}

/**
 * §11.2's two derived figures, in the order it asks for them.
 *
 * Both are computed from the cycle budget and nothing is stored. `fair_share`
 * uses the bucket's real day count, so the 1- and 2-day stubs at a cycle's edges
 * get a 1- and 2-day allowance rather than a seventh of the cycle.
 */
function WeekFigures({
  row,
  week,
  p,
}: {
  row: BudgetRowData;
  week: WeekBucket;
  p: ReturnType<typeof pace>;
}) {
  if (p.budget === null) {
    return (
      <p className="mt-1 text-xs opacity-55">
        No budget · <Money value={row.weekSpend[week.weekStart] ?? 0} /> spent this week
      </p>
    );
  }

  const spentThisWeek = row.weekSpend[week.weekStart] ?? 0;
  const overFair = p.fairShare !== null && spentThisWeek > p.fairShare;

  return (
    <p className="mt-1 text-xs opacity-55">
      <span className={p.remainingPace !== null && p.remainingPace < 0 ? "text-rose-600 dark:text-rose-400" : ""}>
        {p.remainingPace === null ? (
          "cycle almost over"
        ) : (
          <>
            <Money value={p.remainingPace} /> per week left
          </>
        )}
      </span>
      {" · fair share "}
      <Money value={p.fairShare ?? 0} />
      {week.partial && ` (${week.days} of 7 days)`}
      {overFair && <span className="text-amber-600 dark:text-amber-400"> · over for the week</span>}
    </p>
  );
}

function AmountForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: number | null;
  onSave: (amount: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial === null ? "" : initial.toFixed(2));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value.trim() === "" ? null : value.trim());
      }}
      className="flex items-center gap-2"
    >
      <input
        // Focus on open: the button that revealed this field is gone, so
        // without it the next tap is on a field the reader has to find again.
        autoFocus
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Monthly budget"
        placeholder="0.00"
        className="tabular w-24 rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
      />
      <button type="submit" className="text-xs font-medium underline underline-offset-2">
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs underline underline-offset-2 opacity-60"
      >
        Cancel
      </button>
      <span className="text-[11px] opacity-45">empty removes it</span>
    </form>
  );
}

/* ------------------------------------------------------------ uncategorized */

/**
 * §11.2 — "Uncategorized is a first-class category, excluded from budget pacing
 * but shown prominently with a count. Hiding it makes every other number quietly
 * wrong."
 *
 * Prominent means outside the list and above the fold of the rows, with the
 * count as the call to action: the number is only useful because it is
 * fixable, and the fix is on the Ledger.
 */
function Uncategorized({ row }: { row: UncategorizedRow }) {
  if (row.count === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">Uncategorized</p>
        <p className="text-sm">
          <Money value={row.total} />
        </p>
      </div>
      <p className="mt-1 text-xs opacity-70">
        <span className="tabular">{row.count}</span>{" "}
        {row.count === 1 ? "transaction" : "transactions"} with no category. Excluded from every
        pacing figure above — there is no budget to pace against — which is why the totals here are
        lower than the cycle&apos;s real spending by exactly this much.{" "}
        <Link href="/ledger?uncategorized=1" className="underline underline-offset-2">
          Categorize them
        </Link>
        .
      </p>
    </div>
  );
}
