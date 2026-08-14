# Brand assets

Design sources for the app icon. Nothing here is served — this directory sits
outside `public/` on purpose, so the alternate marks and the preview sheet don't
ride along into the deploy bundle.

![Marks](preview.png)

Every mark is built by [`build-icons.py`](build-icons.py), which also emits the
active icon set. The marks live in that script rather than as hand-edited SVG
files because all seven embed the same two-path Riyal glyph at different sizes
and colours; seven hand-maintained copies is how they drift apart.

## The marks

| Name | Description |
|---|---|
| **`arrows-sar`** | **Active.** The previous in/out arrows with the Riyal glyph in place of the balance rule. Arrows carry less weight than they did as a standalone mark so the glyph reads as the subject and they read as the frame |
| `sar-solo` | The glyph alone, as large as the tile allows. The plainest statement of what the app counts |
| `sar-duotone` | Glyph split on the canvas midline, credit colour above and debit below |
| `sar-bubble` | Glyph knocked out of the SMS bubble — currency and the source the ledger is built from, in one mark |
| `sar-disc` | Glyph knocked out of a solid emerald disc. Reads as a coin, and the closed outer silhouette makes it the most legible of the set at 16px |
| `sar-ring` | Glyph inside a two-arc flow ring, money in on one side and out on the other |
| `sar-rows` | Glyph beside three ledger rows |

Palette matches `globals.css` and the transaction colours already in the UI, so
the icon and the rows in the dashboard agree:

| Role | Hex | Also used for |
|---|---|---|
| Tile | `#0A0A0A` | Dark-mode `--background` |
| Ink | `#FFFFFF` | — |
| Credit / in | `#34D399` | `emerald-400` amounts |
| Debit / out | `#FB7185` | `rose-400` amounts |

### A caveat on the Riyal glyph at favicon size

The glyph is genuinely detailed — two tall stems, a crossbar, and three angled
bars. At 32px and up every mark here reads. At 16px the glyph's interior fills
in and it degrades to a textured smudge, which the pre-Riyal arrows mark did
not do. `sar-disc` and `sar-bubble` survive best, because a closed outer
silhouette still says *something* once the interior is gone. If the tab-strip
icon matters more than the currency reference, that is the tradeoff being made,
and those two are the marks to prefer.

Each mark also has a `-full` variant with square corners. Android and iOS mask
installed icons themselves, so maskable and apple-touch artwork must not arrive
with the rounded corners already baked in or it gets double-rounded.

## Where the active mark is wired

Next.js App Router picks these up by filename — no `<link>` tags in `layout.tsx`:

| Path | Emits |
|---|---|
| `src/app/icon.svg` | `<link rel="icon">`, the tab favicon on modern browsers |
| `src/app/favicon.ico` | `/favicon.ico`, multi-resolution 16/32/48/64 for older browsers and bookmark bars |
| `src/app/apple-icon.png` | `<link rel="apple-touch-icon">`, 180×180 full-bleed |
| `public/brand/icon-{192,512}.png` | Referenced by `src/app/manifest.ts` as maskable PWA icons |

`layout.tsx` also sets `viewport.themeColor` to `#0a0a0a` so the browser chrome
and the iOS status bar match the tile.

## Rebuilding, and switching marks

```bash
cd web
pip install cairosvg pillow

python3 brand/build-icons.py             # rebuild all marks from ACTIVE
python3 brand/build-icons.py sar-disc    # switch the active mark
```

Passing a name regenerates `icon.svg`, `favicon.ico`, `apple-icon.png` and both
manifest PNGs from that mark. To make the change stick for later rebuilds, also
set `ACTIVE` at the top of the script.

Then hard-reload — browsers cache favicons aggressively, and a normal refresh
will keep showing the old one.

## Provenance

`Saudi_Riyal_Symbol.svg` is the currency symbol published by the Saudi Central
Bank (SAMA) in 2025. The two path definitions are inlined verbatim in
`build-icons.py`; only fill and transform are applied.
