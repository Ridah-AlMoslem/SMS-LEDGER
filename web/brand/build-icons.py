#!/usr/bin/env python3
"""Build the app icon set from the Riyal mark.

    pip install cairosvg pillow
    python3 brand/build-icons.py

Run from `web/`. Writes the mark itself to `brand/`, then the four active icon
files Next.js serves. The mark is defined here rather than as a hand-edited SVG
so the rounded and square variants cannot drift apart — they differ only in
corner radius, and the platform-masked variants must not carry rounded corners.
"""

import os

import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
NAME = "arrows-sar"

TILE = "#0A0A0A"    # dark-mode --background in globals.css
INK = "#FFFFFF"
CREDIT = "#34D399"  # emerald-400, money in
DEBIT = "#FB7185"   # rose-400, money out

# The Saudi Riyal symbol, as published by SAMA in 2025. Two paths, native
# viewBox 1124.14 x 1256.39, origin top-left. Copied verbatim from
# Saudi_Riyal_Symbol.svg; only fill and transform are applied.
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


def v_arrow(cx, colour, up):
    """A vertical arrow spanning y 134..378, centred on x = cx.

    Shaft and head overlap by 8px so the rounded shaft cap cannot show as a
    notch where it meets the flat base of the head.
    """
    hw, sw = 29, 28          # head half-width, shaft width
    top, bot, head = 134, 378, 84
    if up:
        return (f'<g fill="{colour}">'
                f'<rect x="{cx - sw / 2:.0f}" y="{top + head - 8}" width="{sw}" '
                f'height="{bot - top - head + 8}" rx="{sw / 2:.0f}"/>'
                f'<path d="M{cx},{top} L{cx + hw},{top + head} L{cx - hw},{top + head} Z"/>'
                f'</g>')
    return (f'<g fill="{colour}">'
            f'<rect x="{cx - sw / 2:.0f}" y="{top}" width="{sw}" '
            f'height="{bot - top - head + 8}" rx="{sw / 2:.0f}"/>'
            f'<path d="M{cx},{bot} L{cx + hw},{bot - head} L{cx - hw},{bot - head} Z"/>'
            f'</g>')


# Money out on the left falling, money in on the right rising, with the Riyal
# glyph between them. The arrows sit inside a 55px margin so neither collides
# with the tile's corner radius.
MARK = (v_arrow(84, DEBIT, up=False)
        + riyal(270, 256, 256)
        + v_arrow(428, CREDIT, up=True))


def doc(inner, rx=114):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
            'width="512" height="512" role="img" aria-label="Ledger">'
            f'<rect width="512" height="512" rx="{rx}" fill="{TILE}"/>{inner}</svg>\n')


def main():
    open(f"{HERE}/{NAME}.svg", "w").write(doc(MARK))
    open(f"{HERE}/{NAME}-full.svg", "w").write(doc(MARK, rx=0))
    cairosvg.svg2png(url=f"{HERE}/{NAME}.svg", write_to=f"{HERE}/{NAME}-512.png",
                     output_width=512, output_height=512)

    # Active set. Next.js picks these up by filename; no <link> tags needed.
    open(f"{WEB}/src/app/icon.svg", "w").write(doc(MARK))

    cairosvg.svg2png(url=f"{HERE}/{NAME}-full.svg",
                     write_to=f"{WEB}/src/app/apple-icon.png",
                     output_width=180, output_height=180)

    cairosvg.svg2png(url=f"{HERE}/{NAME}.svg", write_to=f"{HERE}/.ico-src.png",
                     output_width=256, output_height=256)
    Image.open(f"{HERE}/.ico-src.png").convert("RGBA").save(
        f"{WEB}/src/app/favicon.ico", format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    os.remove(f"{HERE}/.ico-src.png")

    for sz in (192, 512):
        cairosvg.svg2png(url=f"{HERE}/{NAME}-full.svg",
                         write_to=f"{WEB}/public/brand/icon-{sz}.png",
                         output_width=sz, output_height=sz)

    print(f"built {NAME}: icon.svg, favicon.ico, apple-icon.png, manifest icons")


if __name__ == "__main__":
    main()
