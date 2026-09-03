/**
 * Tab appearance (src/utils/tabStyle.ts, src/utils/palette.ts).
 *
 * Two things matter here: a tab must never change size or weight when it
 * becomes active (that makes the whole bar shift under the pointer), and a
 * colour must never be applied at a strength that drowns the label.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabStyle } from '../src/utils/tabStyle.ts';
import { PALETTE, HUE_COUNT, buildPalette } from '../src/utils/palette.ts';

test('no colour means no styling at all', () => {
  assert.deepEqual(tabStyle({}), {});
  assert.deepEqual(tabStyle({ color: null }), {});
});

test('styling never changes layout', () => {
  for (const active of [false, true]) {
    const s = tabStyle({ color: '#e05555' }, active);
    // Nothing that affects size, position or text metrics — those are what
    // make a tab bar jump when you click it.
    for (const forbidden of ['fontWeight', 'padding', 'margin', 'width', 'height',
                             'border', 'fontSize', 'transform']) {
      assert.ok(!(forbidden in s), `active=${active} sets ${forbidden}`);
    }
  }
});

test('active only deepens the colour; the shape stays the same', () => {
  const off = tabStyle({ color: '#6c8fff' }, false);
  const on = tabStyle({ color: '#6c8fff' }, true);
  assert.notDeepEqual(off, on, 'the active tab must look different');
  // Same CSS properties in both — only the values differ.
  assert.deepEqual(Object.keys(off).sort(), Object.keys(on).sort());
  assert.equal(off.boxShadow, on.boxShadow, 'the edge marker is not the difference');
});

test('colours are applied translucently so the label stays readable', () => {
  // A full-strength fill behind 12px text is unreadable; every generated
  // colour must carry an alpha channel.
  const s = tabStyle({ color: '#e05555' }, true);
  assert.match(String(s.background), /#e05555[0-9a-f]{2}/i);
});

test('short hex and non-hex colours are handled rather than corrupted', () => {
  assert.match(String(tabStyle({ color: '#f00' }).background), /#ff0000/i);
  // A keyword or var() is passed straight through — no alpha, but not mangled.
  const kw = tabStyle({ color: 'var(--accent)' });
  assert.match(String(kw.background), /var\(--accent\)/);
});

test('a colour both fills the tab and marks its edge', () => {
  const s = tabStyle({ color: '#e05555' });
  assert.ok(s.boxShadow, 'the edge marker is there');
  assert.ok(s.background, 'and the tab is filled');
  assert.match(String(s.background), /#e05555[0-9a-f]{2}/i);
});

test('the palette is 16 distinct colours', () => {
  // Sixteen is what you can tell apart and choose from quickly. Eight ran out
  // on a real estate; 128 was a wall nobody could pick from.
  assert.equal(PALETTE.length, HUE_COUNT);
  assert.equal(PALETTE.length, 16);
  assert.equal(new Set(PALETTE).size, PALETTE.length, 'duplicate swatches');
  for (const c of PALETTE) {
    assert.match(c, /^#[0-9a-f]{6}$/, `${c} is not a hex colour`);
  }
});

test('the palette avoids the extremes that stop reading as colours', () => {
  // Too dark disappears into the background; too light stops being a colour.
  for (const c of buildPalette()) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    assert.ok(lum > 0.08 && lum < 0.95, `${c} has luminance ${lum.toFixed(2)}`);
  }
});
