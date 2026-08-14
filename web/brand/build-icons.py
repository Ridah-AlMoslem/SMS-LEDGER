#!/usr/bin/env python3
"""Generate every brand mark, then the active icon set from whichever one is
selected.

    pip install cairosvg pillow
    python3 brand/build-icons.py            # rebuild from ACTIVE
    python3 brand/build-icons.py sar-disc   # switch the active mark

Run from `web/`. The marks are defined here rather than hand-edited as SVG
files because all of them embed the same Riyal glyph at different sizes and
colours, and keeping seven hand-maintained copies of a 2-path glyph in sync is
how they drift apart.
"""

import math
import os
import sys

import cairosvg
from PIL import Image

ACTIVE = "arrows-sar"

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

TILE = "#0A0A0A"    # dark-mode --background in globals.css
INK = "#FFFFFF"
CREDIT = "#34D399"  # emerald-400, money in
DEBIT = "#FB7185"   # rose-400, money out

# The Saudi Riyal symbol, as published by SAMA. Two paths, native viewBox
# 1124.14 x 1256.39, origin at top-left.
RIYAL_W, RIYAL_H = 1124.14, 1256.39
RIYAL = (
    "M699.62,1113.02h0c-20.06,44.48-33.32,92.75-38.4,143.37l424.51-90.24c20.06-44.47,"
    "33.31-92.75,38.4-143.37l-424.51,90.24Z",
    "M1085.73,895.8c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.33v-135.2l292.27-62.11"
    "c20.06-44.47,33.32-92.75,38.4-143.37l-330.68,70.27V66.13c-50.67,28.45-95.67,66.32-132.25,"
    "110.99v403.35l-132.25,28.11V0c-50.67,28.44-95.67,66.32-132.25,110.99v525.69l-295.91,62.88"
    "c-20.06,44.47-33.33,92.75-38.42,143.37l334.33-71.05v170.26l-358.3,76.14c-20.06,44.47-33.32,"
    "92.75-38.4,143.37l375.04-79.7c30.53-6.35,56.77-24.4,73.83-49.24l68.78-101.97v-.02c7.14-10.55,"
    "11.3-23.27,11.3-36.97v-149.98l132.25-28.11v270.4l424.53-90.28Z",
)


def riyal(h, cx, cy, fill=INK):
    """The Riyal glyph, `h` tall, centred on (cx, cy) of the 512 canvas."""
    s = h / RIYAL_H
    tx, ty = cx - (RIYAL_W * s) / 2, cy - h / 2
    body = "".join(f'<path d="{d}"/>' for d in RIYAL)
    return (f'<g transform="translate({tx:.2f},{ty:.2f}) scale({s:.5f})" '
            f'fill="{fill}">{body}</g>')


def clipped(inner, x, y, w, h, cid):
    """Clip `inner` to a canvas-space rect.

    clip-path resolves in the clipped element's own user space, so the glyph's
    translate/scale has to sit on a child group. Putting both on one element
    clips in glyph coordinates and the mark all but vanishes.
    """
    return (f'<defs><clipPath id="{cid}"><rect x="{x}" y="{y}" width="{w}" '
            f'height="{h}"/></clipPath></defs>'
            f'<g clip-path="url(#{cid})">{inner}</g>')


def arc_arrow(cx, cy, r, a0, a1, w, colour):
    """Arc from a0 to a1 degrees (y-down, clockwise) with a head at a1."""
    p0 = (cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0)))
    p1 = (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1)))
    large = 1 if abs(a1 - a0) > 180 else 0
    return (f'<path d="M{p0[0]:.1f},{p0[1]:.1f} A{r},{r} 0 {large} 1 '
            f'{p1[0]:.1f},{p1[1]:.1f}" fill="none" stroke="{colour}" '
            f'stroke-width="{w}" stroke-linecap="round"/>'
            f'<path d="M0,{-w * 1.35:.1f} L{w * 1.5:.1f},0 L0,{w * 1.35:.1f} Z" '
            f'fill="{colour}" transform="translate({p1[0]:.1f},{p1[1]:.1f}) '
            f'rotate({a1 + 90:.1f})"/>')


