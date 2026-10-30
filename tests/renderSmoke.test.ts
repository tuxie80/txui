/**
 * Render smoke: components actually rendered, under Node, with the Tauri
 * layer stubbed. The 4300-test pure layer cannot see a component that never
 * renders — this is the file that closes that (docs/NEXT.md §Wave 6.1).
 *
 * dev/render-smoke/run.mjs bundles each target with rolldown (already in
 * node_modules via Vite), aliasing @tauri-apps/* to a programmable stub, then
 * renders it two ways: renderToString (render body) and — for mount tier —
 * react-dom/client into dev/render-smoke/dom-shim.mjs, so effects, invoke
 * calls, canvas paint paths and ResizeObserver wiring execute for real.
 *
 * Two levels of assertion:
 *   1. every Wave 6 named surface mounts and satisfies its own assertions
 *      (markup contents, recorded invoke calls, dispatched dgui:* events);
 *   2. the full component sweep renders/mounts clean — a component that
 *      starts throwing on render fails here, not on a user's screen.
 *
 * The same sweep is runnable standalone with `node dev/render_smoke.mjs`,
 * which prints the per-component table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargets } from '../dev/render-smoke/run.mjs';
import { namedTargets, sweepTargets, sweepFixtures } from '../dev/render-smoke/targets.mjs';
import * as fixtures from '../dev/doc-fixtures.mjs';

const named = namedTargets(fixtures);

// One bundling pass for every target this file runs (content-hashed cache in
// node_modules/.cache — a src/ edit re-bundles).
const sweepFix = await sweepFixtures(fixtures);
const defaultMock = { ...fixtures.mockFor('mysql'), audit_list: [] };
const sweep = sweepTargets(sweepFix)
  .filter(s => !named.some(n => n.file === s.file && n.name === s.name))
  .map(s => ({ ...s, mock: { ...defaultMock, ...(s.mock ?? {}) } }));

const all = [...named, ...sweep];
const results = await runTargets(all, { fixtures });

// ── Wave 6 named surfaces ────────────────────────────────────────────────────
// Each of these was named in docs/NEXT.md as never driven by a human or a
// test. Each must now MOUNT (not just server-render) and pass its assert.

const NAMED_MOUNTED = [
  'MapView',           // canvas + ResizeObserver + drag scrubber
  'GraphicsView',      // the map/chart picker tab
  'SecurityPanel',     // Settings → Security, vault status rendered
  'UnlockGate',        // the vault gate, locked state
  'RevealGate',        // window reveal on first commit
  'SettingsModal',     // every settings tab clicked through
  'ScriptPreflight',   // the pre-flight window, blocked shape
  'WriteConfirm',      // write confirmation with a real row count
  'ProdAck',           // the prod acknowledgment
  'ResultChart',       // chart presets bar/line/area/pie/scatter
  'SeriesChart',       // the chart sub-renderer
  'FastGrid',          // the grid everything sits on
  'PgWorkloadPanel',   // manual baseline/after + waits + incidents
  'App',               // whole app chrome + File/Help menu event translation
];

for (const name of NAMED_MOUNTED) {
  test(`render-smoke named: ${name}`, () => {
    const r = results.get(name);
    assert.ok(r, `target ${name} did not run`);
    assert.equal(r.status, 'mounted', `${name}: ${r.error ?? r.status}`);
    assert.equal(r.consoleErrors?.length ?? 0, 0,
      `${name} logged console errors: ${(r.consoleErrors ?? [])[0] ?? ''}`);
  });
}

// The menu assertions deserve their own line in the output: File menu events
// arrive from the native menu as Tauri events and must emerge as dgui:*
// window events (App.tsx's menu-action switch).
test('render-smoke: native menu events translate to dgui:* events', () => {
  const r = results.get('App');
  assert.ok(r?.container?.__menuSeen?.includes('new-tab'), 'file:new-tab never fired dgui:new-tab');
  assert.ok(r?.container?.__menuSeen?.includes('close-tab'), 'file:close-tab never fired dgui:close-tab');
});

test('render-smoke: MapView exercises the canvas paint path', () => {
  const r = results.get('MapView');
  assert.ok(r.mountedHtml.includes('<canvas'), 'no canvas');
  assert.ok(r.mountedHtml.includes('map-scrub'), 'no drag scrubber');
  assert.ok(r.mountedHtml.includes('3 points'), 'track not built from fixture rows');
});

test('render-smoke: SecurityPanel asked the backend for vault status', () => {
  const r = results.get('SecurityPanel');
  assert.ok(r.calls.some(c => c.cmd === 'vault_status'), 'vault_status never invoked');
  assert.ok(r.mountedHtml.includes('Safe Vault — open'), 'unlocked vault not rendered');
});

// ── full sweep ───────────────────────────────────────────────────────────────
// The table, as a test: every component of src/components either mounts or
// says why not, in targets.mjs. A throw on render is a failure here.

test('render-smoke sweep: no component fails to render', () => {
  const bad = [];
  for (const t of sweep) {
    const r = results.get(t.name);
    assert.ok(r, `target ${t.name} did not run`);
    if (['failed', 'mount-failed', 'assert-failed'].includes(r.status)) {
      bad.push(`${t.name}: ${r.error}`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} component(s) failed:\n${bad.join('\n')}`);
});

test('render-smoke sweep: every component produced markup or said why not', () => {
  const silent = [];
  for (const t of sweep) {
    const r = results.get(t.name);
    if (!r) { silent.push(`${t.name}: no result`); continue; }
    const bytes = (r.mountedHtml ?? r.html ?? '').length;
    if (bytes === 0 && r.status !== 'needs-fixture') {
      // Null-renderers are legitimate (ErrorBoundary, AppDialogHost idle) but
      // must be claimed by name so a NEW silent component is noticed.
      const KNOWN_SILENT = ['AppDialogHost', 'ErrorBoundary'];
      if (!KNOWN_SILENT.includes(t.name)) silent.push(`${t.name}: rendered 0 bytes`);
    }
  }
  assert.deepEqual(silent, [], `components that rendered nothing:\n${silent.join('\n')}`);
});
