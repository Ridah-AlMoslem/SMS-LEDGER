@AGENTS.md

# UI conventions

Read these before adding anything visual. They exist because the alternative
was found in this codebase and removed.

## A balance is never written, only booked

`accounts.current_balance` is derived. `recompute_balances` in `api/db.py`
rewrites it as `opening_balance + Σ(posted legs)` on every parser tick, so a
screen that UPDATEs the column has its change erased within the minute — and
the erasure is silent.

Editing a balance therefore books the difference as a transaction of type
`adjustment` (`origin='manual'`, `excluded_from_analytics`), which the next
recompute counts and arrives at the same figure. `src/db/account-edit.ts` is
the only place that does this; `npm run test:account-edit` runs the parser's
own recompute SQL against an edited account to prove the edit survives it.

Anything else that lets a person change a stored figure should work the same
way: change the events, let the figure follow. The same test file is where the
§3.3a guards live — `is_liability` derived from the type, `available_credit`
refused without a credit limit — because both of those, read backwards, move
net worth by roughly a credit limit.

## Never `Promise.all` two queries

Home was rebuilt around this once (`b09932e`) and the ledger's facets had to be
rebuilt around it again, so it is worth stating as a rule rather than as a war
story: **a `Promise.all` of independent queries hangs the entire app.**

Dispatching several statements onto one transaction-pooler connection in a
single tick gets the first two answered and the rest stalled permanently — no
error, no timeout, still hung at 25 seconds. `getDb()` is a module-level
singleton, so everything behind it hangs too, and the symptom is Home, Ledger
and Accounts all sitting on their loading spinner with nothing in any log. It
does not reproduce locally against PGlite, which is in-process and has no pooler
in front of it.

Concurrency *across requests* is fine — those queue on the connection rather
than pipelining onto it. It is the fan-out inside one render that kills it.

So: one combined statement, or sequential `await`s. `db/aggregates.ts` embeds
the cycle totals twice in one SELECT, `db/home.ts` composes the whole page into
one, and `ledgerFacets` returns its three lists as three `json_agg` sub-selects.
Widening the pool is not the alternative and was measured not to be — 12
concurrent statements stall identically at `max: 4`.

## Writing a field by hand locks it, and only `db/` may write

Every mutation on a transaction goes through `src/db/ledger-mutations.ts`, which
takes the db as an argument and imports nothing from `next/*`. The server
actions in `app/ledger/actions.ts` are arguments-in, result-out and hold no
logic at all, because a server action cannot be called from a test file without
a Next runtime around it — anything that lives there is effectively unverified.

What must not be reimplemented anywhere else:

- **An edit adds its column to `locked_fields`, in the same statement.** §9.4 is
  the promise that an improved parser cannot revert your corrections, and
  `db/replay.ts` enforces it on the way back in. A bulk action locks too; it is
  the edit most likely to be undone en masse. A *rule* does not lock — a lock
  means a person decided, and a rule is not a person.
- **`locked_fields` is a JSON array, never an object.** The guard is
  `locked_fields ? 'category_id'`, and `?` tests keys on an object — a row
  storing `{"category_id": true}` would read as locked to one query and unlocked
  to another. Migration 0008 has the check constraint.
- **Deleting marks the raw message `ignored`/`user`.** Otherwise the next tick
  re-derives the transaction and the delete undoes itself (§9.4.3).
- **Editing an amount is a balance change.** The trigger in migration 0008
  recomputes the account and re-derives its open reconciliation alerts, because
  balances here are derived and the screen would otherwise state a figure the
  ledger no longer supports. It deliberately does not fire on INSERT — the
  parser batches — so `createManual` calls `refresh_reconciliation` itself.

`npm run test:ledger` runs all of that against real Postgres, including the
three §9.4 replay guarantees and that a rule's dry-run count is exactly what
applying it changes.

## Period-scoped lists filter on the bucket, never on a date range

`effective_cycle(posted_at, cycle_override) = $1`, the same way `db/aggregates.ts`
does — not `posted_at BETWEEN start AND end`. §5.6 puts an early salary in the
cycle it *funds*, so the August cycle contains a 23 July transaction; a BETWEEN
drops it and the list disagrees with the total on the screen you arrived from by
one salary. Weeks are the opposite and equally fixed: `week_start(local_date())`
ignores the override, because a week is a literal date range.

There is also only ever **one date scope on screen**. The Ledger's period
stepper scopes it by default; an explicit range in the filters replaces it and
`page.tsx` hides the stepper. A stepper that no longer scopes what is beneath it
invites the reader to believe a total moved because they stepped back a month.

## The rollover carry is read, never recomputed

`budgets.carry_in` is written once, by `closeCycle` in `db/budgets.ts`, when a
cycle ends — and `carry_closed_at` is what stops anything asking again. Nothing
anywhere may derive it by folding over history, however tempting the fold looks:
that is precisely the cascade §11.2 forbids, where correcting one mis-parsed
purchase from March moves April's carry, which moves May's, which moves the
allowance on the screen in front of you today.

Home used to fold six cycles of history at read time. It now reads the column,
because two screens deriving the same figure two ways is the failure the rest of
this file is about — and Plan cannot fold, since a settled carry is the only
thing that makes "last cycle is over" true.

