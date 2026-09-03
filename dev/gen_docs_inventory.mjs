// Cross-check feature inventory for the documentation system.
//
// Loads the REAL source modules (via Vite SSR) so the inventory always reflects
// the current version — the "cross-checking system" that guarantees every
// feature is accounted for. Emits docs/inventory.json.
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const server = await createServer({ configFile: './vite.config.ts', server: { middlewareMode: true }, logLevel: 'silent' });

// ── CodeMirror keybinding → per-platform label ────────────────────────────────
// 'Mod-Shift-l' → { mac: '⌘⇧L', win: 'Ctrl+Shift+L' }. Mod = Cmd on mac / Ctrl
// elsewhere, so a single 'Mod-' spec is available identically on every platform.
const KEYNAME = {
  Enter: { mac: '↵', win: 'Enter' }, ArrowUp: { mac: '↑', win: '↑' },
  ArrowDown: { mac: '↓', win: '↓' }, ArrowLeft: { mac: '←', win: '←' },
  ArrowRight: { mac: '→', win: '→' }, Escape: { mac: 'Esc', win: 'Esc' },
  Backslash: { mac: '\\', win: '\\' }, Space: { mac: 'Space', win: 'Space' },
};
function keyLabel(spec) {
  if (!spec) return null;
  // Strip modifier prefixes from the front so the key itself may be '-' or '='.
  let rest = spec;
  const mods = new Set();
  const MODNAMES = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Cmd'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of MODNAMES) {
      if (rest.startsWith(m + '-')) { mods.add(m); rest = rest.slice(m.length + 1); changed = true; }
    }
  }
  const key = rest;
  const macBits = [], winBits = [];
  if (mods.has('Mod')) { macBits.push('⌘'); winBits.push('Ctrl'); }
  if (mods.has('Ctrl')) { macBits.push('⌃'); winBits.push('Ctrl'); }
  if (mods.has('Alt')) { macBits.push('⌥'); winBits.push('Alt'); }
  if (mods.has('Shift')) { macBits.push('⇧'); winBits.push('Shift'); }
  const named = KEYNAME[key];
  const macKey = named ? named.mac : (key.length === 1 ? key.toUpperCase() : key);
  const winKey = named ? named.win : (key.length === 1 ? key.toUpperCase() : key);
  return { mac: macBits.join('') + macKey, win: [...winBits, winKey].join('+') };
}

