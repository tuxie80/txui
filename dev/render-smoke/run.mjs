// Render-smoke runner: bundle a component (bundle.mjs), install the DOM shim,
// then render it two ways:
//
//   ssr   — react-dom/server renderToString. Exercises the whole render body:
//           prop handling, derived state, fixture decoding. Effects never run.
//   mount — react-dom/client createRoot into the fake DOM, flushed with
//           React's act(). useEffect bodies execute for real: invoke() calls
//           land in the programmable stub, canvas paint paths run against the
//           stub 2d context, ResizeObserver fires once, dgui:* listeners
//           attach to the shimmed window.
//
// Props are auto-probed from the component's destructured signature when a
// target does not name them explicitly (see probeProps): known names get
// fixtures, on* get no-ops, anything unknown marks the target needs-fixture
// instead of guessing — the table this runner prints is the deliverable, and
// a guessed prop renders a misleading panel.
//
// This file is imported by dev/render_smoke.mjs (CLI sweep) and by
// tests/renderSmoke.test.ts (the node --test wiring). It must stay free of
// top-level browser/React imports — the shim has to be in place before
// react-dom is ever evaluated, so both are dynamic imports.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDomShim } from './dom-shim.mjs';
import { bundleComponents } from './bundle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

let REACT = null; // { React, renderToString, createRoot, act }

async function react() {
  if (REACT) return REACT;
  installDomShim();
  // A rejected promise inside an effect (`invoke(...).then(r => r.rows.map)` on
  // a null fixture) is exactly the bug class this harness exists to catch —
  // but Node's default is to kill the process. Record instead; runTarget
  // attributes the recording to the target under test via shim.asyncErrors.
  process.on('unhandledRejection', e => {
    installDomShim().asyncErrors.push(e instanceof Error ? e : new Error(String(e)));
  });
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  REACT = { React, renderToString, createRoot, act };
  return REACT;
}

/** Install (or replace) the programmable invoke hub. Returns it. */
export function installHub(mock = {}) {
  const g = globalThis;
  g.__TXUI_SMOKE__ = { mock, calls: [], listeners: g.__TXUI_SMOKE__?.listeners ?? new Map() };
  return g.__TXUI_SMOKE__;
}

/** Fire a Tauri event into every listener a mounted component registered. */
export function emitTauriEvent(event, payload) {
  const h = globalThis.__TXUI_SMOKE__;
  for (const cb of [...(h?.listeners?.get(event) ?? [])]) cb({ event, payload });
}

// ── prop probing ────────────────────────────────────────────────────────────

const NOOP = () => {};

