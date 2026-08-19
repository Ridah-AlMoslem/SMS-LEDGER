"use client";

/**
 * The bottom tab bar.
 *
 * FOUR FIXED ITEMS, in an order that never changes: Home, Ledger, Plan,
 * Accounts. Review is a CONDITIONAL FIFTH that appears only while the parser
 * has parked something, and **position 5 is never reassigned to anything
 * else**. When the queue drains, the slot is empty.
 *
 * With one exception: **while you are on /review, the tab stays**, whatever the
 * queue depth. Clearing the last parked group is a server action, and the
 * layout that counts the queue is `force-dynamic`, so without this the tab that
 * represents the page you are standing on disappears from under you at the
 * moment you finish the work — the current route stops being reachable in the
 * nav that is showing it, and the badge you were watching count down vanishes
 * instead of reaching zero. It is also what makes arriving by URL with an empty
 * queue coherent: the nav names where you are. The count is recomputed on every
 * navigation regardless, so the slot empties as soon as you leave.
 *
 * That empty slot is the point, and it is why this is a five-column grid
 * rather than a row of flex children. With `flex-1` on each item, four tabs
 * would each take a quarter of the bar and five would each take a fifth —
 * meaning every tab slides sideways the moment a message fails to parse. A tab
 * whose position depends on parser health destroys the muscle memory that
 * makes a tab bar worth having in the first place. Four fixed columns plus a
 * reserved fifth keeps every destination in the same place on every load.
 *
 * There is no hamburger and no "More". Anything that does not fit here is a
 * drill-down route reached from one of these four screens, not a nav item.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

type Tab = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" {...stroke}>
    {children}
  </svg>
);

/**
 * The four, in order. A module-level constant rather than a prop: the order is
 * not a decision a caller gets to make.
 */
const TABS: Tab[] = [
  {
    href: "/",
    label: "Home",
    icon: (
      <Icon>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5.5 9.5V20h13V9.5" />
      </Icon>
    ),
  },
  {
    href: "/ledger",
    label: "Ledger",
    icon: (
      <Icon>
        <path d="M4 4h16v16H4z" />
        <path d="M8 9h8M8 13h8M8 17h5" />
      </Icon>
    ),
  },
  {
    href: "/plan",
    label: "Plan",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" />
      </Icon>
    ),
  },
  {
    href: "/accounts",
    label: "Accounts",
    icon: (
      <Icon>
        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1" />
        <path d="M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6H6.5" />
        <circle cx="17" cy="14" r="1" />
      </Icon>
    ),
  },
];

const REVIEW: Tab = {
  href: "/review",
  label: "Review",
  icon: (
    <Icon>
      <path d="M3.5 13.5h4l1.5 3h6l1.5-3h4" />
      <path d="M5.5 5.5h13l2 8v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3z" />
    </Icon>
  ),
};

function isActive(pathname: string, href: string): boolean {
  // "/" would otherwise prefix-match every route in the app.
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function TabLink({ tab, active, badge }: { tab: Tab; active: boolean; badge?: number }) {
  const search = useSearchParams().toString();

  return (
    <Link
      // The Week/Cycle selection rides along, so switching tabs keeps the
      // period you were looking at instead of silently resetting to now.
      href={search ? `${tab.href}?${search}` : tab.href}
      aria-current={active ? "page" : undefined}
      className={`flex flex-col items-center justify-center gap-1 py-2 text-[11px] transition-colors ${
        active ? "text-foreground" : "opacity-55 hover:opacity-90"
      }`}
    >
      <span className="relative">
        {tab.icon}
        {badge !== undefined && badge > 0 && (
          <span
            className="tabular absolute -top-1.5 -right-2.5 min-w-[17px] rounded-full bg-amber-500 px-1
                       text-center text-[10px] leading-[17px] font-medium text-black"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span className={active ? "font-medium" : ""}>{tab.label}</span>
    </Link>
  );
}

export function TabBar({ parked }: { parked: number }) {
  const pathname = usePathname();
  const onReview = isActive(pathname, REVIEW.href);

  return (
    <nav
      aria-label="Primary"
      className="sticky bottom-0 z-40 border-t border-black/8 bg-[var(--background)]/90 backdrop-blur-md dark:border-white/12"
      // The home indicator on a modern iPhone overlaps the last ~34px. Without
      // this the labels sit under it.
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto grid w-full max-w-2xl grid-cols-5">
        {TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} active={isActive(pathname, tab.href)} />
        ))}

        {/* Slot 5. Empty when the queue is empty — never backfilled. /review
            stays reachable by URL and from Settings; only the tab is
            conditional, never the route.

            `onReview` holds the slot for the page you are currently on, so
            emptying the queue does not remove the tab mid-navigation. See the
            module comment. */}
        {parked > 0 || onReview ? (
          <TabLink tab={REVIEW} active={onReview} badge={parked} />
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    </nav>
  );
}
