// Generate the TxUI HTML help system from the cross-check inventory + the
// source-derived reference JSON + whatever screenshots were captured.
// Emits docs/index.html (self-contained except for docs/shots/*.png, which are
// referenced relatively so the whole docs/ folder is portable + offline).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { renderGuide } from './md2html.mjs';

const R = 'docs';
const inv = JSON.parse(readFileSync(`${R}/inventory.json`, 'utf8'));
const panelsA = JSON.parse(readFileSync(`${R}/gen/panels_A.json`, 'utf8')).panels;
const panelsB = JSON.parse(readFileSync(`${R}/gen/panels_B.json`, 'utf8')).panels;
const PANELDOC = { ...panelsA, ...panelsB };
const PREFDOC = JSON.parse(readFileSync(`${R}/gen/prefs.json`, 'utf8')).prefs;
const CMDDOC = JSON.parse(readFileSync(`${R}/gen/commands.json`, 'utf8')).commands;
const shotFiles = new Set(readdirSync(`${R}/shots`).filter(f => f.endsWith('.png')));

const V = inv.version;
const ACCENT = '#ff2d2d';

// ── helpers ──────────────────────────────────────────────────────────────────
// Escapes for BOTH text content and attribute values — quotes included.
// Without `"` the engine matrix broke: capability prose is interpolated into
// `data-search="…"`, and a summary that quotes itself ("has query statistics")
// closed the attribute early and spilled the rest of the sentence into the tag.
// `&quot;` / `&#39;` render as the plain characters in text, so one helper is
// correct in both positions.
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Doc-comment prose → HTML. The capability descriptions are lifted verbatim
 * from the JSDoc in engineCaps.ts, which is written in the light markdown
 * developers use in comments: `code`, **bold**, *emphasis*. Escaping and then
 * publishing it raw put literal backticks and asterisks on the page.
 * Escape first, so the conversion can never introduce a tag the source did not
 * ask for.
 */
const prose = t => esc(t)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:)]|$)/g, '$1<i>$2</i>');

// How many of the 33 capabilities each engine has.
const capCount = e => inv.capabilityKeys.filter(c => inv.capabilityMatrix[e][c]).length;

/**
 * Engine display order: most complete first, so a reader meets the engines
 * TxUI supports fully before the ones it barely touches, and the matrix reads
 * as a ranking instead of an arbitrary list.
 *
 * Computed, never hand-written — the source order in `inv.engines` is the
 * declaration order in engineCaps.ts and `docsInventory.test.ts` asserts the
 * inventory still matches it exactly, so the ordering belongs here in the
 * presenter rather than in the data. Ties keep declaration order (MySQL and
 * PostgreSQL are both 32/33).
 */
const ENGINE_ORDER = inv.engines
  .map((e, i) => ({ e, i, n: capCount(e) }))
  .sort((a, b) => b.n - a.n || a.i - b.i)
  .map(x => x.e);

// capability -> engines that have it, in display order
const enginesWith = cap => ENGINE_ORDER.filter(e => inv.capabilityMatrix[e][cap]);
// which engines a panel is available on, from its `when` gate
function panelEngines(when) {
  if (!when) return ENGINE_ORDER.slice();
  if (inv.engines.includes(when)) return [when];         // single-engine gate
  return enginesWith(when);                               // capability gate
}
// panels a capability turns on — the reverse of `panelEngines`, so the matrix
// can say what each flag actually BUYS rather than only naming it
const panelsGatedOn = cap => inv.panels.filter(p => p.when === cap);
// Engine display names come from the inventory (ultimately
// src/utils/engineCaps.ts ENGINE_LABELS), never from a copy kept here. The copy
// that used to live on this line listed six of the nine engines, so DuckDB,
// MongoDB and SQL Server were published as the literal word "undefined" in
// every badge, the engine filters and the capability-matrix header. A missing
// label now throws at build time instead of shipping.
const ENGINE_LABEL = inv.engineLabels ?? {};
for (const e of inv.engines) {
  if (!ENGINE_LABEL[e]) {
    throw new Error(
      `no display label for engine "${e}" — add it to ENGINE_LABELS in `
      + 'src/utils/engineCaps.ts and re-run dev/gen_docs_inventory.mjs');
  }
}

// per-OS keycap
function kbd(sc) {
  if (!sc) return '<span class="kbd na">—</span>';
  return `<span class="kbd"><span class="os os-mac">${esc(sc.mac)}</span><span class="os os-win">${esc(sc.win)}</span></span>`;
}

