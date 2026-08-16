"use client";

/**
 * Search, and the filter chips (SPEC §11.1).
 *
 * Every filter is a URL parameter, so a filtered view is a link, the back
 * button steps back through filters instead of out of the page, and the server
 * renders the first page of exactly what you asked for. `lib/ledger-filters.ts`
 * owns the parsing; this file only ever asks it to set or clear one.
 *
 * The chip row scrolls horizontally and never wraps. Eleven filters wrapped
 * onto three lines push the transactions off a phone screen entirely, and the
 * list is what you came for — the filters are how you narrow it.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Chip } from "@/components/ui/chip";
import { Sheet } from "@/components/ui/sheet";
import type { Facets } from "@/db/ledger";
import {
  type DateScope,
  type LedgerFilters,
  PARAM,
  TRANSACTION_TYPES,
  TYPE_LABELS,
  activeCount,
  withParam,
  withParams,
  withoutFilters,
} from "@/lib/ledger-filters";
import { civilShort } from "@/lib/periods";

const field =
  "mt-1 w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

type PickerKind = "account" | "category" | "merchant" | "dates" | "amount" | "type" | null;

export function FilterBar({
  filters,
  facets,
  scope,
}: {
  filters: LedgerFilters;
  facets: Facets;
  scope: DateScope;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const [picker, setPicker] = useState<PickerKind>(null);

  const go = (query: string) => router.push(`${pathname}?${query}`, { scroll: false });
  const set = (name: string, value: string | null) => go(withParam(params, name, value));
  const setMany = (patch: Record<string, string | null>) => go(withParams(params, patch));

  const account = facets.accounts.find((a) => a.id === filters.accountId);
  const category = facets.categories.find((c) => c.id === filters.categoryId);
  const active = activeCount(filters);

  return (
    <>
      <Search />

      {/* Negative margins so the row bleeds to the screen edge: a scrolling
          strip that stops short of the edge reads as a row that has ended. */}
      <div className="-mx-6 mt-3 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex w-max items-center gap-2 pb-1">
          <Chip selected={!!filters.accountId} onClick={() => setPicker("account")}>
            {account ? account.name : "Account"}
          </Chip>

          <Chip selected={!!filters.categoryId} onClick={() => setPicker("category")}>
            {filters.categoryId === "none"
              ? "Uncategorized"
              : category
                ? category.name
                : "Category"}
          </Chip>

          <Chip selected={!!filters.merchant} onClick={() => setPicker("merchant")}>
            {filters.merchant ?? "Merchant"}
          </Chip>

          <Chip selected={scope.source !== "period"} onClick={() => setPicker("dates")}>
            {dateChipLabel(scope)}
          </Chip>

          <Chip
            selected={!!(filters.min || filters.max)}
            onClick={() => setPicker("amount")}
          >
            {amountChipLabel(filters)}
          </Chip>

          <Chip selected={!!filters.type} onClick={() => setPicker("type")}>
            {filters.type ? TYPE_LABELS[filters.type] : "Type"}
          </Chip>

          {/* Direction cycles rather than opening a sheet: two values and a
              cleared state is a shorter journey by tapping than by picking. */}
          <Chip
            selected={!!filters.direction}
            onClick={() =>
              set(
                PARAM.direction,
                filters.direction === null ? "debit" : filters.direction === "debit" ? "credit" : null,
              )
            }
          >
            {filters.direction === "debit"
              ? "Money out"
              : filters.direction === "credit"
                ? "Money in"
                : "Direction"}
          </Chip>

          <Chip
            selected={!!filters.internal}
            onClick={() =>
              set(
                PARAM.internal,
                filters.internal === null ? "hide" : filters.internal === "hide" ? "only" : null,
              )
            }
          >
            {filters.internal === "hide"
              ? "No internal"
              : filters.internal === "only"
                ? "Internal only"
                : "Internal"}
          </Chip>

          <Chip
            selected={filters.uncategorized}
            onClick={() => set(PARAM.uncategorized, filters.uncategorized ? null : "1")}
          >
            Uncategorized
          </Chip>

          <Chip
            selected={filters.needsReview}
            onClick={() => set(PARAM.needsReview, filters.needsReview ? null : "1")}
          >
            Needs review
          </Chip>

          <Chip
            selected={filters.manual}
            onClick={() => set(PARAM.manual, filters.manual ? null : "1")}
          >
            Manual
          </Chip>

          {active > 0 && (
            <button
              type="button"
              onClick={() => go(withoutFilters(params))}
              className="shrink-0 px-2 py-1.5 text-sm whitespace-nowrap opacity-60 hover:opacity-100"
            >
              Clear {active}
            </button>
          )}
        </div>
      </div>

      <Picker
        kind={picker}
        onClose={() => setPicker(null)}
        filters={filters}
        facets={facets}
        scope={scope}
        set={set}
        setMany={setMany}
      />
    </>
  );
}

