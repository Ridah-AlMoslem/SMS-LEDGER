/**
 * Reconciliation state, stated (SPEC §3.3b).
 *
 * The rule this exists to enforce is one sentence of §3.3b: *"so 'unverifiable'
 * is never mistaken for 'verified'."* Which means the state is **printed on
 * every account**, never implied by the absence of a badge — an account with
 * nothing next to it reads as fine, and three of the four accounts here are not
 * fine, they are unchecked.
 *
 * Colour does not carry it either. `full` and `none` are different words before
 * they are different hues, because a green dot and a grey dot are the same dot
 * to a lot of readers, and this is the distinction the whole feature rests on.
 *
 * The levels themselves are measured in `lib/accounts.ts` from what the ledger
 * actually holds, not hardcoded per institution — see `reconciliationOf`.
 */

import type { Reconciliation, ReconciliationLevel } from "@/lib/accounts";
import { dayMonthYear } from "@/lib/format";

const DOT: Record<ReconciliationLevel, string> = {
  full: "bg-emerald-500",
  partial: "bg-amber-500",
  weak: "bg-amber-500/30 border border-amber-500",
  // Hollow, and never red: this is "nobody knows", not "something is wrong".
  none: "bg-transparent border border-dashed border-black/50 dark:border-white/50",
};

const TEXT: Record<ReconciliationLevel, string> = {
  full: "text-emerald-700 dark:text-emerald-400",
  partial: "text-amber-700 dark:text-amber-500",
  weak: "text-amber-700 dark:text-amber-500",
  none: "opacity-70",
};

/** The one-liner every account row carries. */
export function ReconciliationChip({ r }: { r: Reconciliation }) {
  return (
    <span className={`flex items-center gap-1.5 text-[11px] ${TEXT[r.level]}`}>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[r.level]}`} />
      <span>{r.label}</span>
      {r.share !== null && r.level !== "none" && (
        <span className="opacity-60 tabular">
          {r.coverage.withBalance}/{r.coverage.messages}
        </span>
      )}
    </span>
  );
}

/**
 * The full statement, for the detail view.
 *
 * Says what is checked, what is not, and when a person last anchored it by
 * hand. §3.3b's three compensating controls are what an account with no
 * coverage has instead of reconciliation, and the third of them is a button on
 * this same screen.
 */
export function ReconciliationPanel({
  r,
  children,
}: {
  r: Reconciliation;
  /** The manual-entry control. Placed by the caller so this stays a server
   *  component and only the form ships as client JavaScript. */
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-black/10 p-4 dark:border-white/15">
      {/* The heading and the control share a line; the state gets its own.
          At 390px a two-line status beside a two-line button is four lines of
          wrapping that read as two separate broken things. */}
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Reconciliation
        </h2>
        <div className="shrink-0">{children}</div>
      </div>

      <div className="mt-2">
        <ReconciliationChip r={r} />
      </div>

      <p className="mt-2 text-sm opacity-70">{r.detail}</p>

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs opacity-55">
        <div className="flex gap-1.5">
          <dt>Bank last stated a balance</dt>
          <dd className="tabular">
            {r.coverage.lastReportedAt ? dayMonthYear(r.coverage.lastReportedAt) : "never"}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>You last entered one</dt>
          <dd className="tabular">
            {r.coverage.lastManualAt ? dayMonthYear(r.coverage.lastManualAt) : "never"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