/** Standard fixtures by prop name — the panel contract's vocabulary. */
export function standardProps(fixtures) {
  const session = {
    connectionId: 'c1', sessionId: 's1', connectionName: 'prod-orders (mysql)',
    engine: 'mysql', environment: 'dev', readOnly: false,
  };
  return {
    session,
    sessionId: session.sessionId,
    connectionId: session.connectionId,
    currentConnectionId: session.connectionId,
    connectionName: session.connectionName,
    engine: 'mysql',
    environment: 'dev',
    readOnly: false,
    isActive: true,
    // `schema` on a panel prop is the CURRENT DEFAULT schema name (string),
    // not the object tree — panels fetch the tree themselves over invoke.
    schema: 'shop',
    columns: ['id', 'name', 'total'],
    rows: [[1, 'alpha', '10.50'], [2, 'beta', '20.75'], [3, 'gamma', null]],
    result: fixtures.queryResult(['id', 'name'], [[1, 'alpha'], [2, 'beta']]),
    results: [fixtures.queryResult(['id', 'name'], [[1, 'alpha'], [2, 'beta']])],
    dbList: ['shop', 'analytics'],
    currentDb: 'shop',
    buffers: [],
    versions: [],
    current: null,
    latestRows: [],
    openSessions: [session],
    sessions: [],
    activeUtility: null,
    activeSessionId: null,
    column: 'name',
    value: 'sample-value',
    row: [1, 'alpha', '10.50'],
    rowIndex: 0,
    x: 100,
    y: 100,
    items: [],
    label: 'smoke',
    folder: 'Production',
    target: null,
    scope: null,
    initialDir: null,
    pinnedThread: null,
    insertTextRef: { current: null },
    apiOutRef: { current: null },
    refreshKey: 0,
    path: null,
    sql: 'SELECT 1',
    currentSql: 'SELECT 1',
    title: 'Smoke',
    mode: 'mysql',
    error: null,
    def: null,
    blocked: null,
    trigger: null,
    anchor: null,
    data: null,
    plan: null,
    model: null,
    runs: [],
    selected: null,
    pos: new Map(),
    tables: [],
    bounds: { w: 400, h: 300 },
    view: { x: 0, y: 0, w: 400, h: 300 },
    density: 'all',
    series: [{ name: 'total', points: [1, 4, 2] }],
    labels: ['a', 'b', 'c'],
    getData: () => fixtures.queryResult(['id'], [[1]]),
    initialMode: 'map',
    initial: null,
    initialGroup: '',
    tableName: 'result',
    hasSelection: false,
    onlySections: undefined,
    perSection: 5,
    placeholder: '',
    area: false,
    height: 320,
    size: 14,
    panel: 'processes',
    inline: false,
    filters: [],
    sort: [],
    // misc small props surfaced by the first sweep's needs-fixture list
    tabLabel: 'orders',
    isDisconnect: false,
    activities: [],
    options: [{ value: 'a', label: 'A' }],
    className: '',
    variant: '',
    color: null,
    kind: 'info',
    caret: 0,
    bookmarks: [],
    sid: 's1',
    variables: [],
    stmtNo: 1,
    total: 2,
    inTransaction: false,
    savepointed: false,
    top: 0,
    loading: false,
    timestamps: [1, 2, 3],
    cursorIndex: 0,
    hideLegend: false,
    unit: '',
    markers: [],
    currentValues: [],
    currentTs: null,
    hoverIndex: null,
    index: 0,
    liveIndex: 0,
    playing: false,
    speed: 1,
    probe: null,
    dimmed: false,
    matched: false,
    hoverCol: null,
    relCols: [],
    drift: null,
    request: { sql: 'DELETE FROM t WHERE id = 1', statementKind: 'delete', table: 't', where: false, rowsAffected: null },
    // FastGrid's wider vocabulary
    sort: [], filteredCols: new Set(), meta: [], pkColumns: [],
    pendingKeys: new Set(), apiRef: { current: null }, rowClass: undefined,
    children: null,
    onClose: NOOP, onSave: NOOP, onCancel: NOOP, onInsert: NOOP, onSelect: NOOP,
    onChange: NOOP, onRun: NOOP, onConfirm: NOOP, onRestore: NOOP, onOpenRaw: NOOP,
    onInsertIds: NOOP, onUnpin: NOOP, onBrowseTable: NOOP, onInsertText: NOOP,
    onCollapse: NOOP, onSchemaChanged: NOOP, onTargetConsumed: NOOP,
    onScopeConsumed: NOOP, onChangeDb: NOOP, onSelectRow: NOOP, onAnalyze: NOOP,
    onMode: NOOP, onRecordRuns: NOOP, onOpened: NOOP, onNote: NOOP, onJump: NOOP,
    onCreated: NOOP, onToggle: NOOP, onConsumed: NOOP, onDone: NOOP,
  };
}

/**
 * Read the destructured prop names out of a compiled component's source.
 * Rolldown output is not minified (minify: false in bundle.mjs), so
 * `function MapView({ columns, rows, onSelectRow })` survives verbatim.
 * Returns null when the shape is not a plain destructured function — the
 * caller then reports needs-fixture rather than probing garbage.
 */
export function propNamesOf(fn) {
  // memo() and forwardRef() wrap the real function one level down.
  const inner = typeof fn === 'function' ? fn : (fn?.type ?? fn?.render);
  if (typeof inner !== 'function') return null;
  const src = Function.prototype.toString.call(inner);
  const m = src.match(/^[^(]*\(\s*\{([^)]*?)\}\s*[,)]/s);
  if (!m) return null;
  return m[1].split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => p.split(/[=:]/)[0].trim())
    .filter(p => /^[A-Za-z_$][\w$]*$/.test(p));
}

