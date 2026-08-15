"use client";

/**
 * Pull to refresh.
 *
 * This dashboard is read on a phone, minutes after a message arrives, and the
 * pages are `force-dynamic` — so the gesture everyone already has in their
 * thumb should be the one that fetches again. Without it the only way to see a
 * new transaction is to navigate away and back, which looks like the app not
 * noticing.
 *
 * `router.refresh()` re-runs the server components and swaps the tree in place;
 * it keeps scroll position and client state, unlike `location.reload()`, which
 * would throw away the sheet you had open and the chart toggle you had set.
 *
 * The indicator is the app's one loader (`ui/loader.tsx`) — the mark in motion.
 * A second spinner here, on the single most-repeated interaction in the app, is
 * exactly the defect §11.7 describes.
 */

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Loader } from "@/components/ui/loader";

/** How far the thumb must travel before the gesture counts. Shorter than this
 *  and an ordinary flick at the top of the page fires a refresh. */
const THRESHOLD = 64;

/** Pull resistance: the indicator moves at half thumb speed, which is what
 *  makes the gesture feel attached to something rather than free. */
const FRICTION = 0.5;

const MAX = 96;

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [isPending, startTransition] = useTransition();
  const start = useRef<number | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    // Only from the very top. Starting the gesture mid-page would fight the
    // scroll the user actually asked for.
    start.current = window.scrollY <= 0 ? e.touches[0].clientY : null;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (start.current === null) return;
    const delta = e.touches[0].clientY - start.current;
    setPull(delta > 0 ? Math.min(delta * FRICTION, MAX) : 0);
  };

  const onTouchEnd = () => {
    if (pull >= THRESHOLD) {
      // Inside a transition so `isPending` covers the server round trip; the
      // indicator stays up until the new tree is actually in.
      startTransition(() => router.refresh());
    }
    setPull(0);
    start.current = null;
  };

  const showing = isPending || pull > 8;

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div
        className="pointer-events-none flex items-center justify-center overflow-hidden transition-[height] duration-150"
        style={{ height: isPending ? 40 : pull }}
        aria-hidden={!showing}
      >
        {showing && (
          <Loader
            size={pull >= THRESHOLD || isPending ? 24 : 18}
            variant="arrows"
            label="Refreshing"
          />
        )}
      </div>

      {children}
    </div>
  );
}
