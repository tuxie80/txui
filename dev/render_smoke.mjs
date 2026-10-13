#!/usr/bin/env node
// Render-smoke sweep: bundle every src/components/*.tsx with the Tauri layer
// stubbed, then render each one under plain Node — renderToString for all,
// a real react-dom/client mount (effects run) for mount-tier targets.
//
// Usage:
//   node dev/render_smoke.mjs            # named surfaces + full sweep, table output
//   node dev/render_smoke.mjs --named    # only the Wave 6 named surfaces
//   node dev/render_smoke.mjs MapView SecurityPanel   # only these
//
// The table this prints — rendered / needs-fixture / cannot, per component —
// is itself the deliverable: it is the first honest map of which components
// have ever produced markup outside a user's machine.

import { runTargets } from './render-smoke/run.mjs';
import { namedTargets, sweepTargets, sweepFixtures, CANNOT } from './render-smoke/targets.mjs';
import * as fixtures from './doc-fixtures.mjs';

const args = process.argv.slice(2);
const namedOnly = args.includes('--named');
const filters = args.filter(a => !a.startsWith('--'));

const named = namedTargets(fixtures);
const sweepFix = namedOnly ? {} : await sweepFixtures(fixtures);
// Every sweep target answers invoke from the docs-generator's own fixture
// table (mockFor) — the shapes that file maintains precisely because a wrong
// shape renders an empty panel. Per-target mocks override it.
const defaultMock = { ...fixtures.mockFor('mysql'), audit_list: [] };
const sweep = namedOnly ? [] : sweepTargets(sweepFix)
  .filter(s => !named.some(n => n.file === s.file && n.name === s.name))
  .map(s => ({ ...s, mock: { ...defaultMock, ...(s.mock ?? {}) } }));

let targets = [...named, ...sweep];
if (filters.length > 0) {
  targets = targets.filter(t =>
    filters.some(f => t.name.toLowerCase().includes(f.toLowerCase())));
}

const t0 = Date.now();
const results = await runTargets(targets, { fixtures });

const rows = [];
for (const t of targets) {
  const r = results.get(t.name);
  rows.push({ name: t.name, tier: r.tier, status: r.status, detail: r.error ?? (r.missingProps.length ? `props: ${r.missingProps.join(', ')}` : ''), bytes: (r.mountedHtml ?? r.html ?? '').length });
}
// Explicitly-cannot entries, in prose, per the Wave 6 brief.
if (!namedOnly) {
  for (const [name, reason] of Object.entries(CANNOT)) {
    if (!rows.some(r => r.name === name)) {
      rows.push({ name, tier: '-', status: 'cannot', detail: reason, bytes: 0 });
    }
  }
}

const counts = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

const nameW = Math.max(...rows.map(r => r.name.length));
for (const r of rows) {
  const flag = r.status === 'mounted' ? '✓'
    : r.status === 'rendered' ? '·'
    : r.status === 'needs-fixture' ? '?'
    : r.status === 'cannot' ? '—'
    : '✗';
  console.log(`${flag} ${r.name.padEnd(nameW)}  ${r.status.padEnd(14)} ${r.bytes > 0 ? String(r.bytes).padStart(6) + 'B' : '       '}  ${r.detail}`.trimEnd());
}
console.log(`\n${rows.length} components in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

const bad = rows.filter(r => ['failed', 'mount-failed', 'assert-failed'].includes(r.status));
if (bad.length > 0) {
  console.log(`\nFAILURES (${bad.length}):`);
  for (const r of bad) console.log(`  ${r.name}: ${r.detail}`);
  process.exit(1);
}
