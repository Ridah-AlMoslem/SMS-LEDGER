"use client";

/**
 * Back to wherever you came from.
 *
 * This page is reached two ways and must not assume either: from the account
 * list, and **straight from Home** by tapping the net worth strip, which is how
 * §11.5's savings view is reached at all — savings has no tab of its own by
 * design. Sending a reader who arrived from Home back to a list they never
 * visited is a small lie about where they are.
 *
 * So the href is the account list — correct for a deep link, a share, a cold
 * load, and for anyone with JavaScript off — and the click is intercepted to
 * step back through history when there *is* history to step back through.
 *
 * The history check happens **in the handler**, not in an effect: it is a
 * question about the browser at the moment of the tap, the answer changes as
 * the reader navigates, and holding it in state would render one thing on the
 * server and another after hydration for no benefit at all.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

export function BackLink({ fallback = "/accounts" }: { fallback?: string }) {
  const router = useRouter();

  return (
    <Link
      href={fallback}
      onClick={(e) => {
        if (window.history.length <= 1) return;
        e.preventDefault();
        router.back();
      }}
      className="-ml-1 inline-flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-sm opacity-60 hover:opacity-100"
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      Back
    </Link>
  );
}