/* ---------------------------------------------------------------- search */

function Search() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const urlQ = params.get(PARAM.q) ?? "";
  const [value, setValue] = useState(urlQ);

  // The URL is the source of truth, so a back-button navigation has to move the
  // input. Tracked by the value we last pushed, so this cannot fight the person
  // typing.
  const pushed = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== pushed.current) {
      pushed.current = urlQ;
      setValue(urlQ);
    }
  }, [urlQ]);

  useEffect(() => {
    if (value === pushed.current) return;

    // Debounced, and `replace` rather than `push`: a search typed one letter at
    // a time would otherwise leave eight entries in the history and take eight
    // back-taps to escape.
    const timer = setTimeout(() => {
      pushed.current = value;
      router.replace(`${pathname}?${withParam(params, PARAM.q, value || null)}`, { scroll: false });
    }, 300);

    return () => clearTimeout(timer);
  }, [value, params, pathname, router]);

  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        dir="auto"
        // The point of the whole feature: the raw message body is searched, not
        // just the fields parsed out of it. Saying so is what makes anyone try
        // it with half a word they remember from the SMS.
        placeholder="Search the message text, merchant, biller…"
        aria-label="Search transactions, including the raw message text"
        className="w-full rounded-lg border border-black/12 bg-transparent px-3 py-2 text-sm dark:border-white/18"
      />
    </div>
  );
}

/* --------------------------------------------------------------- pickers */

function Picker({
  kind,
  onClose,
  filters,
  facets,
  scope,
  set,
  setMany,
}: {
  kind: PickerKind;
  onClose: () => void;
  filters: LedgerFilters;
  facets: Facets;
  scope: DateScope;
  set: (name: string, value: string | null) => void;
  setMany: (patch: Record<string, string | null>) => void;
}) {
  const choose = (name: string, value: string | null) => {
    set(name, value);
    onClose();
  };

  return (
    <Sheet open={kind !== null} onClose={onClose} title={TITLES[kind ?? "account"]}>
      {kind === "account" && (
        <Options
          options={[
            { value: null, label: "Any account" },
            ...facets.accounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
          selected={filters.accountId}
          onPick={(v) => choose(PARAM.account, v)}
        />
      )}

      {kind === "category" && (
        <Options
          options={[
            { value: null, label: "Any category" },
            { value: "none", label: "Uncategorized only" },
            ...facets.categories.map((c) => ({
              value: c.id,
              label: c.parentName ? `${c.parentName} › ${c.name}` : c.name,
            })),
          ]}
          selected={filters.categoryId}
          onPick={(v) => choose(PARAM.category, v)}
        />
      )}

      {kind === "merchant" && (
        <>
          <p className="-mt-1 mb-3 text-xs opacity-55">
            The merchants and billers seen in this date range, most frequent first.
          </p>
          <Options
            options={[
              { value: null, label: "Any merchant" },
              ...facets.merchants.map((m) => ({
                value: m.value,
                label: m.value,
                count: m.count,
              })),
            ]}
            selected={filters.merchant?.toLowerCase() ?? null}
            onPick={(v) => choose(PARAM.merchant, v)}
          />
        </>
      )}

      {kind === "dates" && <DatePicker filters={filters} scope={scope} setMany={setMany} onClose={onClose} />}

      {kind === "amount" && <AmountPicker filters={filters} setMany={setMany} onClose={onClose} />}

      {kind === "type" && (
        <Options
          options={[
            { value: null, label: "Any type" },
            ...TRANSACTION_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })),
          ]}
          selected={filters.type}
          onPick={(v) => choose(PARAM.type, v)}
        />
      )}
    </Sheet>
  );
}

