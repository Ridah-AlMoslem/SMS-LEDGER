"use client";

/**
 * A filter pill.
 *
 * Renders as a link when given `href`, so filters can live in the URL and stay
 * back-button-able, and as a button otherwise. Same pill either way — a filter
 * that looks different depending on how it is wired is a filter you have to
 * learn twice.
 */

import Link from "next/link";

type Common = {
  children: React.ReactNode;
  selected?: boolean;
  /** Trailing count, e.g. the number of matches behind the filter. */
  count?: number;
  className?: string;
};

export type ChipProps = Common &
  ({ href: string; onClick?: never } | { href?: never; onClick?: () => void });

const BASE =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm " +
  "leading-none whitespace-nowrap transition-colors";

const OFF =
  "border-black/10 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10";

// Selected is a filled pill, not just a heavier border: at a glance down a
// scrolling row of filters, weight reads far faster than outline thickness.
const ON =
  "border-transparent bg-foreground text-[var(--background)] dark:bg-foreground";

export function Chip({ children, selected = false, count, className = "", ...rest }: ChipProps) {
  const cls = `${BASE} ${selected ? ON : OFF} ${className}`.trim();

  const body = (
    <>
      <span className="sms-body">{children}</span>
      {count !== undefined && (
        <span className={`tabular text-xs ${selected ? "opacity-70" : "opacity-50"}`}>
          {count}
        </span>
      )}
    </>
  );

  if ("href" in rest && rest.href) {
    return (
      <Link href={rest.href} className={cls} aria-current={selected ? "true" : undefined}>
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={"onClick" in rest ? rest.onClick : undefined}
      aria-pressed={selected}
      className={cls}
    >
      {body}
    </button>
  );
}
