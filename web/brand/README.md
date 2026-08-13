# Brand assets

Design source for the app icon. Nothing here is served — this directory sits
outside `public/` on purpose, so the source SVG and the preview sheet don't ride
along into the deploy bundle.

![Preview](preview.png)

## The mark

Two opposing arrows over a balance rule: money in on top, money out below. It
reads as flow rather than as a letterform, which suits a ledger that is built
from a stream of incoming messages rather than from manual entry.

Colors match `globals.css` and the transaction colors already used in the UI, so
the icon and the rows in the dashboard agree:

| Role | Hex | Also used for |
|---|---|---|
| Tile | `#0A0A0A` | Dark-mode `--background` |
| Balance rule | `#FFFFFF` | — |
| Credit / in | `#34D399` | `emerald-400` amounts |
| Debit / out | `#FB7185` | `rose-400` amounts |

Arrowheads are deliberately oversized relative to their shafts. At 16px an
arrowhead drawn in proportion collapses into the shaft and the mark degrades
into three flat bars; at these proportions the silhouette still widens in the
direction of travel. Below 16px the direction is gone regardless — that is the
floor of the format, not a fixable drawing problem.

`c-arrows-full.svg` is the same artwork with square corners. Android and iOS
mask installed icons themselves, so maskable and apple-touch artwork must not
arrive with the rounded corners already baked in or it gets double-rounded.

## Where it is wired

Next.js App Router picks these up by filename — no `<link>` tags in `layout.tsx`:

| Path | Emits |
|---|---|
| `src/app/icon.svg` | `<link rel="icon">`, the tab favicon on modern browsers |
| `src/app/favicon.ico` | `/favicon.ico`, multi-resolution 16/32/48/64 for older browsers and bookmark bars |
| `src/app/apple-icon.png` | `<link rel="apple-touch-icon">`, 180×180 full-bleed |
| `public/brand/icon-{192,512}.png` | Referenced by `src/app/manifest.ts` as maskable PWA icons |

`layout.tsx` also sets `viewport.themeColor` to `#0a0a0a` so the browser chrome
and the iOS status bar match the tile.

## Regenerating

Edit `c-arrows.svg`, then rebuild the derived files. Requires `cairosvg`
(`pip install cairosvg`) and Pillow:

```bash
cd web

# keep the full-bleed variant in sync with the rounded one
sed 's|rx="114" fill="#0A0A0A"|fill="#0A0A0A"|' brand/c-arrows.svg > brand/c-arrows-full.svg
cp brand/c-arrows.svg src/app/icon.svg

python3 - <<'PY'
import cairosvg
from PIL import Image

cairosvg.svg2png(url="brand/c-arrows-full.svg", write_to="src/app/apple-icon.png",
                 output_width=180, output_height=180)

cairosvg.svg2png(url="brand/c-arrows.svg", write_to="/tmp/_ico.png",
                 output_width=256, output_height=256)
Image.open("/tmp/_ico.png").convert("RGBA").save(
    "src/app/favicon.ico", format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

for sz in (192, 512):
    cairosvg.svg2png(url="brand/c-arrows-full.svg",
                     write_to=f"public/brand/icon-{sz}.png",
                     output_width=sz, output_height=sz)
PY
```

Then hard-reload — browsers cache favicons aggressively, and a normal refresh
will keep showing the old one.
