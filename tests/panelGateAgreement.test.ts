/**
 * The two engine gates must agree.
 *
 * A panel opens three ways — the plugin menu bar, the Tools/native menu, and
 * the command palette. The menu bar reads `pluginMenu`'s `when`; the other two
 * read `PANEL_ENGINE_CAP` in QueryTabs. When those disagree, the same panel
 * opens from one place and is silently refused from another, which reads as a
 * bug in whichever the user tried second — and nothing fails.
 *
 * They drifted the moment SQL Server started getting panels one at a time:
 * Locks moved to `lockWaits` in the menu while the palette still asked for
 * `sqlDba`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLUGIN_MENU } from '../src/utils/pluginMenu.ts';

const tabs = readFileSync('src/components/QueryTabs.tsx', 'utf8');
const block = /const PANEL_ENGINE_CAP[^{]*\{([\s\S]*?)\n\};/.exec(tabs)?.[1] ?? '';
const gate = new Map<string, string>();
for (const m of block.matchAll(/^\s*(\w+):\s*'([\w]+)'/gm)) gate.set(m[1], m[2]);

describe('panel engine gates agree across entry points', () => {
  test('PANEL_ENGINE_CAP parsed', () => {
    assert.ok(gate.size > 15, `only parsed ${gate.size} entries`);
  });

  test('every capability-gated menu item has the same capability in both tables', () => {
    const mismatched: string[] = [];
    for (const group of PLUGIN_MENU) {
      for (const it of group.items) {
        if (!it.when) continue;
        // Engine-name gates ('mysql', 'postgres', 'clickhouse') are not
        // capabilities and have no counterpart here.
        if (['mysql', 'postgres', 'clickhouse'].includes(it.when)) continue;
        const other = gate.get(it.panel);
        if (other && other !== it.when) {
          mismatched.push(`${it.panel}: menu says '${it.when}', palette says '${other}'`);
        }
      }
    }
    assert.deepEqual(mismatched, [],
      'the same panel would open from one entry point and be refused from another');
  });
});
