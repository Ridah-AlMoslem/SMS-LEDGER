"use client";

/**
 * The global Week / Cycle control (SPEC §11.1).
 *
 * One of these, at the top of the page, driving every chart below it. It
 * persists across navigation because the selection lives in the URL and the
 * tab bar carries the query forward — not because anything is held in memory.
 *
 * The label always spells the boundary out ("August 2026 (25 Jul – 24 Aug)")
 * because the entire point of §5.1 is that this is not a calendar month, and a
 * reader who assumes otherwise has to be corrected on every screen, not once.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

import {
  DEFAULT_GRAIN,
  loadGrain,
  readSelection,
  reanchor,
  saveGrain,
  withSelection,
} from "@/lib/period-params";
import {
  type Grain,
  daysElapsed,
  daysInPeriod,
  periodBounds,
  periodLabel,
  stepPeriod,
  today,
} from "@/lib/periods";

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={dir === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}

function PeriodHeaderInner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const { grain, period } = readSelection(params);
  const href = (g: Grain, p: string) => `${pathname}?${withSelection(params, g, p)}`;

  // Restore the remembered grain when the URL says nothing — a cold entry to
  // the app, or a shared link that carried no selection. Replace rather than
  // push: this is the app resolving its own default, and it should not sit in
  // the history as a step the user took.
  const urlHasGrain = params.get("grain") !== null;
  useEffect(() => {
    if (urlHasGrain) return;
    const remembered = loadGrain();
    if (!remembered || remembered === DEFAULT_GRAIN) return;
    const anchor = reanchor(DEFAULT_GRAIN, period, remembered);
    router.replace(`${pathname}?${withSelection(params, remembered, anchor)}`, { scroll: false });
  }, [urlHasGrain, pathname, params, period, router]);

  useEffect(() => {
    if (urlHasGrain) saveGrain(grain);
  }, [urlHasGrain, grain]);

  const label = periodLabel(grain, period);
  const { start, end } = periodBounds(grain, period);
  const now = today();
  const isCurrent = now >= start && now <= end;

  // §11.2 — pacing is measured against the ACTUAL length of this period.
  // 28 to 31 days for a cycle; a hardcoded 30 is wrong twice a year.
  const total = daysInPeriod(grain, period);
  const elapsed = daysElapsed(grain, period, now);

  // Swipe steps the period, the same way the chevrons do. The header is the
  // control that owns the selection, so the gesture belongs to it rather than
  // to the page: swiping the body of a scrolling dashboard would compete with
  // the scroll, and a gesture that sometimes scrolls and sometimes changes the
  // month is a gesture nobody trusts twice.
  const touch = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const from = touch.current;
    touch.current = null;
    if (!from) return;

    const dx = e.changedTouches[0].clientX - from.x;
    const dy = e.changedTouches[0].clientY - from.y;

    // Horizontal, and decisively so. The vertical guard is what keeps a
    // slightly-diagonal scroll from stepping the month underneath you.
    if (Math.abs(dx) < 56 || Math.abs(dy) > Math.abs(dx) * 0.6) return;

    // Swiping left pulls the next period in from the right, matching the
    // direction the content moves rather than the direction of the thumb.
    router.push(href(grain, stepPeriod(grain, period, dx < 0 ? 1 : -1)), { scroll: false });
  };

  return (
    <header
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="sticky top-0 z-30 -mx-6 mb-5 border-b border-black/5 bg-[var(--background)]/85 px-6 py-2.5 backdrop-blur-md dark:border-white/10">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
        <Link
          href={href(grain, stepPeriod(grain, period, -1))}
          scroll={false}
          aria-label={`Previous ${grain}`}
          className="rounded-lg p-1.5 opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        >
          <Chevron dir="left" />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-semibold">{label}</p>
          <p className="mt-0.5 text-[11px] opacity-55">
            {isCurrent ? (
              <>
                day <span className="tabular">{elapsed}</span> of{" "}
                <span className="tabular">{total}</span>
              </>
            ) : (
              <>
                <span className="tabular">{total}</span> days
              </>
            )}
          </p>
        </div>

        <Link
          href={href(grain, stepPeriod(grain, period, 1))}
          scroll={false}
          aria-label={`Next ${grain}`}
          className="rounded-lg p-1.5 opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        >
          <Chevron dir="right" />
        </Link>

        {/* Segmented control. Two grains, both always visible: §5.3 makes the
            point that they are independent views of the same ledger, not a
            zoom level, so neither is hidden behind the other. */}
        <div
          role="group"
          aria-label="Reporting grain"
          className="ml-1 flex shrink-0 rounded-lg bg-black/[0.06] p-0.5 text-xs dark:bg-white/[0.09]"
        >
          {(["week", "cycle"] as const).map((g) => (
            <Link
              key={g}
              href={href(g, reanchor(grain, period, g))}
              scroll={false}
              aria-current={g === grain ? "true" : undefined}
              className={`rounded-md px-2.5 py-1.5 capitalize transition-colors ${
                g === grain
                  ? "bg-[var(--background)] font-medium shadow-sm"
                  : "opacity-60 hover:opacity-100"
              }`}
            >
              {g}
            </Link>
          ))}
        </div>
      </div>

      {!isCurrent && (
        <div className="mx-auto mt-1.5 w-full max-w-2xl text-center">
          <Link
            href={href(grain, periodBounds(grain, today()).start)}
            scroll={false}
            className="text-[11px] opacity-60 underline underline-offset-2 hover:opacity-100"
          >
            back to {grain === "cycle" ? "this cycle" : "this week"}
          </Link>
        </div>
      )}
    </header>
  );
}

/**
 * The Suspense boundary lives here rather than at each call site.
 *
 * useSearchParams is a request-time API: without a boundary it pulls the
 * client tree above it into client-side rendering. Owning that here means a
 * page cannot forget it, and the fallback reserves the header's height so the
 * content below does not jump when it hydrates.
 */
export function PeriodHeader() {
  return (
    <Suspense fallback={<div className="mb-5 h-[52px]" />}>
      <PeriodHeaderInner />
    </Suspense>
  );
}