const TITLES: Record<NonNullable<PickerKind>, string> = {
  account: "Account",
  category: "Category",
  merchant: "Merchant",
  dates: "Date range",
  amount: "Amount range",
  type: "Type",
};

function Options({
  options,
  selected,
  onPick,
}: {
  options: { value: string | null; label: string; count?: number }[];
  selected: string | null;
  onPick: (value: string | null) => void;
}) {
  return (
    <ul className="max-h-[60vh] divide-y divide-black/8 overflow-y-auto dark:divide-white/10">
      {options.map((o) => (
        <li key={o.value ?? "any"}>
          <button
            type="button"
            onClick={() => onPick(o.value)}
            aria-current={o.value === selected ? "true" : undefined}
            className="flex w-full items-center gap-3 py-2.5 text-left text-sm"
          >
            <span
              aria-hidden
              className={`w-4 shrink-0 ${o.value === selected ? "opacity-100" : "opacity-0"}`}
            >
              ✓
            </span>
            <span className="sms-body min-w-0 flex-1 truncate">{o.label}</span>
            {o.count !== undefined && (
              <span className="tabular shrink-0 text-xs opacity-45">{o.count}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function DatePicker({
  filters,
  scope,
  setMany,
  onClose,
}: {
  filters: LedgerFilters;
  scope: DateScope;
  setMany: (patch: Record<string, string | null>) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(filters.from ?? "");
  const [to, setTo] = useState(filters.to ?? "");

  const apply = (patch: Record<string, string | null>) => {
    setMany(patch);
    onClose();
  };

  return (
    <div className="pb-2">
      <p className="-mt-1 text-xs opacity-55">
        The period stepper above scopes this list. Setting a range here replaces it — and hides
        it, because a stepper that no longer scopes what is beneath it is worse than none.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Chip
          selected={scope.source === "period"}
          onClick={() => apply({ [PARAM.from]: null, [PARAM.to]: null, [PARAM.allTime]: null })}
        >
          Follow the period
        </Chip>
        <Chip
          selected={scope.source === "all"}
          onClick={() => apply({ [PARAM.from]: null, [PARAM.to]: null, [PARAM.allTime]: "1" })}
        >
          All time
        </Chip>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block text-xs">
          <span className="opacity-70">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={`${field} tabular`}
          />
        </label>
        <label className="block text-xs">
          <span className="opacity-70">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`${field} tabular`}
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() =>
          apply({
            [PARAM.from]: from || null,
            [PARAM.to]: to || null,
            [PARAM.allTime]: null,
          })
        }
        className="mt-4 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      >
        Apply range
      </button>
    </div>
  );
}

function AmountPicker({
  filters,
  setMany,
  onClose,
}: {
  filters: LedgerFilters;
  setMany: (patch: Record<string, string | null>) => void;
  onClose: () => void;
}) {
  const [min, setMin] = useState(filters.min ?? "");
  const [max, setMax] = useState(filters.max ?? "");

  return (
    <div className="pb-2">
      <p className="-mt-1 text-xs opacity-55">
        Matched against the amount as booked, which is always positive — direction is a separate
        filter.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block text-xs">
          <span className="opacity-70">At least</span>
          <input
            inputMode="decimal"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder="0.00"
            className={`${field} tabular`}
          />
        </label>
        <label className="block text-xs">
          <span className="opacity-70">At most</span>
          <input
            inputMode="decimal"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder="—"
            className={`${field} tabular`}
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() => {
          setMany({ [PARAM.min]: min || null, [PARAM.max]: max || null });
          onClose();
        }}
        className="mt-4 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      >
        Apply
      </button>
    </div>
  );
}

function dateChipLabel(scope: DateScope): string {
  if (scope.source === "all") return "All time";
  if (scope.source === "period") return "Dates";
  if (scope.from && scope.to) return `${civilShort(scope.from)} – ${civilShort(scope.to)}`;
  if (scope.from) return `From ${civilShort(scope.from)}`;
  return `Until ${civilShort(scope.to!)}`;
}

function amountChipLabel(filters: LedgerFilters): string {
  if (filters.min && filters.max) return `${filters.min} – ${filters.max}`;
  if (filters.min) return `≥ ${filters.min}`;
  if (filters.max) return `≤ ${filters.max}`;
  return "Amount";
}