/** Build props for a component: explicit overrides win, known names get
 *  fixtures, unknown names collect as `missing`. */
export function probeProps(fn, { explicit = {}, fixtures } = {}) {
  const standard = standardProps(fixtures);
  const names = propNamesOf(fn) ?? Object.keys(explicit);
  const props = {};
  const missing = [];
  for (const name of names) {
    if (name in explicit) { props[name] = explicit[name]; continue; }
    // Standard fixtures before the on* heuristic — `onlySections` is data.
    if (name in standard) { props[name] = standard[name]; continue; }
    if (/^on[A-Z]/.test(name)) { props[name] = NOOP; continue; }
    missing.push(name);
  }
  // Explicit props for names the probe could not see (defaults, aliasing).
  for (const [k, v] of Object.entries(explicit)) if (!(k in props)) props[k] = v;
  return { props, missing };
}

// ── rendering ───────────────────────────────────────────────────────────────

async function loadEntry(outDir, entryName) {
  const file = path.join(outDir, `${entryName}.mjs`);
  // Bust Node's module cache so a re-bundle after an edit is picked up.
  const url = `file://${file}?v=${Date.now()}`;
  return import(url);
}

function isComponentLike(v) {
  return typeof v === 'function'
    || (v !== null && typeof v === 'object' && '$$typeof' in v); // memo/forwardRef
}

function pickExport(mod, exportName, entryName) {
  if (exportName && mod[exportName]) return mod[exportName];
  if (mod.default) return mod.default;
  const fns = Object.entries(mod).filter(([, v]) => isComponentLike(v));
  if (fns.length === 1) return fns[0][1];
  const guess = fns.find(([k]) => k.toLowerCase() === entryName.replace(/[-_]/g, '').toLowerCase());
  if (guess) return guess[1];
  throw new Error(`cannot pick export for ${entryName} (have: ${Object.keys(mod).join(', ')})`);
}

/** Serialize a fake-DOM subtree to HTML-ish text for assertions. */
export function outerHTML(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  if (node.nodeType === 9 || node.nodeType === 11) {
    return node.childNodes.map(outerHTML).join('');
  }
  const attrs = [...node.attributes.entries()].map(([k, v]) => (v === '' ? k : `${k}="${v}"`)).join(' ');
  const open = attrs ? `<${node.localName} ${attrs}>` : `<${node.localName}>`;
  return `${open}${node.childNodes.map(outerHTML).join('')}</${node.localName}>`;
}

/**
 * Run one target. A target is:
 *   { name, file, export?, props?, mock?, tier?: 'ssr'|'mount',
 *     settleMs?, assert?: (ctx) => void | string }
 * ctx for assert: { html, calls, root?, container?, emitTauriEvent, hub }
 */
