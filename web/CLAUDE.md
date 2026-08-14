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
