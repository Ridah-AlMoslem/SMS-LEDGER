"use client";

/**
 * Budgets | Goals | Recurring — content segments, not navigation.
 *
 * One route, one load, three panels. The distinction matters in both directions:
 *
 *   - **Not three routes.** All three read the same cycle and the same accounts,
 *     and they are loaded in one statement (`db/plan.ts`). Splitting them into
 *     routes would mean three round trips to a database a region away, and a
 *     `loading.tsx` flash every time you glanced at your goals.
 *   - **Not local state either.** The active segment lives in the URL, so
 *     `/plan?seg=recurring` is a link you can send yourself, an alert can point
 *     at the panel that resolves it, and the back button steps back through the
 *     panels rather than out of the page.
 *
 * The URL is updated with `window.history.pushState`, which Next.js supports
 * for exactly this: it integrates with the router — `useSearchParams` sees it —
 * without re-running the server component. Switching panel is therefore
 * instant and costs nothing, where a `<Link>` would re-render the page on the
 * server to change which of three already-loaded panels is visible.
 */

import { useSearchParams } from "next/navigation";

export const SEGMENT_PARAM = "seg";

export const SEGMENTS = ["budgets", "goals", "recurring"] as const;
export type Segment = (typeof SEGMENTS)[number];

export function isSegment(v: unknown): v is Segment {
  return SEGMENTS.includes(v as Segment);
}

/** Junk is not an error: a hand-edited URL falls back to the first panel
 *  rather than rendering nothing. */
export function readSegment(raw: string | null): Segment {
  return isSegment(raw) ? raw : "budgets";
}

export function PlanSegments({
  budgets,
  goals,
  recurring,
  counts,
}: {
  budgets: React.ReactNode;
  goals: React.ReactNode;
  recurring: React.ReactNode;
  /** Badge counts, so the tab says whether there is anything behind it. */
  counts: Record<Segment, number>;
}) {
  const params = useSearchParams();

  // The URL is the only state here — no local copy to fall out of step with it.
  // `pushState` feeds the Next router, which re-renders anything reading
  // `useSearchParams`, so a tap and the back button take the same path through
  // the same value.
  const segment = readSegment(params.get(SEGMENT_PARAM));

  const select = (next: Segment) => {
    const query = new URLSearchParams(params.toString());
    query.set(SEGMENT_PARAM, next);
    window.history.pushState(null, "", `?${query.toString()}`);
  };

  const panels: Record<Segment, React.ReactNode> = { budgets, goals, recurring };

  return (
    <>
      <div
        role="tablist"
        aria-label="Plan section"
        className="mt-4 flex rounded-xl bg-black/[0.06] p-0.5 text-sm dark:bg-white/[0.09]"
      >
        {SEGMENTS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            id={`plan-tab-${s}`}
            aria-selected={s === segment}
            aria-controls={`plan-panel-${s}`}
            onClick={() => select(s)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2
                        capitalize transition-colors ${
                          s === segment
                            ? "bg-[var(--background)] font-medium shadow-sm"
                            : "opacity-60 hover:opacity-100"
                        }`}
          >
            {s}
            {counts[s] > 0 && (
              <span className="tabular text-[11px] opacity-55">{counts[s]}</span>
            )}
          </button>
        ))}
      </div>

      {/* All three panels arrive as props — their data came in one statement — but
          only the selected one is mounted, so a long bills list is not sitting in
          the tree behind the budget rows. Switching mounts the next one with data
          the browser already has. */}
      <div
        role="tabpanel"
        id={`plan-panel-${segment}`}
        aria-labelledby={`plan-tab-${segment}`}
        className="mt-5"
      >
        {panels[segment]}
      </div>
    </>
  );
}
