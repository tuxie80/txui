#!/usr/bin/env python3
# Companion to dev/grid-scroll-repro.mjs VIDEO=1: per-frame blank fraction of
# the grid viewport from extracted screencast frames, restricted to frames
# where the green gesture marker is visible (i.e. a scroll gesture is active).
#
#   python3 dev/grid-video-blankness.py /tmp/grid-frames-webkit
#
# A presented-but-unrasterized (blank) frame is solid grid background in the
# sampled band (~0% bright pixels); a painted grid reads ~6-12%.
import sys, glob
from PIL import Image

d = sys.argv[1]
files = sorted(glob.glob(f'{d}/f*.png'))
if not files:
    sys.exit(f'no frames in {d}')

def classify(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    # marker check: green square at roughly (60..94, 420..454) in CSS px
    mx, my = int(77 / 1600 * w), int(437 / 1000 * h)
    r, g, b = px[mx, my]
    active = g > 180 and r < 100 and b < 100
    # blank fraction over the grid center band
    cnt = tot = 0
    for y in range(int(h * 0.47), int(h * 0.92), 10):
        for x in range(int(w * 0.17), int(w * 0.95), 12):
            r, g, b = px[x, y]
            tot += 1
            if r + g + b > 140:
                cnt += 1
    return active, cnt / tot * 100

active_fracs = []
for i, f in enumerate(files):
    active, frac = classify(f)
    if active:
        active_fracs.append((i, frac))

if not active_fracs:
    sys.exit('no gesture-active frames found (marker never seen)')

BLANK = 1.0
blanks = [(i, v) for i, v in active_fracs if v < BLANK]
n = len(active_fracs)
print(f'{len(files)} frames total; gesture-active: {n}; '
      f'blank(<{BLANK}% bright): {len(blanks)} ({len(blanks) / n * 100:.1f}%)')
if blanks:
    idxs = [i for i, _ in blanks]
    runs, start, prev = [], idxs[0], idxs[0]
    for i in idxs[1:]:
        if i != prev + 1:
            runs.append((start, prev))
            start = i
        prev = i
    runs.append((start, prev))
    print('blank runs (frame ranges, longest last):',
          sorted(runs, key=lambda r: r[1] - r[0])[-8:])
qs = sorted(v for _, v in active_fracs)
print(f'bright-pixel fraction (active frames): min={qs[0]:.2f}% '
      f'p5={qs[max(0, len(qs)//20)]:.2f}% p50={qs[len(qs)//2]:.2f}% max={qs[-1]:.2f}%')

# Segment into gesture blocks: maximal active runs separated by >=5 inactive.
idxs = [i for i, _ in active_fracs]
blocks, start, prev = [], idxs[0], idxs[0]
for i in idxs[1:]:
    if i > prev + 5:
        blocks.append((start, prev))
        start = i
    prev = i
blocks.append((start, prev))
by = dict(active_fracs)
names = ['A(wheel 2400)', 'B(jumps)', 'C(drag)', 'D(wheel 900)']
for k, (a, b) in enumerate(blocks):
    vals = [(i, by[i]) for i in range(a, b + 1) if i in by]
    nb = sum(1 for _, v in vals if v < BLANK)
    label = names[k] if k < len(names) else f'block{k}'
    print(f'  gesture {label}: frames {a}-{b}, active={len(vals)}, blank={nb} ({nb / len(vals) * 100:.0f}%)')
