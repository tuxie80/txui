/**
 * The generated help system (docs/inventory.json → docs/index.html) must still
 * agree with the source it claims to be derived from.
 *
 * Two failures this catches, both of which happened:
 *
 * 1. **A silently broken generator.** `dev/gen_docs_inventory.mjs` regexes
 *    `PANEL_META` out of QueryTabs.tsx. When WP-16 16.1 added a `render` field
 *    the entries went multi-line, the one-line regex matched nothing, and the
 *    build emitted **zero panels** — no error, just a help site missing its
 *    largest section. Comparing the committed inventory to the source is the
 *    only thing that notices.
 * 2. **A stale build.** A preference added without re-running
 *    `dev/build_docs.sh` leaves the shipped docs quietly behind the app.
 *
 * Either way the fix is the same: `dev/build_docs.sh`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';
import { ENGINES } from '../src/utils/engineCaps.ts';

const inv = JSON.parse(readFileSync('docs/inventory.json', 'utf8'));
const REBUILD = 'run dev/build_docs.sh';

describe('generated docs inventory', () => {
  test('panel count matches PANEL_META in QueryTabs.tsx', () => {
    const qt = readFileSync('src/components/QueryTabs.tsx', 'utf8');
    const block = /const PANEL_META[^{]*\{([\s\S]*?)\n\};/.exec(qt)?.[1] ?? '';
    const ids = [...block.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(m => m[1]);
    assert.ok(ids.length > 0, 'PANEL_META did not parse — the source shape changed');
    assert.equal(inv.counts.panels, ids.length,
      `inventory has ${inv.counts.panels} panels, PANEL_META declares ${ids.length} — ${REBUILD}`);
  });

  test('every panel carries a label (a parse hole shows up as a blank)', () => {
    for (const p of inv.panels) {
      assert.ok(p.label && p.label.length > 0, `panel ${p.id} has no label — ${REBUILD}`);
    }
  });

  test('DBA view count matches dbaViews.ts', () => {
    const total = Object.values(DBA_VIEWS).reduce((n, v) => n + v.length, 0);
    assert.equal(inv.counts.dbaViews, total,
      `inventory has ${inv.counts.dbaViews} DBA views, source has ${total} — ${REBUILD}`);
  });

  test('engine list matches engineCaps.ts', () => {
    assert.deepEqual(inv.engines, [...ENGINES], `engine list drifted — ${REBUILD}`);
  });

  test('the version stamped in the inventory is the shipped one', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.equal(inv.version, pkg.version,
      `docs built at v${inv.version}, package.json is v${pkg.version} — ${REBUILD}`);
  });
});
