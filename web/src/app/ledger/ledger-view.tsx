"use client";

/**
 * The ledger list: search, filters, day groups, bulk actions, and the sheet
 * behind every row (SPEC §11.1, milestone 8).
 *
 * Three things here are not incidental:
 *
 *   - Internal transfers are listed and not counted, and BOTH facts are on
 *     screen. The row carries an "internal" badge and the day header's subtotal
 *     excludes it, with a tap on the subtotal saying so. §6's whole point is
 *     that these are your own money moving; a list that hid them would make the
 *     ledger disagree with your bank statement, and a subtotal that counted
 *     them would make it disagree with itself.
 *   - The day subtotal comes from SQL, over the whole filtered set. Summing the
 *     rows on screen would produce a different number at every page boundary.
 *   - Nothing loads the whole ledger. A page is 100 rows and the next one is
 *     fetched when you reach the bottom.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import type { Facets, LedgerPage, LedgerRow } from "@/db/ledger";
import { type DateScope, type LedgerFilters, hasFilters, withoutFilters } from "@/lib/ledger-filters";
import { dayLabel } from "@/lib/periods";

import { FilterBar } from "./filter-bar";
import { ManualEntry } from "./manual-entry";
import { TransactionSheet } from "./transaction-sheet";
import { useLedgerMutations } from "./use-ledger";

/** Matches the tab bar's reserved height in `app/layout.tsx`. Anything floating
 *  above the list has to clear it, or the primary action of the screen sits
 *  under the navigation. */
const ABOVE_TAB_BAR = "calc(57px + env(safe-area-inset-bottom))";