MARKS = {
    # The shipped in/out arrows with the Riyal glyph in place of the balance
    # rule. The arrows are lighter than they were as a standalone mark so the
    # glyph reads as the subject and they read as the frame.
    "arrows-sar": (
        f'<g fill="{CREDIT}"><rect x="126" y="79" width="168" height="34" rx="17"/>'
        f'<path d="M278 62l96 34-96 34z"/></g>'
        + riyal(210, 256, 260)
        + f'<g fill="{DEBIT}"><rect x="218" y="399" width="168" height="34" rx="17"/>'
        f'<path d="M234 382l-96 34 96 34z"/></g>'),

    "sar-solo": riyal(320, 256, 256),

    "sar-duotone": (clipped(riyal(320, 256, 256, CREDIT), 0, 0, 512, 256, "t")
                    + clipped(riyal(320, 256, 256, DEBIT), 0, 256, 512, 256, "b")),

    "sar-bubble": (
        '<path d="M160 88h192a72 72 0 0 1 72 72v160a72 72 0 0 1-72 72H236l-70 56a10 10 0 0 '
        '1-16-8v-48h-6a72 72 0 0 1-72-72V160a72 72 0 0 1 72-72Z" fill="#FFFFFF"/>'
        + riyal(180, 256, 240, TILE)),

    # One closed silhouette, so it keeps a readable shape at 16px where the
    # open marks lose their interior detail.
    "sar-disc": (f'<circle cx="256" cy="256" r="170" fill="{CREDIT}"/>'
                 + riyal(200, 256, 256, TILE)),

    "sar-ring": (arc_arrow(256, 256, 186, -68, 68, 26, CREDIT)
                 + arc_arrow(256, 256, 186, 112, 248, 26, DEBIT)
                 + riyal(212, 256, 256)),

    "sar-rows": (
        f'<g><rect x="74" y="140" width="118" height="26" rx="13" fill="{CREDIT}"/>'
        f'<rect x="74" y="243" width="84" height="26" rx="13" fill="#FFFFFF" opacity=".35"/>'
        f'<rect x="74" y="346" width="118" height="26" rx="13" fill="{DEBIT}"/></g>'
        + riyal(280, 330, 256)),
}


def doc(inner, rx=114):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
            'width="512" height="512" role="img" aria-label="Ledger">'
            f'<rect width="512" height="512" rx="{rx}" fill="{TILE}"/>{inner}</svg>\n')


def main(active=ACTIVE):
    if active not in MARKS:
        sys.exit(f"unknown mark {active!r}; pick one of {', '.join(MARKS)}")

    for name, inner in MARKS.items():
        # Rounded for browser and desktop use; square for anywhere the platform
        # applies its own mask, which would otherwise double-round the corners.
        open(f"{HERE}/{name}.svg", "w").write(doc(inner))
        open(f"{HERE}/{name}-full.svg", "w").write(doc(inner, rx=0))
        cairosvg.svg2png(url=f"{HERE}/{name}.svg", write_to=f"{HERE}/{name}-512.png",
                         output_width=512, output_height=512)

    # Active set. Next.js picks these up by filename; no <link> tags needed.
    with open(f"{WEB}/src/app/icon.svg", "w") as fh:
        fh.write(doc(MARKS[active]))

    cairosvg.svg2png(url=f"{HERE}/{active}-full.svg",
                     write_to=f"{WEB}/src/app/apple-icon.png",
                     output_width=180, output_height=180)

    cairosvg.svg2png(url=f"{HERE}/{active}.svg", write_to=f"{HERE}/.ico-src.png",
                     output_width=256, output_height=256)
    Image.open(f"{HERE}/.ico-src.png").convert("RGBA").save(
        f"{WEB}/src/app/favicon.ico", format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    os.remove(f"{HERE}/.ico-src.png")

    for sz in (192, 512):
        cairosvg.svg2png(url=f"{HERE}/{active}-full.svg",
                         write_to=f"{WEB}/public/brand/icon-{sz}.png",
                         output_width=sz, output_height=sz)

    print(f"built {len(MARKS)} marks; active = {active}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ACTIVE)
