import { PeriodHeader } from "@/components/period-header";
import { QueryProvider } from "@/components/query-provider";
import { EmptyState } from "@/components/ui/empty-state";
import { type Facets, type LedgerPage as Page, ledgerFacets, ledgerPage } from "@/db/ledger";
import { dateScope, readFilters } from "@/lib/ledger-filters";
import { readSelection } from "@/lib/period-params";

import { LedgerView } from "./ledger-view";

export const dynamic = "force-dynamic";

/**
 * The ledger — milestone 8 (SPEC §12), and the CRUD surface for everything the
 * parser produces.
 *
 * The server renders the first page and the filter facets; the client owns
 * paging and every edit, through TanStack Query. That split is deliberate: the
 * list has to be on screen at first paint (it is the page), and the edits have
 * to be optimistic with a visible rollback (it is a phone).
 *
 * There is exactly ONE date scope on screen at a time. By default it is the
 * period stepper, which is how you arrive here from Home still looking at
 * August. Setting an explicit range in the filters replaces it and hides the
 * stepper — a control that appears to scope a screen it does not scope invites
 * the reader to believe a total moved because they stepped back a month, and
 * that is a worse failure than having no stepper at all.
 */
export default async function LedgerPage(props: PageProps<"/ledger">) {
  const params = await props.searchParams;

  const { grain, period } = readSelection(params);
  const filters = readFilters(params);
  const scope = dateScope(filters, grain, period);

  let page: Page;
  let facets: Facets;
  try {
    // Sequential, NOT Promise.all. `getDb()` holds one connection against the
    // transaction pooler, and pipelining a third statement onto it stalls
    // forever — the layout is already issuing one of its own for the review
    // badge while this renders. Two round trips is the cost of a page that
    // loads at all; see the note in `db/index.ts`.
    page = await ledgerPage(filters, scope);
    facets = await ledgerFacets(scope);
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Ledger</h1>
        <div className="mt-6">
          <EmptyState
            title="Can't reach the database"
            body={err instanceof Error ? err.message : String(err)}
          />
        </div>
      </main>
    );
  }

  return (
    // Room at the bottom for the floating add button, which would otherwise sit
    // over the last transaction of the last day.
    <main className="pb-20">
      {scope.source === "period" && <PeriodHeader />}

      <h1 className="text-xl font-semibold">Ledger</h1>

      <QueryProvider>
        <LedgerView initialPage={page} facets={facets} filters={filters} scope={scope} />
      </QueryProvider>
    </main>
  );
}