// find a screenshot for a panel (captures are named by the MENU label slug)
function panelShot(p) {
  const cands = [`panel-${slug(p.menuLabel || p.label)}.png`, `panel-${slug(p.label)}.png`, `panel-${p.id}.png`];
  for (const c of cands) if (shotFiles.has(c)) return `shots/${c}`;
  return null;
}

// ── user guides (docs/user-guide/*.md, rendered in-page) ────────────────────
// Order: first-steps.md FIRST — it is the newbie entry point — then
// alphabetical by filename. Skipped: README.md (the guide index; its prose
// duplicates the reference sections of this page, so links to it land on
// #overview) and SCREENSHOTS.md (the capture runbook, not a guide).
const GUIDE_SKIP = new Set(['README.md', 'SCREENSHOTS.md']);
const guideFiles = readdirSync(`${R}/user-guide`)
  .filter(f => f.endsWith('.md') && !GUIDE_SKIP.has(f))
  .sort((a, b) => (a === 'first-steps.md' ? -1 : b === 'first-steps.md' ? 1 : a.localeCompare(b)));
const GUIDE_IDS = new Set(guideFiles.map(f => f.replace(/\.md$/, '')));

// Links between guides (`mysql.md`, `./mysql.md`) become in-site anchors.
// Links to files outside the guide set (e.g. ../FEATURES.md) return null and
// md2html demotes them to plain text — there is no page here to send them to.
function guideHref(href) {
  const base = href.replace(/^\.\//, '').replace(/\.md$/, '');
  if (GUIDE_IDS.has(base)) return `#guide-${base}`;
  if (base === 'README') return '#overview';
  if (/^https?:/.test(href)) return href;
  return null;
}
// Guide images are relative to docs/user-guide/; from docs/index.html that is
// `user-guide/<src>`. A missing file throws — the build fails, the site never
// ships a broken <img>.
function guideImg(src) {
  if (/^(https?:|data:)/.test(src)) return src;
  if (!existsSync(`${R}/user-guide/${src}`)) throw new Error(`guide image not found: docs/user-guide/${src}`);
  return `user-guide/${src}`;
}

const guides = guideFiles.map(f => {
  const md = readFileSync(`${R}/user-guide/${f}`, 'utf8');
  const id = f.replace(/\.md$/, '');
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? id;
  return { id, title, html: renderGuide(md, { file: `docs/user-guide/${f}`, resolveHref: guideHref, resolveImg: guideImg }) };
});

// ── section builders ─────────────────────────────────────────────────────────

function guidesSection() {
  return `
<section id="guides" class="doc-section">
  <h1>Guides</h1>
  <p class="lede">Task-oriented walkthroughs from <code>docs/user-guide/</code>. New to TxUI? Start with <a href="#guide-first-steps">First steps (101)</a> — five minutes from the start screen to your first query result — then pick the guide for your engine.</p>
  <div class="guide-index">${guides.map(g => `<a class="guide-card" href="#guide-${g.id}">${esc(g.title)}</a>`).join('\n')}</div>
  ${guides.map(g => `<div class="guide-doc" id="guide-${g.id}">\n${g.html}\n</div>`).join('\n')}
</section>`;
}

// group panels by menu group in canonical order
const GROUP_ORDER = ['Monitor', 'Server', 'Schema', 'Data', 'SQL'];
const panelsByGroup = {};
for (const p of inv.panels) (panelsByGroup[p.group] ??= []).push(p);

// commands grouped by category
const CMD_CAT_ORDER = ['Run', 'Navigate', 'Selection', 'Edit', 'Format', 'Lines', 'Search', 'Bookmarks', 'Macro', 'View'];
const cmdByCat = {};
for (const c of inv.commands) (cmdByCat[c.category] ??= []).push(c);

// prefs grouped by section
const prefBySection = {};
for (const [name, pd] of Object.entries(PREFDOC)) {
  const sec = pd.section || 'Other';
  (prefBySection[sec] ??= []).push({ name, ...pd });
}

// ── HTML ─────────────────────────────────────────────────────────────────────
function overviewSection() {
  return `
<section id="overview" class="doc-section">
  <h1>TxUI <span class="ver">v${V}</span></h1>
  <p class="lede">A fast, keyboard-first database GUI for MySQL, PostgreSQL, ClickHouse, Redis, SQLite and Parquet — with ${inv.counts.panels} built-in tool panels, ${inv.counts.commands} editor commands and ${inv.counts.dbaViews} ready-made DBA views. This is the complete reference for version ${V}.</p>
  <div class="cards">
    <div class="card"><div class="big">${inv.counts.engines}</div><div>database engines</div></div>
    <div class="card"><div class="big">${inv.counts.panels}</div><div>tool panels</div></div>
    <div class="card"><div class="big">${inv.counts.commands}</div><div>editor commands</div></div>
    <div class="card"><div class="big">${inv.counts.dbaViews}</div><div>DBA views</div></div>
    <div class="card"><div class="big">${inv.counts.prefs}</div><div>settings</div></div>
  </div>
  <div class="callout">
    <strong>Every shortcut works on every platform.</strong> TxUI binds commands to <code>Mod</code>, which is <b>⌘ Command</b> on macOS and <b>Ctrl</b> on Windows/Linux. Use the <b>macOS / Windows·Linux</b> switch in the top bar to render every shortcut in your notation. Screenshots are taken on macOS; the unified <span style="color:${ACCENT}">red</span> outline marks the element under discussion.
  </div>
  ${shotFiles.has('01-shell.png') ? `<figure><img src="shots/01-shell.png" alt="TxUI connection manager"><figcaption>The connection manager — connections grouped by folder, each engine with its own icon. <span class="cap-mac">Captured on macOS.</span></figcaption></figure>` : ''}
</section>`;
}

function shortcutsSection() {
  const rows = inv.commands.map(c => {
    const d = CMDDOC[c.id]?.description || c.label;
    return `<tr data-search="${esc((c.label + ' ' + c.category + ' ' + d + ' ' + (c.shortcut?.mac||'') + ' ' + (c.shortcut?.win||'')).toLowerCase())}">
      <td>${esc(c.label)}</td><td class="mono dim">${esc(c.category)}</td><td>${kbd(c.shortcut)}</td><td class="dim">${esc(d)}</td></tr>`;
  }).join('\n');
  return `
<section id="shortcuts" class="doc-section">
  <h1>Keyboard shortcuts</h1>
  <p class="lede">All ${inv.counts.commands} SQL-editor commands, straight from the app's command registry (v${V}). Filter by action or key. Chords render for your platform — toggle macOS / Windows·Linux above.</p>
  <div class="toolbar"><input id="scFilter" class="filter" placeholder="Filter shortcuts by action or key…" oninput="filterTable('scFilter','scTable')"></div>
  <table class="ref" id="scTable">
    <thead><tr><th>Command</th><th>Category</th><th>Shortcut</th><th>What it does</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">Commands without a chord are available from menus, the command palette (<span class="kbd"><span class="os os-mac">⌘K</span><span class="os os-win">Ctrl+K</span></span>) or the right-click menu.</p>
</section>`;
}

function coverageMatrixSection() {
  const rows = inv.panels.map(p => {
    const engs = panelEngines(p.when);
    const shot = panelShot(p);
    const documented = !!PANELDOC[p.id];
    return `<tr data-search="${esc((p.label+' '+p.group+' '+p.id).toLowerCase())}" data-engines="${engs.join(' ')}">
      <td><a href="#panel-${p.id}">${esc(p.label)}</a></td>
      <td class="dim">${esc(p.group)}</td>
      <td>${engs.map(e => `<span class="eng-badge e-${e}">${ENGINE_LABEL[e]}</span>`).join(' ')}</td>
      <td class="ctr">${documented ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>
      <td class="ctr">${shot ? '<span class="yes">✓</span>' : '<span class="na" title="Requires a live connection to capture">NA</span>'}</td>
    </tr>`;
  }).join('\n');
  const withShots = inv.panels.filter(p => panelShot(p)).length;
  return `
<section id="coverage" class="doc-section">
  <h1>Feature-coverage matrix</h1>
  <p class="lede">Every one of the ${inv.counts.panels} tool panels, cross-checked against the source at build time — the menu group it lives in, the engines it supports, whether it is documented here, and whether a screenshot could be captured. <b>${withShots}/${inv.counts.panels}</b> panels have screenshots; the rest are marked <span class="na">NA</span> (they need a live server to render meaningfully) and are still fully documented in text.</p>
  <div class="toolbar">
    <input id="covFilter" class="filter" placeholder="Filter panels…" oninput="filterTable('covFilter','covTable')">
    <select id="covEngine" class="filter" onchange="filterEngine('covEngine','covTable')">
      <option value="">All engines</option>
      ${ENGINE_ORDER.map(e => `<option value="${e}">${ENGINE_LABEL[e]}</option>`).join('')}
    </select>
  </div>
  <table class="ref" id="covTable">
    <thead><tr><th>Panel</th><th>Group</th><th>Engines</th><th>Documented</th><th>Screenshot</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function engineMatrixSection() {
  // Human-readable name for every flag. The generator used to carry 15 of
  // these and fall through to the raw key for the rest, so `longQueryWatch`,
  // `namespaceDdl`, `queryStore` and fifteen others were published as
  // camelCase identifiers in a table aimed at people choosing a database. A
  // missing label now throws at build time.
  const CAP_LABEL = {
    sql: 'SQL editor', writes: 'Writing data at all', transactions: 'Transactions',
    databaseSelect: 'Pick a default database', sqlVariables: 'Query variables (:name)',
    statementTimeout: 'Statement timeout',
    processList: 'Process list & kill', longQueryWatch: 'Long-query watchdog',
    lockWaits: 'Lock waits, blocking chains & deadlocks',
    replication: 'Replication topology', serverInfo: 'Server settings & status',
    sqlDba: 'DBA views & tooling', tuner: 'Configuration tuner',
    stmtStats: 'Statement statistics over time',
    queryStore: 'Query Store — plan history', sqlQuality: 'SQL quality audit',
    maintenance: 'Maintenance',
    fleet: 'Fleet comparison', playground: 'Contention playground',
    erDiagram: 'ER diagram', documenter: 'Schema documenter',
    dbSearch: 'Search every table for a value', findUsages: 'Find usages',
    columnProfile: 'Column profiling', routines: 'Stored routines', sequences: 'Sequences',
    tableDesigner: 'Table designer', namespaceDdl: 'Create / drop schemas',
    dataGen: 'Data generator', csvImport: 'CSV import',
    dataCompare: 'Data compare & reconcile', userAdmin: 'Users & permissions',
  };

  // Themed blocks, so 32 rows read as five short lists rather than one wall.
  const CAP_GROUPS = [
    ['Running queries', 'What you can do with the connection itself.',
      ['sql', 'writes', 'transactions', 'databaseSelect', 'sqlVariables', 'statementTimeout']],
    ['Watching a live server', 'Who is running what, and what is stuck behind what.',
      ['processList', 'longQueryWatch', 'lockWaits', 'replication', 'serverInfo']],
    ['DBA & performance', 'The diagnostic tooling — why it is slow, and what to change.',
      ['sqlDba', 'tuner', 'stmtStats', 'queryStore', 'sqlQuality', 'maintenance', 'fleet', 'playground']],
    ['Understanding a schema', 'Reading a database you did not write.',
      ['erDiagram', 'documenter', 'dbSearch', 'findUsages', 'columnProfile', 'routines', 'sequences']],
    ['Changing a schema & its data', 'The write-capable tooling.',
      ['tableDesigner', 'namespaceDdl', 'dataGen', 'csvImport', 'dataCompare', 'userAdmin']],
  ];

  // Neither map may silently lose a capability: a flag missing from CAP_LABEL
  // used to render as its identifier, and one missing from CAP_GROUPS would
  // simply not appear in the table at all — the worse of the two, because
  // nothing on the page would look wrong.
  const missingLabel = inv.capabilityKeys.filter(c => !CAP_LABEL[c]);
  const grouped = CAP_GROUPS.flatMap(([, , keys]) => keys);
  const missingGroup = inv.capabilityKeys.filter(c => !grouped.includes(c));
  const strayGroup = grouped.filter(c => !inv.capabilityKeys.includes(c));
  if (missingLabel.length || missingGroup.length || strayGroup.length) {
    throw new Error(
      'engine matrix is out of step with engineCaps.ts —'
      + (missingLabel.length ? ` no CAP_LABEL for: ${missingLabel.join(', ')};` : '')
      + (missingGroup.length ? ` not in any CAP_GROUPS block: ${missingGroup.join(', ')};` : '')
      + (strayGroup.length ? ` grouped but no longer a capability: ${strayGroup.join(', ')};` : '')
      + ' fix dev/gen_docs_html.mjs');
  }

  const capRow = cap => {
    const doc = inv.capabilityDocs?.[cap];
    const summary = doc?.summary ?? '';
    // The rest of the doc comment says WHY a flag exists on its own and which
    // engine it deliberately excludes — the part that answers "but why can't
    // SQL Server do that?". Too long for a table cell, too useful to drop, so
    // it folds away.
    const detail = doc?.detail ?? [];
    const unlocks = panelsGatedOn(cap);
    const hay = [CAP_LABEL[cap], cap, summary, ...detail, ...unlocks.map(p => p.label)].join(' ').toLowerCase();
    return `<tr data-search="${esc(hay)}">
    <td class="cap">
      <b>${esc(CAP_LABEL[cap])}</b>
      ${summary ? `<div class="cap-desc">${prose(summary)}</div>` : ''}
      ${detail.length ? `<details class="cap-why"><summary>Why it works this way</summary>${detail.map(d => `<p>${prose(d)}</p>`).join('')}</details>` : ''}
      ${unlocks.length ? `<div class="cap-unlocks">Opens: ${unlocks.map(p => `<a href="#panel-${p.id}">${esc(p.label)}</a>`).join(', ')}</div>` : ''}
      <code class="cap-key">${esc(cap)}</code>
    </td>
    ${ENGINE_ORDER.map(e => `<td class="ctr">${inv.capabilityMatrix[e][cap] ? '<span class="yes">✓</span>' : '<span class="no" title="Not available on this engine">—</span>'}</td>`).join('')}
  </tr>`;
  };

  const body = CAP_GROUPS.map(([title, blurb, keys]) => `
  <tr class="cap-group"><td colspan="${ENGINE_ORDER.length + 1}"><b>${esc(title)}</b> <span class="dim">${esc(blurb)}</span></td></tr>
  ${keys.map(capRow).join('\n')}`).join('\n');

  // Panels that a single engine has and no capability flag describes — they
  // are gated on the engine name itself. Without this the page would claim the
  // matrix is the whole story, and PostgreSQL's five exclusives would be
  // invisible in the one table people read to compare engines.
  const exclusives = inv.engines
    .map(e => [e, inv.panels.filter(p => p.when === e)])
    .filter(([, ps]) => ps.length)
    .sort((a, b) => b[1].length - a[1].length);

  // Panels with no gate at all. Without naming them the matrix implies the 33
  // flags account for every panel, and the eight that are always there — the
  // ones a reader is most likely to want — would be the only panels the page's
  // headline table never mentions.
  const always = inv.panels.filter(p => !p.when);

  const total = inv.capabilityKeys.length;
  return `
<section id="engines" class="doc-section">
  <h1>Engine support matrix</h1>
  <p class="lede">What TxUI can do on each of the ${inv.counts.engines} engines it speaks, taken directly from the app's engine-capability table (v${V}). Engines are ordered <b>most complete first</b>; each capability says what it means and which tool panels it opens. A dash means the feature is not offered there — TxUI hides or disables it rather than letting you run into an error.</p>
  <div class="toolbar">
    <input id="engFilter" class="filter" placeholder="Filter capabilities…" oninput="filterTable('engFilter','engTable')">
  </div>
  <div class="scroll-x"><table class="ref matrix" id="engTable">
    <thead>
      <tr><th>Capability</th>${ENGINE_ORDER.map(e => `<th class="e-${e}">${ENGINE_LABEL[e]}</th>`).join('')}</tr>
      <tr class="cap-score"><th>of ${total} capabilities</th>${ENGINE_ORDER.map(e => `<th class="ctr">${capCount(e)}</th>`).join('')}</tr>
    </thead>
    <tbody>${body}</tbody>
  </table></div>
  <h2>Panels every engine gets</h2>
  <p>${always.length} of the ${inv.counts.panels} panels need no capability at all — they work on anything TxUI can open: ${always.map(p => `<a href="#panel-${p.id}">${esc(p.label)}</a>`).join(', ')}.</p>
  <h2>Panels only one engine can have</h2>
  <p>${exclusives.reduce((n, [, ps]) => n + ps.length, 0)} more panels are gated on the engine itself rather than on a capability, because nothing else has an equivalent to expose:</p>
  <ul class="cap-exclusives">
    ${exclusives.map(([e, ps]) => `<li><span class="eng-badge e-${e}">${ENGINE_LABEL[e]}</span> ${ps.map(p => `<a href="#panel-${p.id}">${esc(p.label)}</a>`).join(', ')}</li>`).join('\n    ')}
  </ul>
  <p class="note">The lean engines are lean on purpose. Redis is a key/value store — no SQL editor, no transactions, no schema to draw. Parquet files are read-only in-memory scans, so there is nothing to write and no server to administer. MongoDB is newest here and currently reads documents and reports server status; the rest of its row is roadmap, not refusal.</p>
</section>`;
}

function workspaceSection() {
  const figs = [];
  const add = (f, cap) => { if (shotFiles.has(f)) figs.push(`<figure><img src="shots/${f}" alt="${esc(cap)}" loading="lazy"><figcaption>${cap}</figcaption></figure>`); };
  add('05-editor-results.png', 'The SQL editor with live autocomplete, transaction controls (AUTO / Commit / Rollback), and the result grid below — Grid, Graphics and Log tabs, with Copy, Export, Chart and Pivot.');
  add('04-workspace.png', 'A freshly opened session: object browser on the left, editor and results on the right.');
  add('03-command-palette.png', 'The command palette (⌘K / Ctrl+K) — fuzzy-search every command and panel.');
  return `
<section id="workspace" class="doc-section">
  <h1>The workspace</h1>
  <p class="lede">Open a connection (double-click it in the sidebar) and you land in a session workspace: the object browser, a multi-tab SQL editor, and the result grid. Each session records everything it does in its own Log tab.</p>
  ${figs.join('\n')}
  <h2>Running SQL</h2>
  <ul>
    <li><b>Run the statement under the cursor</b> with ${kbd(inv.commands.find(c=>c.id==='editor.run')?.shortcut)}. Select text first to run only the selection.</li>
    <li><b>Autocomplete</b> proposes tables, columns, keywords and snippets as you type.</li>
    <li><b>Transactions:</b> switch off AUTO to work in an explicit transaction, then Commit or Rollback. The current <code>autocommit</code> state is always shown.</li>
    <li><b>Result grid:</b> sort, filter per column, copy, export, chart or pivot — and switch to the record view for a single row.</li>
  </ul>
</section>`;
}

function panelsSection() {
  let html = `
<section id="panels" class="doc-section">
  <h1>Tool panels</h1>
  <p class="lede">TxUI ships ${inv.counts.panels} tool panels, opened from the workspace menus (<b>${GROUP_ORDER.join(' · ')}</b>) or the native Tools menu. Each panel below lists the engines it works on; where a panel needs a live server to show anything, its screenshot is marked <span class="na">NA</span>.</p>
  ${shotFiles.has('06-menu-monitor.png') ? `<figure><img src="shots/06-menu-monitor.png" alt="Plugins menu" loading="lazy"><figcaption>The workspace menus — each panel is one click away, and only the panels the current engine supports appear.</figcaption></figure>` : ''}`;
  for (const group of GROUP_ORDER) {
    const ps = panelsByGroup[group] || [];
    if (!ps.length) continue;
    html += `<h2 class="group-h">${esc(group)}</h2>`;
    for (const p of ps) {
      const d = PANELDOC[p.id] || {};
      const engs = panelEngines(p.when);
      const shot = panelShot(p);
      const acts = (d.keyActions || []).map(a => `<li>${esc(a)}</li>`).join('');
      html += `
<div class="panel-doc" id="panel-${p.id}">
  <div class="panel-head">
    <h3>${esc(p.label)}</h3>
    <div class="panel-engs">${engs.map(e => `<span class="eng-badge e-${e}">${ENGINE_LABEL[e]}</span>`).join(' ')}</div>
  </div>
  <p>${esc(d.summary || p.tip || '')}</p>
  ${d.howToOpen ? `<p class="how"><b>Open:</b> ${esc(d.howToOpen)}</p>` : ''}
  ${acts ? `<div class="acts"><b>Key actions</b><ul>${acts}</ul></div>` : ''}
  ${d.engines ? `<p class="dim"><b>Engines:</b> ${esc(d.engines)}</p>` : ''}
  ${d.caveats ? `<p class="caveat"><b>Note:</b> ${esc(d.caveats)}</p>` : ''}
  ${shot
    ? `<figure><img src="${shot}" alt="${esc(p.label)} panel" loading="lazy"><figcaption>${esc(p.label)} <span class="cap-mac">— captured on macOS</span></figcaption></figure>`
    : `<div class="na-shot">📷 <b>Screenshot: NA.</b> This panel needs a live ${engs.map(e=>ENGINE_LABEL[e]).join('/')} connection with real data to render meaningfully, so it isn't captured in this offline build. The description above is complete and taken from the current source.</div>`}
</div>`;
    }
  }
  html += `</section>`;
  return html;
}

function dbaViewsSection() {
  const byEng = inv.dbaViews.byEngine;
  const engs = Object.keys(byEng);
  // summary chips
  const chips = engs.map(e => `<span class="eng-badge e-${e}">${ENGINE_LABEL[e]||e} · ${byEng[e].length}</span>`).join(' ');
  let rows = '';
  for (const e of engs) {
    for (const v of byEng[e]) {
      rows += `<tr data-search="${esc((v.label+' '+(v.category||'')+' '+v.id).toLowerCase())}" data-engines="${e}">
        <td>${esc(v.label)}</td><td class="dim">${esc(v.category||'')}</td><td><span class="eng-badge e-${e}">${ENGINE_LABEL[e]||e}</span></td></tr>`;
    }
  }
  return `
<section id="dbaviews" class="doc-section">
  <h1>DBA views</h1>
  <p class="lede">TxUI ships <b>${inv.dbaViews.total}</b> ready-made, read-only DBA views — curated <code>SELECT</code>s over each engine's system catalogs (sessions, locks, buffer pools, replication, table sizes, and more). Open the <b>DBA views</b> panel, pick one, and it runs instantly. Counts per engine:</p>
  <p>${chips}</p>
  <div class="toolbar">
    <input id="dbaFilter" class="filter" placeholder="Filter DBA views…" oninput="filterTable('dbaFilter','dbaTable')">
    <select id="dbaEngine" class="filter" onchange="filterEngine('dbaEngine','dbaTable')">
      <option value="">All engines</option>
      ${engs.map(e => `<option value="${e}">${ENGINE_LABEL[e]||e}</option>`).join('')}
    </select>
  </div>
  <table class="ref" id="dbaTable">
    <thead><tr><th>View</th><th>Category</th><th>Engine</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function settingsSection() {
  const SEC_ORDER = ['Appearance', 'Editor (Editor & browsing)', 'Connections', 'AI (AI assistant)', 'Safety', 'Logging', 'Security', 'Not shown in Settings UI'];
  const seen = new Set();
  let blocks = '';
  const emit = sec => {
    const items = prefBySection[sec]; if (!items) return; seen.add(sec);
    const rows = items.map(p => `<tr data-search="${esc((p.label+' '+p.name+' '+(p.description||'')).toLowerCase())}">
      <td>${esc(p.label || p.name)}</td>
      <td class="dim">${esc(p.description || '')}</td>
      <td class="mono dim">${esc(p.values || '')}</td>
      <td class="mono">${esc(String(p.default))}</td></tr>`).join('\n');
    blocks += `<h2 class="group-h">${esc(sec)}</h2><table class="ref"><thead><tr><th>Setting</th><th>What it does</th><th>Values</th><th>Default</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  for (const s of SEC_ORDER) emit(s);
  for (const s of Object.keys(prefBySection)) if (!seen.has(s)) emit(s);
  return `
<section id="settings" class="doc-section">
  <h1>Settings reference</h1>
  <p class="lede">All ${inv.counts.prefs} preferences, grouped by the tab they appear on in <span class="kbd"><span class="os os-mac">⌘,</span><span class="os os-win">Ctrl+,</span></span> Settings. Six advanced prefs are not surfaced in the Settings UI (they are controlled from the relevant view or command) and are grouped last.</p>
  <div class="toolbar"><input id="setFilter" class="filter" placeholder="Filter settings…" oninput="filterAllTables('setFilter','setWrap')"></div>
  <div id="setWrap">${blocks}</div>
  ${shotFiles.has('02-settings.png') ? `<figure><img src="shots/02-settings.png" alt="Settings" loading="lazy"><figcaption>The Settings dialog.</figcaption></figure>` : ''}
</section>`;
}

function shortcutRefListSection() {
  // commands grouped by category — printable cheat sheet
  let html = `<section id="cheatsheet" class="doc-section"><h1>Cheat sheet</h1><p class="lede">A one-page, printable card of the most-used commands, grouped by task. Print this section for your platform.</p><div class="cheat-grid">`;
  for (const cat of CMD_CAT_ORDER) {
    const cs = (cmdByCat[cat] || []).filter(c => c.shortcut);
    if (!cs.length) continue;
    html += `<div class="cheat-col"><h4>${esc(cat)}</h4>${cs.map(c => `<div class="cheat-row"><span>${esc(c.label)}</span>${kbd(c.shortcut)}</div>`).join('')}</div>`;
  }
  html += `</div></section>`;
  return html;
}

function troubleshootingSection() {
  return `
<section id="notes" class="doc-section">
  <h1>Availability &amp; known limits</h1>
  <p class="lede">TxUI is honest about what a given engine, platform or environment allows. When a feature can't run, the app tells you why rather than failing silently.</p>
  <ul class="limits">
    <li><b>Engine gating.</b> Panels and commands appear only for engines that support them (see the <a href="#engines">engine matrix</a>). A menu item greyed out with a tooltip means the current engine (or your role) doesn't allow it.</li>
    <li><b>Redis / Parquet.</b> No SQL editor for Redis; Parquet is a read-only in-memory scan — writes, transactions and DBA tooling are <span class="na">not available</span>.</li>
    <li><b>Live-connection panels.</b> Monitoring panels (Processes, Locks, Wait events, Listen/Notify, Statement statistics, Replication, Binary logs…) need an active server and real activity; in this offline documentation build their screenshots are marked <span class="na">NA</span>.</li>
    <li><b>Cloud SQL (IAM).</b> Service-account IAM auth is supported but requires a valid GCP key at runtime — <span class="na">not tested in this build</span>.</li>
    <li><b>Cross-platform shortcuts.</b> Every shortcut is defined once with <code>Mod</code> and rendered per-OS — there is no macOS-only or Windows-only chord.</li>
  </ul>
</section>`;
}

// nav
// Order matters: this is both the sidenav and the reading order of the page.
// "Engine support" sits second, directly after the overview — it is the first
// thing anyone evaluating TxUI wants ("does it do X on my database?"), and it
// used to be sixth, below three keyboard-shortcut sections. "Guides" is
// third: the prose walkthroughs, with first-steps.md first among them as the
// newbie entry point. (docsEngineMatrix.test.ts pins the first two slots.)
const NAV = [
  ['overview', 'Overview'], ['engines', 'Engine support'], ['guides', 'Guides'], ['workspace', 'The workspace'],
  ['shortcuts', 'Keyboard shortcuts'], ['cheatsheet', 'Cheat sheet'], ['coverage', 'Feature coverage'],
  ['panels', 'Tool panels'], ['dbaviews', 'DBA views'], ['settings', 'Settings'], ['notes', 'Availability & limits'],
];

const CSS = readFileSync(new URL('./docs.css', import.meta.url), 'utf8');
const JS = readFileSync(new URL('./docs.js', import.meta.url), 'utf8');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TxUI Help · v${V}</title>
<style>${CSS}</style>
</head>
<body class="show-mac">
<header class="topbar">
  <div class="brand"><span class="logo">Tx</span><span>TxUI Help</span><span class="ver-badge">v${V}</span></div>
  <div class="top-actions">
    <input id="globalSearch" class="global-search" placeholder="Search the docs…" oninput="globalSearch(this.value)" autocomplete="off">
    <div class="seg" id="osToggle">
      <button data-os="mac" class="active" onclick="setOS('mac')">macOS</button>
      <button data-os="win" onclick="setOS('win')">Windows·Linux</button>
    </div>
    <button class="icon-btn" onclick="toggleTheme()" title="Toggle theme" id="themeBtn">◐</button>
  </div>
</header>
<div class="layout">
  <nav class="sidenav">
    <ul>${NAV.map(([id, label]) => `<li><a href="#${id}">${label}</a>${id === 'guides'
      ? `<ul class="sub">${guides.map(g => `<li><a href="#guide-${g.id}">${esc(g.title)}</a></li>`).join('')}</ul>`
      : ''}</li>`).join('')}</ul>
    <div class="nav-foot">Generated from source<br>at v${V} · macOS screenshots</div>
  </nav>
  <main class="content" id="content">
    ${overviewSection()}
    ${engineMatrixSection()}
    ${guidesSection()}
    ${workspaceSection()}
    ${shortcutsSection()}
    ${shortcutRefListSection()}
    ${coverageMatrixSection()}
    ${panelsSection()}
    ${dbaViewsSection()}
    ${settingsSection()}
    ${troubleshootingSection()}
    <div id="noresults" class="noresults" hidden>No matches. <a href="#" onclick="clearGlobal();return false">Clear search</a></div>
    <footer class="foot">TxUI v${V} · ${inv.counts.panels} panels · ${inv.counts.commands} commands · ${inv.counts.dbaViews} DBA views · ${inv.counts.engines} engines. This help is generated directly from the application source, so it always reflects the shipped version.</footer>
  </main>
</div>
<script>${JS}</script>
</body>
</html>`;

writeFileSync(`${R}/index.html`, html);
const bytes = Buffer.byteLength(html);
console.log(`docs/index.html written (${(bytes/1024).toFixed(0)} KB)`);
console.log(`panels with screenshots: ${inv.panels.filter(p=>panelShot(p)).length}/${inv.counts.panels}`);
console.log(`total screenshots referenced: ${shotFiles.size}`);
