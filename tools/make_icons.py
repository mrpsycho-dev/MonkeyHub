#!/usr/bin/env python3
"""Generates MonkeyHub extension icons.

Mark: a rounded "terminal" square in graphite with an amber caret
(">") and a live cursor bar -- reads as "typing" at any size -- plus
a small mint sync-dot standing in for the GitHub sync, tucked into
the corner so it still reads at 16px.
"""
from PIL import Image, ImageDraw, ImageFont

GRAPHITE = (18, 20, 26, 255)      # #12141A
GRAPHITE_2 = (27, 30, 39, 255)    # #1B1E27
AMBER = (245, 196, 83, 255)       # #F5C453
MINT = (95, 209, 164, 255)        # #5FD1A4

SIZES = [16, 19, 32, 38, 48, 128]
MONO_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"


def rounded_square(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(2, int(size * radius_ratio))
    # subtle two-tone panel to keep the flat square from feeling dead
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=GRAPHITE)
    d.rounded_rectangle(
        [0, int(size * 0.55), size - 1, size - 1],
        radius=r,
        fill=GRAPHITE_2,
    )
    # re-clip bottom corners square against the top panel by redrawing full shape mask
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out, d, r


def draw_icon(size):
    img, _, r = rounded_square(size)
    d = ImageDraw.Draw(img)

    # Terminal caret ">" as a solid filled chevron -- filled polygons stay
    # legible at 16px in a way thin strokes never do.
    left = size * 0.27
    right = size * 0.52
    top = size * 0.26
    bot = size * 0.74
    mid_y = size * 0.5
    thick = size * 0.155
    d.polygon(
        [
            (left, top),
            (left + thick, top),
            (right, mid_y),
            (left + thick, bot),
            (left, bot),
            (right - thick, mid_y),
        ],
        fill=AMBER,
    )

    # solid cursor block after the caret
    bar_left = size * 0.63
    bar_right = size * 0.76
    bar_top = size * 0.30
    bar_bot = size * 0.70
    d.rectangle([bar_left, bar_top, bar_right, bar_bot], fill=AMBER)

    # mint sync dot, upper-right, standing in for the GitHub commit
    if size >= 32:
        dot_r = size * 0.085
        dot_cx, dot_cy = size * 0.83, size * 0.185
        d.ellipse(
            [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
            fill=MINT,
        )
    return img


if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(__file__), "..", "src", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for s in SIZES:
        icon = draw_icon(s)
        icon.save(os.path.join(out_dir, f"icon{s}.png"))
        print(f"wrote icon{s}.png")