`carryForward()` in `lib/pace.ts` is the whole of the arithmetic and takes one
closing cycle. There is deliberately no function that takes a history.
`resetCarry` (§11.2's escape hatch) is the only other thing that moves the
figure, and it stamps `carry_closed_at` too — otherwise the next nightly close
would helpfully put the drift back and the button would look broken.

`npm run test:budgets` asserts the no-cascade property *and* measures the
counterfactual, so the test proves the cascade was real rather than absent.

## Optimistic edits roll back visibly

TanStack Query is mounted per screen (`components/query-provider.tsx`), not in
the layout — Ledger is the only page with a client cache. Every mutation in
`app/ledger/use-ledger.ts` snapshots the cache, patches it, and on failure puts
the old value back *and* raises a message. Both halves: a row that snaps back
with no explanation reads as a rendering bug, and a message with no snap-back
leaves a figure on screen that is not in the database.

Server actions return `{ok: false, error}` rather than throwing, so every
`mutationFn` re-throws it. Miss that and React Query treats a refused edit as a
success and leaves the optimistic value in place — the silent-drop failure the
whole arrangement exists to prevent.

**Plan edits without a query client, and owes the same two halves.** Its panels
use `useOptimistic` inside a `useTransition`: React drops the patch when the
transition ends, so a refused edit snaps back on its own, and the message beside
it is not optional for the same reason as above. Don't mount a second
`QueryProvider` to get this — there is no list to page through here, and the
server action's `revalidatePath` is what brings the real figures back.

## Waiting states: use `<Loader>`, never a new spinner

`src/components/ui/loader.tsx` is the only waiting indicator in this app. It is
the app mark — the Riyal glyph flanked by the two in/out arrows — with the
arrows travelling in opposite directions.

```tsx
import { Loader, PageLoader } from "@/components/ui/loader";

<PageLoader label="Loading ledger" />              // route-level loading.tsx
<Loader size={40} label="Reparsing" />             // in-page block
<Loader size={16} variant="arrows" label="…" />    // inline: buttons, rows
```

- **Do not** add a CSS spinner, a `animate-spin` border trick, a skeleton
  shimmer library, or a second loading component. One waiting state, used
  everywhere, is how a wait stays recognisable as *this* app waiting.
- `variant="arrows"` drops the glyph and closes the gap. Use it below ~28px;
  the glyph is detailed and becomes a smudge at inline sizes.
- Always pass a meaningful `label`. It is announced via `role="status"`, and
  "Loading" alone tells a screen-reader user nothing they didn't already know.
- Keyframes live in `globals.css` (`ledger-fall` / `ledger-rise`) and are
  already suppressed under `prefers-reduced-motion`. Don't re-implement that
  per component.

**Every route needs a `loading.tsx`.** Every page here is `force-dynamic` and
reads Postgres, so a tab with no loading file appears to do nothing until the
server answers. Follow the existing ones: static `<h1>` first so the page
announces which tab you landed on, then `<PageLoader>`.

## Charts: one palette, defined in CSS, validated once

Every chart colour is a custom property in `globals.css` — `--chart-in`,
`--chart-out`, `--chart-1..6`, `--chart-heat-1..4`, `--chart-grid`,
`--chart-axis`, `--chart-ink` — and `src/lib/chart-theme.ts` is the TypeScript
handle on them. SVG attributes take `var()`, so recharts reads them directly and
light/dark is one definition instead of a `prefers-color-scheme` branch inside
every component. **Do not put a hex in a chart.**

- **`seriesColorAt(i)` assigns slots in order and never skips.** The palette is
  validated for *adjacent* pairs — the case where two bands of a stack touch —
  and the same six colours fail an all-pairs check at ΔE 1.6 under deuteranopia.
  So position decides the slot, one page decides the order once, and any second
  chart on that page is handed the same map or drops colour entirely (the cycle
  flow list has no swatches for exactly this reason). Past six series, fold the
  rest into a grey "Other" (`foldToOther`).
- **The `categories.color` column is not used for charts.** Those seeded values
  were picked per family and several adjacent pairs collapse under protanopia. A
  settings screen that offers colour editing has to validate against the same
  checks before those values can drive a chart.
- **Magnitude is a ramp, not a palette.** The heatmap uses one hue — the debit
  hue — in four monotone steps, with a separate rest tone for days with no
  spending. A day with nothing on it is a fact, not a low value.
- **11px is the floor for a tick label** (`AXIS_FONT`). At 390px a chart that
  does not fit drops or rotates ticks; it never shrinks the type.
- **Every multi-series chart ships a legend and a table view.** Identity is
  never carried by colour alone, three of the light-mode steps sit below 3:1 on
  white, and the table is the only form of a chart a screen reader can read.
  `ChartFrame` takes both; put the table in the expanded sheet.
- **Partial buckets are hatched and labelled "N of 7 days"** (§5.3). A one-day
  bar beside seven-day bars reads as a spending collapse that never happened.

Colours were chosen with the validator in the `dataviz` skill (OKLCH lightness
band, chroma floor, protan/deutan ΔE, normal-vision floor, contrast vs each
surface). If you change one, re-run it for both surfaces — `#ffffff` and
`#0a0a0a` — rather than eyeballing the result.

## The mark lives in two places, and a test keeps them honest

- `brand/build-icons.py` generates `icon.svg`, `favicon.ico`, `apple-icon.png`
  and the manifest PNGs. Python, build time.
- `src/lib/brand.ts` holds the same glyph paths and colours for anything
  rendered at runtime. TypeScript.

Neither can import the other, so `npm run test:brand` asserts they still agree
— glyph paths, viewBox, colours, and the arrow geometry the loader redraws in
TSX. It runs as part of `npm run test:ui`. If you change the mark, change both
and run the test; it will tell you which half you forgot.

Colours are `#34D399` (credit, money in) and `#FB7185` (debit, money out),
matching the `emerald-400` / `rose-400` already used for amounts. Take them
from `BRAND` in `src/lib/brand.ts` rather than retyping the hex.

To redraw the icon set after editing the mark:

```bash
pip install cairosvg pillow
python3 brand/build-icons.py
```

See `brand/README.md` for the geometry constraints that are worth not breaking.