export function LedgerView({
  initialPage,
  facets,
  filters,
  scope,
}: {
  initialPage: LedgerPage;
  facets: Facets;
  filters: LedgerFilters;
  scope: DateScope;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  // The cursor is not part of the identity of a list — it is a position within
  // one — so it is stripped from the key. Leaving it in would make every scroll
  // a new query with its own cache entry and its own first page.
  const listKey = useMemo(() => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    return next.toString();
  }, [params]);

  const query = useInfiniteQuery({
    queryKey: ["ledger", listKey],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const url = new URLSearchParams(listKey);
      if (pageParam) url.set("cursor", pageParam);

      const res = await fetch(`/api/ledger?${url.toString()}`, { signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `The ledger did not load (${res.status}).`);
      return body as LedgerPage;
    },
    getNextPageParam: (last) => last.nextCursor,
    // The server already fetched page one for this exact query string, so the
    // list is on screen at first paint rather than after a round trip.
    initialData: { pages: [initialPage], pageParams: [null] },
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.rows) ?? [],
    [query.data],
  );

  const mutations = useLedgerMutations(listKey);

  const [openId, setOpenId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const leaveSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const openRow = rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <FilterBar filters={filters} facets={facets} scope={scope} />

      <div className="mt-4 flex items-center justify-between gap-3 text-xs">
        <p className="opacity-55">
          {rows.length}
          {query.hasNextPage ? "+" : ""} shown
          {scope.source === "all" && " · all time"}
        </p>

        <div className="flex items-center gap-3">
          <ExportLinks query={listKey} />
          <button
            type="button"
            onClick={() => (selecting ? leaveSelection() : setSelecting(true))}
            className="opacity-60 hover:opacity-100"
          >
            {selecting ? "Done" : "Select"}
          </button>
        </div>
      </div>

      {query.isError && (
        <div className="mt-5">
          <EmptyState
            title="Can't reach the database"
            body={query.error instanceof Error ? query.error.message : String(query.error)}
          />
        </div>
      )}

      {!query.isError && rows.length === 0 && (
        <div className="mt-5">
          <EmptyState
            title={hasFilters(filters) ? "Nothing matches those filters" : "Nothing here yet"}
            body={
              hasFilters(filters) ? (
                <>
                  The search covers the raw message text as well as the parsed merchant and
                  biller, so a fragment you half remember should find it. If not, the filters
                  above may be narrower than you meant.
                </>
              ) : (
                <>
                  This period has no transactions. Step back with the arrows above, widen the
                  date range, or add a cash entry with the + button.
                </>
              )
            }
            action={
              hasFilters(filters) ? (
                <button
                  type="button"
                  onClick={() =>
                    router.push(`${pathname}?${withoutFilters(params)}`, { scroll: false })
                  }
                  className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Clear the filters
                </button>
              ) : null
            }
          />
        </div>
      )}

      <DayGroups
        rows={rows}
        selecting={selecting}
        selected={selected}
        onToggle={toggle}
        onOpen={setOpenId}
      />

      <LoadMore
        hasNext={!!query.hasNextPage}
        loading={query.isFetchingNextPage}
        onReach={() => query.fetchNextPage()}
        total={rows.length}
      />

      {mutations.failure && (
        <Flash message={mutations.failure} onDismiss={mutations.clearFailure} />
      )}

      {selecting && selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          categories={facets.categories}
          mutations={mutations}
          onDone={leaveSelection}
        />
      )}

      {!selecting && <ManualEntry accounts={facets.accounts} categories={facets.categories} mutations={mutations} />}

      <TransactionSheet
        row={openRow}
        facets={facets}
        mutations={mutations}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------ day groups */

type Day = { day: string; subtotal: string; count: number; internal: number; rows: LedgerRow[] };

function DayGroups({
  rows,
  selecting,
  selected,
  onToggle,
  onOpen,
}: {
  rows: LedgerRow[];
  selecting: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const days = useMemo(() => {
    const out: Day[] = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (last && last.day === row.localDay) {
        last.rows.push(row);
        continue;
      }
      out.push({
        day: row.localDay,
        subtotal: row.daySubtotal,
        count: row.dayCount,
        internal: row.dayInternalCount,
        rows: [row],
      });
    }
    return out;
  }, [rows]);

  return (
    <div className="mt-2">
      {days.map((day) => (
        <section key={day.day} className="mt-4 first:mt-2">
          <DayHeader day={day} />
          <ul className="divide-y divide-black/8 dark:divide-white/10">
            {day.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                selecting={selecting}
                checked={selected.has(row.id)}
                onToggle={() => onToggle(row.id)}
                onOpen={() => onOpen(row.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DayHeader({ day }: { day: Day }) {
  const [explaining, setExplaining] = useState(false);

  return (
    <header className="border-b border-black/8 pb-1.5 dark:border-white/10">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold tracking-wide uppercase opacity-60">
          {dayLabel(day.day)}
        </h2>

        {/* Tapping the subtotal says what it excludes. §6's exclusions are the
            difference between a correct figure and a plausible wrong one, and a
            number nobody can interrogate is a number nobody can trust. */}
        <button
          type="button"
          onClick={() => setExplaining((v) => !v)}
          aria-expanded={explaining}
          className="flex items-baseline gap-1 text-sm"
        >
          <Money value={day.subtotal} tone="auto" sign="always" className="text-sm" />
          <span aria-hidden className="text-[10px] opacity-35">
            {explaining ? "▴" : "▾"}
          </span>
        </button>
      </div>

      {explaining && (
        <p className="mt-1 pb-1 text-[11px] leading-relaxed opacity-60">
          Money in minus money out for the day, across the rows shown.
          {day.internal > 0 && (
            <>
              {" "}
              {day.internal === 1 ? "One internal transfer is" : `${day.internal} internal transfers are`}{" "}
              listed below and not counted — moving your own money between your own accounts is
              not spending.
            </>
          )}{" "}
          Card and loan payments are listed and not counted either: the spending was already
          counted when the purchase posted. Declined authorisations never happened.
        </p>
      )}
    </header>
  );
}

/* -------------------------------------------------------------------- row */

function Row({
  row,
  selecting,
  checked,
  onToggle,
  onOpen,
}: {
  row: LedgerRow;
  selecting: boolean;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  // §7.5 — the biller is a better label than any merchant string for a SADAD
  // payment, and `description` carries rows that were never parsed from a
  // message at all: a balance corrected by hand names itself there, and without
  // it the row would read "adjustment" and explain nothing.
  const label = row.merchantRaw ?? row.biller ?? row.description ?? row.type;
  const credit = row.direction === "credit";

  const time = new Date(row.postedAt).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <li>
      <button
        type="button"
        onClick={selecting ? onToggle : onOpen}
        aria-pressed={selecting ? checked : undefined}
        className="flex w-full items-center gap-3 py-3 text-left"
      >
        {selecting && (
          <span
            aria-hidden
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
              checked
                ? "border-transparent bg-foreground text-[var(--background)]"
                : "border-black/25 dark:border-white/30"
            }`}
          >
            {checked ? "✓" : ""}
          </span>
        )}

        <span className="block min-w-0 flex-1">
          {/* .sms-body isolates the bidi run: an Arabic biller name must not be
              able to reorder the row around it (globals.css). */}
          <span className="sms-body block truncate font-medium">{label}</span>
          <span className="mt-0.5 block truncate text-xs opacity-60">
            <span className="tabular">{time}</span> · {row.accountName}
            {row.categoryName ? ` · ${row.categoryName}` : ""}
            {row.splitCount > 1 ? ` · split ${row.splitCount} ways` : ""}
          </span>
          <Badges row={row} />
        </span>

        <Money
          value={credit ? Number(row.amount) : -Number(row.amount)}
          tone={credit ? "auto" : "none"}
          sign={credit ? "always" : "auto"}
          className={`shrink-0 text-sm ${row.state === "declined" ? "line-through opacity-40" : ""}`}
        />
      </button>
    </li>
  );
}

function Badges({ row }: { row: LedgerRow }) {
  const badges: { label: string; title: string }[] = [];

  if (row.isInternal) {
    badges.push({
      label: "internal",
      title: "Between your own accounts. Listed here, excluded from every total.",
    });
  }
  if (row.state === "pending") {
    badges.push({ label: "pending", title: "An authorisation, not yet settled. It still counts." });
  }
  if (row.state === "reversed") {
    badges.push({ label: "reversed", title: "The bank undid this entry. Both rows are kept." });
  }
  if (row.state === "declined") {
    badges.push({ label: "declined", title: "It never happened, so it counts as nothing." });
  }
  if (row.refundedAmount) {
    badges.push({ label: `refunded ${row.refundedAmount}`, title: "A refund was matched to this purchase." });
  }
  if (row.origin === "manual") {
    badges.push({ label: "manual", title: "Typed in by hand. Replay never touches it." });
  }
  if (row.originalCurrency) {
    badges.push({ label: row.originalCurrency, title: "A foreign purchase. The total includes the FX fee." });
  }
  if (row.excluded) {
    badges.push({ label: "excluded", title: "Deliberately left out of analytics." });
  }
  if (row.cycleOverride) {
    badges.push({ label: "moved cycle", title: "Reassigned to a neighbouring cycle by hand." });
  }
  if (row.lockedFields.length > 0) {
    badges.push({
      label: `🔒 ${row.lockedFields.length}`,
      title: `${row.lockedFields.length} field(s) edited by hand. A replay leaves them alone.`,
    });
  }

  if (badges.length === 0) return null;

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {badges.map((b) => (
        <span
          key={b.label}
          title={b.title}
          className="rounded border border-black/12 px-1 py-px text-[10px] leading-tight opacity-65 dark:border-white/18"
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------- load more */

function LoadMore({
  hasNext,
  loading,
  onReach,
  total,
}: {
  hasNext: boolean;
  loading: boolean;
  onReach: () => void;
  total: number;
}) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasNext || loading) return;
    const node = sentinel.current;
    if (!node) return;

    // 400px of lead time: the next page starts loading before the last row is
    // on screen, so a continuous scroll stays continuous.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onReach();
      },
      { rootMargin: "400px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, loading, onReach]);

  if (total === 0) return null;

  return (
    <div ref={sentinel} className="flex justify-center py-6">
      {loading ? (
        <Loader size={24} variant="arrows" label="Loading more transactions" />
      ) : hasNext ? (
        <button type="button" onClick={onReach} className="text-xs opacity-55 hover:opacity-100">
          Load more
        </button>
      ) : (
        <p className="text-xs opacity-35">That is everything in this view.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ export, bulk */

function ExportLinks({ query }: { query: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="opacity-45">Export</span>
      {(["csv", "json"] as const).map((format) => (
        <a
          key={format}
          // The current view, scoped by the same query string the list is drawn
          // from (§11.6). Downloading "everything" from a filtered screen would
          // be a different document from the one on offer.
          href={`/api/ledger/export?${query}&format=${format}`}
          download
          className="underline underline-offset-2 opacity-60 hover:opacity-100"
        >
          {format.toUpperCase()}
        </a>
      ))}
    </span>
  );
}

function BulkBar({
  ids,
  categories,
  mutations,
  onDone,
}: {
  ids: string[];
  categories: Facets["categories"];
  mutations: ReturnType<typeof useLedgerMutations>;
  onDone: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const n = ids.length;

  return (
    <div
      className="fixed inset-x-0 z-40 border-t border-black/10 bg-[var(--background)]/95 px-6 py-3 backdrop-blur-md dark:border-white/15"
      style={{ bottom: ABOVE_TAB_BAR }}
    >
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            <span className="tabular">{n}</span> selected
          </p>
          <button type="button" onClick={onDone} className="text-sm opacity-60 hover:opacity-100">
            Cancel
          </button>
        </div>

        {picking ? (
          <select
            autoFocus
            defaultValue=""
            onChange={(e) => {
              const categoryId = e.target.value || null;
              const name = categories.find((c) => c.id === categoryId)?.name ?? null;
              mutations.bulk.mutate({
                ids,
                patch: { categoryId },
                optimistic: { categoryId, categoryName: name },
              });
              setPicking(false);
              onDone();
            }}
            className="mt-2 w-full rounded border border-black/15 bg-transparent px-2 py-2 text-sm dark:border-white/20"
          >
            <option value="" disabled>
              Categorize {n} as…
            </option>
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parentName ? `${c.parentName} › ${c.name}` : c.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="mt-2 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <BulkButton onClick={() => setPicking(true)}>Categorize {n}</BulkButton>
            <BulkButton
              onClick={() => {
                mutations.bulk.mutate({
                  ids,
                  patch: { excludedFromAnalytics: true },
                  optimistic: { excluded: true },
                });
                onDone();
              }}
            >
              Exclude {n}
            </BulkButton>
            <BulkButton
              onClick={() => {
                mutations.bulk.mutate({
                  ids,
                  patch: { isInternalTransfer: true },
                  optimistic: { isInternal: true },
                });
                onDone();
              }}
            >
              Mark {n} internal
            </BulkButton>
          </div>
        )}

        <p className="mt-2 text-[11px] opacity-50">
          A bulk action counts as a hand edit: every field it sets is locked, so the next replay
          leaves it alone.
        </p>
      </div>
    </div>
  );
}

function BulkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg border border-black/15 px-3 py-1.5 text-sm whitespace-nowrap hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/**
 * A refused write, said out loud.
 *
 * The optimistic value has already been put back by the time this renders, so
 * without it the screen would simply flicker back to the old figure — which
 * reads as a bug in the app rather than as a rejection by the database.
 */
function Flash({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 z-50 px-6"
      style={{ bottom: `calc(${ABOVE_TAB_BAR} + 0.75rem)` }}
    >
      <div className="mx-auto flex w-full max-w-2xl items-start gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 backdrop-blur-md dark:text-rose-300">
        <span className="min-w-0 flex-1">
          <strong className="font-semibold">That edit did not save.</strong> {message}
        </span>
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100">
          Dismiss
        </button>
      </div>
    </div>
  );
}
