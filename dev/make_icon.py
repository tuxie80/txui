#!/usr/bin/env python3
"""Turn txui.png into a transparent-background icon source.

Why this is a flood fill and not "delete every white pixel": **the penguin is
partly white.** Its belly, the whites of its eyes and the highlight on the
database cylinder are all near-white, and a blanket colour key punches holes
straight through the middle of the artwork. Only white that is *reachable from
the edge of the canvas* is background.

Anti-aliasing is the other half. The artwork was flattened onto white, so the
pixels along every outline are blends of the outline colour and the
background. Making them fully transparent leaves a hard, jagged edge; leaving
them opaque leaves a white halo that is very visible on a dark Dock. So the
boundary ring gets *partial* alpha, proportional to how close to pure white it
is, which is what the original blend actually encoded.

    python3 dev/make_icon.py txui.png src-tauri/icons/icon-source.png

Then regenerate the icon set from the result:

    cd src-tauri && cargo tauri icon icons/icon-source.png
"""
import sys
from collections import deque

from PIL import Image

# A pixel counts as background if every channel is at least this bright. The
# artwork's own near-whites (the belly is pure #FFFFFF in places) are protected
# by the reachability rule above, not by this threshold.
WHITE = 238
# Anti-aliased edge pixels: brighter than this and they are mostly background,
# so they get scaled alpha rather than staying fully opaque.
FEATHER_LO = 150


def main(src_path: str, out_path: str) -> None:
    im = Image.open(src_path).convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_white(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a > 0 and r >= WHITE and g >= WHITE and b >= WHITE

    # Flood fill inwards from every edge pixel. Explicit stack rather than
    # recursion: 2048×2048 would blow the interpreter's frame limit.
    seen = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_white(x, y):
                q.append((x, y))
                seen[y * w + x] = 1
    for y in range(h):
        for x in (0, w - 1):
            if is_white(x, y):
                q.append((x, y))
                seen[y * w + x] = 1

    background = []
    while q:
        x, y = q.popleft()
        background.append((x, y))
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_white(nx, ny):
                seen[ny * w + nx] = 1
                q.append((nx, ny))

    for x, y in background:
        px[x, y] = (255, 255, 255, 0)

    # Feather: any still-opaque pixel that touches the transparent region is an
    # anti-aliased blend. Its brightness says how much of it was background.
    edge = []
    for x, y in background:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 255:
                edge.append((nx, ny))

    for x, y in set(edge):
        r, g, b, _ = px[x, y]
        lum = (r + g + b) / 3
        if lum <= FEATHER_LO:
            continue                      # solid outline, leave it alone
        # lum FEATHER_LO → opaque, lum WHITE → transparent.
        alpha = int(255 * (1 - (lum - FEATHER_LO) / (WHITE - FEATHER_LO)))
        px[x, y] = (r, g, b, max(0, min(255, alpha)))

    cleared = len(background)

    # ── centre it, with the margin macOS expects ────────────────────────────
    #
    # Once the background is gone the drawing is wherever the artist left it —
    # here 15.3% in from the left and 9.4% from the right, filling 88% of the
    # height. In the Dock that reads as a lopsided icon slightly too big for
    # its neighbours, because every other icon is drawn to the same grid.
    #
    # So: crop to what is actually drawn, then centre it on a square canvas at
    # CONTENT_FRAC of the width. Aspect ratio is preserved — scaling to fill
    # both axes would stretch the penguin.
    CONTENT_FRAC = 0.82
    bbox = im.split()[3].getbbox()
    content = im.crop(bbox)
    cw, ch = content.size
    side = max(w, h)
    target = int(side * CONTENT_FRAC)
    scale = min(target / cw, target / ch)
    content = content.resize((max(1, round(cw * scale)), max(1, round(ch * scale))),
                             Image.LANCZOS)

    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 0))
    canvas.alpha_composite(content,
                           ((side - content.width) // 2, (side - content.height) // 2))
    canvas.save(out_path)

    cpx = canvas.load()
    opaque = sum(1 for y in range(side) for x in range(side) if cpx[x, y][3] > 0)
    print(f"{out_path}: {side}x{side}, {cleared:,} px cleared, "
          f"{opaque / (side * side):.1%} of the canvas drawn")
    nb = canvas.split()[3].getbbox()
    print(f"  content bbox {nb} — margins "
          f"L {nb[0] / side:.1%} T {nb[1] / side:.1%} "
          f"R {(side - nb[2]) / side:.1%} B {(side - nb[3]) / side:.1%}")
    for name, (x, y) in [("top-left", (0, 0)), ("top-right", (side - 1, 0)),
                         ("bottom-right", (side - 1, side - 1)),
                         ("centre", (side // 2, side // 2))]:
        print(f"  {name:13} {cpx[x, y]}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
