/**
 * The generated help site must not publish placeholder text.
 *
 * `dev/gen_docs_html.mjs` builds HTML by string interpolation, so a lookup that
 * misses does not throw — it renders the word `undefined` into the page. That
 * shipped: the generator kept its own engine-label map covering six of the nine
 * engines, so DuckDB, MongoDB and SQL Server appeared as the literal text
 * "undefined" in every engine badge, both engine filters and the header row of
 * the capability matrix. 74 occurrences in a 235 KB published page, and nothing
 * failed.
 *
 * The labels come from `ENGINE_LABELS` in engineCaps.ts now (typed
 * `Record<Engine, string>`, so a new engine cannot compile without one) and the
 * generator throws on a miss. This test is the backstop for every *other*
 * interpolation in that file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINES, ENGINE_LABELS } from '../src/utils/engineCaps.ts';

const html = readFileSync('docs/index.html', 'utf8');
const inv = JSON.parse(readFileSync('docs/inventory.json', 'utf8'));

/** Rendered-value accidents. Each means an interpolation found nothing. */
const PLACEHOLDERS = ['undefined', '[object Object]', 'NaN', '[native code]'];

describe('generated help site has no placeholder text', () => {
  for (const bad of PLACEHOLDERS) {
    test(`docs/index.html contains no "${bad}"`, () => {
      const n = html.split(bad).length - 1;
      assert.equal(n, 0,
        `${n} occurrence(s) of "${bad}" in the published help site — an `
        + 'interpolation in dev/gen_docs_html.mjs resolved to nothing. '
        + 'Rebuild with dev/build_docs.sh after fixing the source lookup.');
    });
  }

  test('every engine has a display label, and the inventory carries them', () => {
    for (const e of ENGINES) {
      assert.ok(ENGINE_LABELS[e], `engine "${e}" has no ENGINE_LABELS entry`);
    }
    assert.ok(inv.engineLabels, 'inventory.json has no engineLabels — rebuild the docs');
    for (const e of inv.engines) {
      assert.ok(inv.engineLabels[e],
        `inventory has no label for "${e}" — run dev/build_docs.sh`);
    }
  });

  test('every panel has a prose entry', () => {
    // Without one the page falls back to the one-line menu tip: no key actions,
    // no caveats, no engine notes. It degrades rather than breaking, which is
    // exactly why it went unnoticed for Vacuum & Bloat and Deadlocks.
    const prose: Record<string, unknown> = {};
    for (const f of ['docs/gen/panels_A.json', 'docs/gen/panels_B.json']) {
      Object.assign(prose, JSON.parse(readFileSync(f, 'utf8')).panels);
    }
    const missing = inv.panels
      .filter((p: { id: string }) => !(p.id in prose))
      .map((p: { id: string; label: string }) => `${p.id} (${p.label})`);
    assert.deepEqual(missing, [],
      `${missing.length} panel(s) have no entry in docs/gen/panels_*.json`);
  });

  test('every engine label actually reaches the page', () => {
    for (const e of inv.engines) {
      const label = inv.engineLabels[e];
      assert.ok(html.includes(`>${label}</`),
        `"${label}" (${e}) never appears in docs/index.html — rebuild the docs`);
    }
  });
});