try {
  const cmd = await server.ssrLoadModule('/src/utils/commandRegistry.ts');
  const menu = await server.ssrLoadModule('/src/utils/pluginMenu.ts');
  const caps = await server.ssrLoadModule('/src/utils/engineCaps.ts');
  const prefsMod = await server.ssrLoadModule('/src/store/preferences.ts');
  const dba = await server.ssrLoadModule('/src/utils/dbaViews.ts');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  // PANEL_META is internal to QueryTabs — regex it for the complete panel set.
  //
  // The entry shape is `  panelId: {` followed by `label: '…'`, on the same
  // line or the next one. It must tolerate both: entries used to be the
  // one-liner `  id: { label: 'X' }`, and WP-16 16.1 added a `render` field
  // that broke them across lines. A regex pinned to the one-line form matched
  // nothing and this script silently emitted **zero panels** — a docs build
  // that loses a whole section without failing is worse than one that errors,
  // so the count is asserted below.
  const qt = readFileSync('src/components/QueryTabs.tsx', 'utf8');
  const metaBlock = /const PANEL_META[^{]*\{([\s\S]*?)\n\};/.exec(qt)?.[1] ?? '';
  const panelMeta = {};
  for (const m of metaBlock.matchAll(/^\s{2}([a-z]+):\s*\{\s*label:\s*'([^']+)'/gm)) {
    panelMeta[m[1]] = m[2];
  }
  // Every `  id: {` in the block must have yielded a label. If the shape drifts
  // again, say so here rather than shipping a docs site with a hole in it.
  const declaredIds = [...metaBlock.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map(m => m[1]);
  const unlabelled = declaredIds.filter(id => !panelMeta[id]);
  if (unlabelled.length || !declaredIds.length) {
    throw new Error(
      `PANEL_META parse failed: ${declaredIds.length} panel(s) declared, ` +
      `${Object.keys(panelMeta).length} labelled` +
      (unlabelled.length ? ` — no label found for: ${unlabelled.join(', ')}` : '') +
      '. The regex in dev/gen_docs_inventory.mjs needs to match the current shape.');
  }

  // Menu placement + engine gate per panel.
  const menuOf = {};
  for (const g of menu.PLUGIN_MENU) for (const it of g.items) {
    menuOf[it.panel] = { group: g.label, tip: it.tip, when: it.when ?? null, menuLabel: it.label };
  }

  // Engine display names travel with the inventory so the HTML generator has
  // no second copy to keep in step — it had one, covering six of nine engines,
  // and the other three rendered as "undefined" throughout the help site.
  const engineLabels = {};
  for (const e of caps.ENGINES) {
    const label = caps.ENGINE_LABELS?.[e];
    if (!label) {
      throw new Error(`engine "${e}" has no ENGINE_LABELS entry in src/utils/engineCaps.ts`);
    }
    engineLabels[e] = label;
  }

  const capsKeys = Object.keys(caps.ENGINE_CAPS[caps.ENGINES[0]]);
  const capMatrix = {};
  for (const eng of caps.ENGINES) capMatrix[eng] = caps.ENGINE_CAPS[eng];

  // ── what each capability MEANS, taken from the source ──────────────────────
  //
  // The `EngineCaps` interface documents every flag — why it exists, what the
  // engine must actually be able to do to earn it, and which engines fall
  // short. That prose is the only place the meaning is written down, and the
  // help site used to have none of it: the HTML generator kept a hand-written
  // label map covering 15 of the 33 flags, so the other 18 published as their
  // raw camelCase key — a reader met `longQueryWatch`, `namespaceDdl` and
  // `queryStore` in a table with no explanation of any of them.
  //
  // Lifting the JSDoc rather than re-describing it here means the table cannot
  // drift from the behaviour, and a new capability arrives documented.
  const capsSrc = readFileSync('src/utils/engineCaps.ts', 'utf8');
  const iface = /export interface EngineCaps \{([\s\S]*?)\n\}/.exec(capsSrc)?.[1];
  if (!iface) {
    throw new Error('could not find `export interface EngineCaps` in src/utils/engineCaps.ts — '
      + 'the shape changed and dev/gen_docs_inventory.mjs cannot read the capability prose');
  }
  const capabilityDocs = {};
  for (const m of iface.matchAll(/\/\*\*([\s\S]*?)\*\/\s*(\w+)\s*:\s*boolean\s*;/g)) {
    const body = m[1]
      .split('\n')
      .map(l => l.replace(/^\s*\*/, '').trim())
      .join('\n')
      .trim();
    // Paragraphs are blank-line separated: the first is the definition, the
    // rest is the reasoning (why it is its own flag, which engine it excludes).
    const paras = body.split(/\n\s*\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    capabilityDocs[m[2]] = { summary: paras[0] ?? '', detail: paras.slice(1) };
  }
  const undocumented = capsKeys.filter(k => !capabilityDocs[k]?.summary);
  if (undocumented.length) {
    throw new Error(
      `no doc comment for capability/ies: ${undocumented.join(', ')} — add a /** … */ `
      + 'above the field in `EngineCaps` (src/utils/engineCaps.ts). The help site '
      + 'publishes this prose; without it the raw key is shown instead.');
  }

  const commands = cmd.EDITOR_COMMANDS.map(c => ({
    id: c.id, label: c.label, category: c.category, keys: c.keys ?? null, shortcut: keyLabel(c.keys),
  }));

  const prefs = Object.entries(prefsMod.PREFS).map(([name, spec]) => ({
    name, key: spec.key, default: spec.default,
  }));

  // DBA views grouped by engine/flavor key.
  const dbaByEngine = {};
  let dbaTotal = 0;
  for (const [eng, views] of Object.entries(dba.DBA_VIEWS)) {
    dbaByEngine[eng] = views.map(v => ({ id: v.id, label: v.label, category: v.category ?? null }));
    dbaTotal += views.length;
  }

  const panels = Object.entries(panelMeta).map(([id, label]) => ({
    id, label, menuLabel: menuOf[id]?.menuLabel ?? label, group: menuOf[id]?.group ?? null,
    tip: menuOf[id]?.tip ?? null, when: menuOf[id]?.when ?? null, inMenu: !!menuOf[id],
  }));

  const inventory = {
    version: pkg.version,
    engines: caps.ENGINES,
    capabilityKeys: capsKeys,
    capabilityMatrix: capMatrix,
    capabilityDocs,
    engineLabels,
    panels,
    commands,
    prefs,
    dbaViews: { total: dbaTotal, byEngine: dbaByEngine },
    counts: {
      panels: panels.length, commands: commands.length, engines: caps.ENGINES.length,
      capabilities: capsKeys.length, prefs: prefs.length, dbaViews: dbaTotal,
    },
  };

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/inventory.json', JSON.stringify(inventory, null, 2));
  console.log('inventory:', JSON.stringify(inventory.counts));
  console.log('panels not in menu:', panels.filter(p => !p.inMenu).map(p => p.id).join(', ') || '(all in menu)');
} finally {
  await server.close();
}