export async function runTarget(target, { outDir, fixtures }) {
  const { React, renderToString, createRoot, act } = await react();
  const shim = installDomShim();
  shim.localStorage.clear();
  const hub = installHub(target.mock ?? {});

  const result = {
    name: target.name,
    file: target.file,
    tier: target.tier ?? 'ssr',
    status: 'rendered',
    missingProps: [],
    calls: hub.calls,
    html: '',
    error: null,
  };

  let Component, missing = [], componentProps = {};
  try {
    const mod = await loadEntry(outDir, target.name);
    Component = pickExport(mod, target.export, target.name);
    const probed = probeProps(Component, { explicit: target.props ?? {}, fixtures });
    missing = probed.missing;
    result.missingProps = missing;
    componentProps = probed.props;
  } catch (e) {
    result.status = 'failed';
    result.error = `load: ${e?.message ?? e}`;
    return result;
  }
  if (missing.length > 0 && !target.allowMissing) {
    result.status = 'needs-fixture';
    return result;
  }

  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };

  // Tier 1: SSR. A throw here is a render-body bug for ssr-tier targets. For
  // mount-tier targets it is only a note — apps built on useSyncExternalStore
  // without getServerSnapshot legitimately cannot server-render, and the
  // mount is the real exercise.
  try {
    result.html = renderToString(React.createElement(Component, componentProps));
  } catch (e) {
    const msg = e?.message ?? String(e);
    // useSyncExternalStore without getServerSnapshot is not SSR-able — that is
    // a legitimate client-only store, not a bug. Promote the target to the
    // mount tier, which exercises more of it anyway.
    if (/getServerSnapshot/.test(msg) && !target.noPromote) {
      result.tier = 'mount';
      result.promoted = true;
    } else if (result.tier !== 'mount') {
      console.error = origError;
      result.status = 'failed';
      result.error = `ssr: ${e?.stack?.split('\n').slice(0, 4).join(' | ') ?? e}`;
      return result;
    } else {
      result.ssrError = msg;
    }
  }

  if (result.tier !== 'mount') {
    console.error = origError;
    result.consoleErrors = errors.filter(e => !/act\(|useLayoutEffect does nothing on the server/.test(e));
    return result;
  }

  // Tier 2: real mount, effects run.
  const container = shim.document.createElement('div');
  shim.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Component, componentProps)); });
    // Let async effects (await invoke(...); setState) settle.
    await act(async () => { await new Promise(r => setTimeout(r, target.settleMs ?? 25)); });
    if (target.interact) {
      await target.interact({ container, emitTauriEvent, act, hub, React, shim });
      await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    }
  } catch (e) {
    result.status = 'mount-failed';
    result.error = `mount: ${e?.stack?.split('\n').slice(0, 4).join(' | ') ?? e}`;
  } finally {
    console.error = origError;
  }
  // Async crashes from timers/rAF land in the shim's asyncErrors rather than
  // killing the process; attribute them to this target.
  const asyncErrs = shim.asyncErrors.splice(0);
  if (asyncErrs.length > 0 && result.status !== 'mount-failed') {
    const e = asyncErrs[0];
    result.status = 'mount-failed';
    result.error = `async: ${e?.stack?.split('\n').slice(0, 4).join(' | ') ?? e}`;
  }
  result.mountedHtml = outerHTML(container);
  result.container = container;
  result.consoleErrors = errors.filter(e => !/act\(|useLayoutEffect does nothing on the server/.test(e));
  if (result.status === 'rendered') result.status = 'mounted';
  if (typeof target.assert === 'function' && result.status === 'mounted') {
    try {
      const msg = await target.assert({
        html: result.mountedHtml, ssrHtml: result.html, calls: hub.calls,
        container, emitTauriEvent, hub, act, React, shim,
      });
      if (typeof msg === 'string' && msg) {
        result.status = 'assert-failed';
        result.error = msg;
      }
    } catch (e) {
      result.status = 'assert-failed';
      result.error = `assert: ${e?.message ?? e}`;
    }
  }
  try { await act(async () => { root.unmount(); }); } catch { /* cleanup path */ }
  // Post-unmount strays (a rAF scheduled just before teardown) are harness
  // noise unless they repeat while mounted — record, don't fail.
  await new Promise(r => setTimeout(r, 30));
  const strays = shim.asyncErrors.splice(0);
  if (strays.length > 0) result.postUnmountErrors = strays.map(e => e?.message ?? String(e));
  container.remove();
  return result;
}

/**
 * Bundle and run a set of targets in one pass.
 * @returns {Promise<Map<string, object>>} name -> result
 */
export async function runTargets(targets, { fixtures } = {}) {
  const entries = targets.map(t => [t.name, path.join(ROOT, t.file)]);
  for (const [, abs] of entries) {
    if (!fs.existsSync(abs)) throw new Error(`target file missing: ${abs}`);
  }
  const outDir = await bundleComponents(entries);
  const results = new Map();
  for (const target of targets) {
    results.set(target.name, await runTarget(target, { outDir, fixtures }));
  }
  return results;
}
