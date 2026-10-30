// The render-smoke target table.
//
// Two kinds of entry:
//
//   named   — the surfaces docs/NEXT.md §Wave 6 calls out as never driven.
//             These carry explicit fixtures and assertions (markup contents,
//             recorded invoke calls, dispatched dgui:* events). A regression
//             here fails tests/renderSmoke.test.ts.
//
//   sweep   — every other component file, rendered with auto-probed props
//             (run.mjs standardProps). What the sweep CANNOT honestly render
//             says so: status needs-fixture lists the prop names nobody could
//             guess, and 'cannot' entries below carry the reason in prose.
//
// Statuses a run can produce: mounted | rendered (SSR only) | needs-fixture |
// failed | mount-failed | assert-failed | cannot.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** Files that export helpers/icons, not a renderable panel. */
const NON_PANEL = new Set([
  'editorChangeBars.ts', 'editorLineCommands.ts', 'editorRulers.ts',
  'editorRunMarkers.ts', 'iconAssets.ts', 'indentGuides.ts', 'minimap.ts',
  'searchBadge.ts', 'sqlPatternSearch.ts',
  // Icon vocabulary modules — many named exports, no single component.
  'engineLogos.tsx', 'treeIcons.tsx', 'panelIcons.tsx',
]);

const VAULT_UNLOCKED = { state: 'unlocked', path: '/tmp/smoke/vault.txui', connections: 2, secrets: 3 };

export function namedTargets(fixtures) {
  const trackProps = {
    columns: ['captured_at', 'lat', 'lon'],
    rows: [
      ['2026-10-01 10:00:00', 50.0755, 14.4378],
      ['2026-10-01 10:05:00', 50.0870, 14.4207],
      ['2026-10-01 10:10:00', 50.1020, 14.4500],
    ],
  };
  const trackColumnInfo = trackProps.columns.map(name => ({ name, type_name: 'varchar', nullable: true }));

  // Little-endian EWKB Point with an explicit SRID, as PostGIS sends it.
  const ewkbPoint = (srid, x, y) => {
    const b = new Uint8Array(25);
    const v = new DataView(b.buffer);
    b[0] = 1;
    v.setUint32(1, 0x20000001, true);   // Point + EWKB SRID flag
    v.setUint32(5, srid, true);
    v.setFloat64(9, x, true);
    v.setFloat64(17, y, true);
    return [...b].map(n => n.toString(16).padStart(2, '0')).join('');
  };

  return [
    {
      // The sharpest Wave 6 case: canvas + ResizeObserver + drag scrubber,
      // all previously unit-tested only at the pure layer.
      name: 'MapView', file: 'src/components/MapView.tsx', tier: 'mount',
      props: trackProps,
      assert: ({ html, ssrHtml }) => {
        for (const needle of ['<canvas', 'map-scrub', '3 points']) {
          if (!html.includes(needle)) return `mounted markup lacks "${needle}"`;
        }
        if (!ssrHtml.includes('map-root')) return 'ssr markup lacks map-root';
      },
    },
    {
      // Round-2 geo: a lon/lat geometry column opens geometry-first, and the
      // GeoParquet footer bbox (initialBbox) drives the first fit rather than
      // the loaded page's own extent.
      // (Identifier-style name: rolldown sanitizes entry names into bundle
      // file names, so spaces and punctuation break the import.)
      name: 'MapViewGeoFirst', file: 'src/components/MapView.tsx', tier: 'mount',
      props: {
        columns: ['id', 'geom'],
        columnTypes: ['int4', 'geometry'],
        rows: [
          [1, ewkbPoint(4326, 14.4378, 50.0755)],
          [2, ewkbPoint(4326, 14.4207, 50.0870)],
        ],
        initialBbox: [14.2, 49.9, 14.8, 50.2],
      },
      assert: ({ html }) => {
        for (const needle of ['<canvas', '2 geometries']) {
          if (!html.includes(needle)) return `mounted markup lacks "${needle}"`;
        }
      },
    },
    {
      // Round-2 geo: a projected CRS (3857) is politely refused, and on
      // PostgreSQL the refusal offers the explicit derived-query action.
      name: 'MapViewProjectedRefusal', file: 'src/components/MapView.tsx', tier: 'mount',
      props: {
        columns: ['id', 'geom'],
        columnTypes: ['int4', 'geometry'],
        rows: [
          [1, ewkbPoint(3857, 1606175, 6462465)],
          [2, ewkbPoint(3857, 1605000, 6463000)],
        ],
        engine: 'postgres',
        sourceSql: 'SELECT id, geom FROM districts',
      },
      assert: ({ html }) => {
        for (const needle of ['not longitude/latitude', 'SRID 3857', 'View in WGS 84']) {
          if (!html.includes(needle)) return `mounted markup lacks "${needle}"`;
        }
      },
    },
    {
      name: 'GraphicsView', file: 'src/components/GraphicsView.tsx', tier: 'mount',
      props: { columns: trackColumnInfo, rows: trackProps.rows, initialMode: 'map' },
      assert: ({ html }) => (html.includes('<canvas') ? undefined : 'no canvas in graphics view'),
    },
    {
      name: 'SecurityPanel', file: 'src/components/SecurityPanel.tsx', tier: 'mount',
      mock: { vault_status: VAULT_UNLOCKED },
      assert: ({ html, calls }) => {
        if (!html.includes('Safe Vault — open')) return 'unlocked vault state not rendered';
        if (!calls.some(c => c.cmd === 'vault_status')) return 'vault_status never invoked';
      },
    },
    {
      // The vault gate in its one interesting state: a vault that exists and
      // is locked. plain/unlocked render null by design.
      name: 'UnlockGate', file: 'src/components/UnlockGate.tsx', tier: 'mount',
      mock: { vault_status: { state: 'locked', path: '/tmp/smoke/vault.txui' } },
      props: { onOpened: () => {} },
      assert: ({ html, calls }) => {
        if (!calls.some(c => c.cmd === 'vault_status')) return 'vault_status never invoked';
        if (!html.includes('password')) return 'locked gate did not render the password prompt';
      },
    },
    {
      name: 'RevealGate', file: 'src/components/RevealGate.tsx', tier: 'mount',
      assert: () => undefined, // renders null; a mount without a throw is the test
    },
    {
      name: 'SettingsModal', file: 'src/components/SettingsModal.tsx', tier: 'mount',
      mock: { vault_status: VAULT_UNLOCKED },
      props: { onClose: () => {} },
      // Click through every settings tab; the Security tab mounts
      // SecurityPanel, so the vault_status call proves the click landed.
      interact: async ({ container, act }) => {
        // querySelectorAll is out of shim scope; walk the fake tree for tabs.
        const walk = (n, out = []) => {
          if (n.attributes?.get?.('role') === 'tab') out.push(n);
          for (const c of n.childNodes ?? []) walk(c, out);
          return out;
        };
        for (const tab of walk(container)) {
          await act(async () => {
            tab.dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(r => setTimeout(r, 5));
          });
        }
      },
      assert: ({ html, calls }) => {
        for (const needle of ['settings-tab', 'Appearance', 'Safety']) {
          if (!html.includes(needle)) return `settings markup lacks "${needle}"`;
        }
        if (!calls.some(c => c.cmd === 'vault_status')) {
          return 'clicking through the tabs never mounted SecurityPanel (vault_status not called)';
        }
      },
    },
    {
      // The pre-flight window in its defining state: something would be
      // refused, so there must be NO Run button at all.
      name: 'ScriptPreflight', file: 'src/components/ScriptPreflight.tsx', tier: 'mount',
      props: {
        report: {
          rows: [
            { index: 1, line: 1, preview: 'DELETE FROM orders', verdict: 'blocked', reason: 'DELETE without a WHERE clause', writes: true },
            { index: 2, line: 2, preview: 'SELECT 1', verdict: 'ok', writes: false },
          ],
          total: 2, writes: 1, blocked: 1, needConfirm: 0,
          canRun: false, summary: '1 of 2 statements would be refused',
        },
        connectionName: 'prod-orders (mysql)', environment: 'prod', readOnly: false,
      },
      assert: ({ html }) => {
        if (!html.includes('cannot run')) return 'blocked preflight did not say so';
        if (!html.includes('DELETE without a WHERE')) return 'refusal reason not rendered';
      },
    },
    {
      name: 'WriteConfirm', file: 'src/components/WriteConfirm.tsx', tier: 'mount',
      mock: { monitor_query: { rows: [[42]] } },
      props: {
        request: {
          sql: 'DELETE FROM orders', sessionId: 's1', connectionName: 'prod-orders (mysql)',
          environment: 'prod', hasDefaultDb: true, reason: 'no-where',
          engine: 'mysql', schema: null,
        },
      },
      assert: ({ html, calls }) => {
        if (!html.includes('42')) return 'blast-radius count not rendered';
        if (!calls.some(c => c.cmd === 'monitor_query')) return 'row count was never fetched';
      },
    },
    {
      name: 'ProdAck', file: 'src/components/ProdAck.tsx', tier: 'mount',
      props: {
        request: { connectionName: 'prod-orders (mysql)', allowDdl: false, allowUnfiltered: false, rowCap: 1000 },
      },
      assert: ({ html }) => (html.includes('PRODUCTION') ? undefined : 'prod ack did not render the warning'),
    },
    {
      // Chart presets: every chart family must mount with a real result set,
      // and clicking through the five presets must not throw.
      name: 'ResultChart', file: 'src/components/ResultChart.tsx', tier: 'mount',
      props: {
        columns: [
          { name: 'channel', type_name: 'varchar', nullable: false },
          { name: 'total', type_name: 'decimal(10,2)', nullable: false },
          { name: 'n', type_name: 'bigint', nullable: false },
        ],
        rows: [['web', '128.40', 3], ['mobile', '54.00', 5], ['partner', '431.00', 2]],
      },
      interact: async ({ container, act }) => {
        const walk = (n, out = []) => {
          if (n.nodeName === 'BUTTON' && /bar|line|area|pie|scatter/.test(n.textContent)) out.push(n);
          for (const c of n.childNodes ?? []) walk(c, out);
          return out;
        };
        for (const btn of walk(container)) {
          await act(async () => {
            btn.dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(r => setTimeout(r, 5));
          });
        }
      },
      assert: ({ html }) => {
        for (const needle of ['bar', 'line', 'area', 'pie', 'scatter', '<svg']) {
          if (!html.includes(needle)) return `chart markup lacks "${needle}"`;
        }
      },
    },
    {
      name: 'SeriesChart', file: 'src/components/ResultChart.tsx', export: 'SeriesChart', tier: 'mount',
      props: { series: [{ name: 'total', points: [1, 4, 2, 8, 5] }], labels: ['a', 'b', 'c', 'd', 'e'] },
      assert: ({ html }) => (html.includes('<svg') ? undefined : 'no svg'),
    },
    {
      // The grid everything sits on.
      name: 'FastGrid', file: 'src/components/FastGrid.tsx', tier: 'mount',
      assert: ({ html }) => (html.length > 100 ? undefined : 'grid rendered almost nothing'),
    },
    {
      name: 'PgWorkloadPanel', file: 'src/components/PgWorkloadPanel.tsx', tier: 'mount',
      props: {
        session: {
          connectionId: 'c-pg', sessionId: 's-pg', connectionName: 'prod-orders (postgres)',
          engine: 'postgres', environment: 'dev', readOnly: false,
        },
      },
      mock: (() => {
        let captures = 0;
        let lastSnapshotAt = 0;
        const columns = ['queryid', 'query', 'calls', 'total_exec_time', 'mean_exec_time', 'rows', 'shared_blks_hit', 'shared_blks_read'];
        return {
          monitor_query: args => {
            const sql = String(args?.sql ?? '');
            if (sql.includes('pg_available_extensions')) return fixtures.queryResult(['installed', 'available'], [['1.10', '1.10']]);
            if (sql.includes('server_version_num')) return fixtures.queryResult(['version'], [['170000']]);
            if (sql.includes('FROM pg_stat_statements')) {
              captures += 1;
              lastSnapshotAt = Date.now();
              const rows = captures === 1
                ? [['10', 'SELECT * FROM orders WHERE id = $1', 10, 100, 10, 20, 90, 10]]
                : [['10', 'SELECT * FROM orders WHERE id = $1', 15, 400, 400 / 15, 35, 140, 15]];
              return fixtures.queryResult(columns, rows);
            }
            return fixtures.queryResult(['unused'], []);
          },
          incident_timeline: () => [
            { id: 'long_query:1', kind: 'long_query', at_ms: lastSnapshotAt, title: 'Long query — SELECT orders', detail: 'SELECT * FROM orders WHERE id = $1', ok: true, duration_ms: 2400, ref_id: 1 },
            { id: 'deadlock:1', kind: 'deadlock', at_ms: lastSnapshotAt, title: 'Deadlock — victim 42', detail: 'orders ↔ order_lines', ok: false, duration_ms: 0, ref_id: 1 },
          ],
          pg_wait_sample_start: null,
          pg_wait_sample_stop: null,
        };
      })(),
      interact: async ({ container, act, hub }) => {
        const click = async text => {
          const walk = (n, out = []) => {
            if (n.nodeName === 'BUTTON' && n.textContent.includes(text)) out.push(n);
            for (const child of n.childNodes ?? []) walk(child, out);
            return out;
          };
          const button = walk(container)[0];
          if (!button) throw new Error(`button not found: ${text}`);
          await act(async () => {
            button.dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));
          });
        };
        await click('1. Capture baseline');
        await click('Start wait sampling');
        const start = hub.calls.find(c => c.cmd === 'pg_wait_sample_start');
        if (!start) throw new Error('wait sampler was not started');
        await act(async () => {
          start.args.onEvent.onmessage({ type: 'Sampling', intervalMs: 150 });
          start.args.onEvent.onmessage({
            type: 'Snapshot', atMs: Date.now(),
            backends: [{ pid: 42, waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', query: 'SELECT 1' }],
          });
          await new Promise(r => setTimeout(r, 5));
        });
        await click('2. Capture after');
      },
      assert: ({ html, calls }) => {
        for (const needle of ['Ranked statement deltas', '+300', 'DataFileRead', 'Deadlock — victim 42', 'Local incidents in the same window']) {
          if (!html.includes(needle)) return `workload report lacks "${needle}"`;
        }
        if (!calls.some(c => c.cmd === 'incident_timeline')) return 'local incidents were not fetched';
        if (!calls.some(c => c.cmd === 'pg_wait_sample_stop')) return 'after capture did not stop wait sampling';
      },
    },
    {
      // The whole app chrome: File/Help menu events arrive from the native
      // menu as Tauri events; App translates them into dgui:* window events
      // and modal state. This drives that translation end to end.
      name: 'App', file: 'src/App.tsx', tier: 'mount', settleMs: 60,
      mock: {
        vault_status: VAULT_UNLOCKED,
        list_connections: [],
        get_app_version: '0.0.0-smoke',
      },
      interact: async ({ container, emitTauriEvent, act, shim }) => {
        const seen = [];
        shim.window.addEventListener('dbgui:new-tab', () => seen.push('new-tab'));
        shim.window.addEventListener('dbgui:close-tab', () => seen.push('close-tab'));
        await act(async () => {
          emitTauriEvent('dbgui:menu-action', 'file:new-tab');
          emitTauriEvent('dbgui:menu-action', 'file:close-tab');
          await new Promise(r => setTimeout(r, 10));
        });
        container.__menuSeen = seen;
        await act(async () => {
          emitTauriEvent('dbgui:about', null);
          await new Promise(r => setTimeout(r, 20));
        });
      },
      assert: ({ container, html }) => {
        const seen = container.__menuSeen ?? [];
        if (!seen.includes('new-tab')) return 'file:new-tab did not reach the dgui:new-tab window event';
        if (!seen.includes('close-tab')) return 'file:close-tab did not reach the dgui:close-tab window event';
        // Help → About: the Tauri 'dbgui:about' event must open the modal.
        if (!html.includes('0.0.0-smoke')) return 'dbgui:about did not open the About modal (version string absent)';
      },
    },
  ];
}

/** Components that genuinely cannot render without a live backend or an
 *  embedding parent — said explicitly, per the task, never silently skipped. */
const CANNOT = {
  SqlEditor: 'CodeMirror EditorView requires a real DOM measurement loop (getClientRects per char)',
  QueryEditor: 'CodeMirror EditorView requires a real DOM measurement loop',
};

/**
 * Per-component fixtures for sweep entries whose props cannot be guessed
 * (deep value objects). Each is built from the SAME fixtures/utilities the
 * real pipeline uses — doc-fixtures.mjs payloads and the pure parsers in
 * src/utils — so the rendered markup is what a user would see, not a
 * hand-shaped approximation.
 */
export async function sweepFixtures(fixtures) {
  const { parsePlan } = await import('../../src/utils/planParse.ts');
  const { buildCostModel } = await import('../../src/utils/planCost.ts');

  // EXPLAIN_JSON is already ExplainData-shaped: {format, engine, content}.
  const explainData = { ...fixtures.EXPLAIN_JSON, analyzed: true,
    sql: 'SELECT * FROM orders o JOIN order_lines l ON l.order_id = o.id', at: Date.now() };
  let parsed = null, model = null;
  try {
    parsed = parsePlan(fixtures.EXPLAIN_JSON.engine, fixtures.EXPLAIN_JSON.content);
    model = parsed ? buildCostModel(parsed) : null;
  } catch { /* leaves PlanGraph at needs-fixture rather than failing on us */ }

  const routineDef = {
    kind: 'procedure', schema: 'shop', name: 'close_order',
    params: [{ name: 'p_id', mode: 'in', type: 'bigint' }],
    returns: null, language: 'sql', characteristics: [],
    body: 'UPDATE orders SET status = \'closed\' WHERE id = p_id;',
  };

  return {
    CommandPalette: { props: { items: [
      { label: 'New tab', section: 'action', action: () => {} },
      { label: 'orders', section: 'table', action: () => {}, hint: 'shop' },
    ] } },
    // The staged-diagnostics checklist (W3.1): a failed run mid-way, so both
    // the ok/skipped rows and the red failing detail render.
    ConnDiagChecklist: { props: { result: {
      stages: [
        { id: 'dns', label: 'DNS resolution', status: 'ok', ms: 2, detail: 'db.example.com → 192.0.2.10' },
        { id: 'tcp', label: 'TCP connect', status: 'ok', ms: 11, detail: 'connected to 192.0.2.10:3306' },
        { id: 'ssh', label: 'SSH tunnel', status: 'skipped', ms: 0, detail: 'no SSH tunnel configured' },
        { id: 'tls', label: 'TLS handshake', status: 'ok', ms: 42, detail: 'TLSv1.3, cipher TLS_AES_256_GCM_SHA384' },
        { id: 'auth', label: 'Authenticate', status: 'fail', ms: 18, detail: 'Access denied for user \'app\'@\'%\'' },
        { id: 'probe', label: 'Version probe', status: 'skipped', ms: 0, detail: 'not reached — stage \'authenticate\' failed' },
      ],
      total_ms: 73,
      verdict: 'fail',
    } } },
    DataBrowser: {
      props: { table: 'shop.orders', dbUser: 'app_rw', resultLabel: 'Result 1', txOpen: false },
      mock: {
        browse_table: fixtures.queryResult(['id', 'customer', 'total'], [[1, 'Aisha Rahman', '128.40']]),
        get_table_meta: {
          columns: [
            { name: 'id', type_name: 'bigint', nullable: false },
            { name: 'customer', type_name: 'varchar(120)', nullable: false },
            { name: 'total', type_name: 'decimal(10,2)', nullable: false },
          ],
          pk_columns: ['id'],
          total_rows: 10251,
        },
      },
    },
    ExplainView: { props: { data: explainData } },
    PlanGraph: parsed && model
      ? { props: { plan: parsed, model, mode: 'graph', selected: null } }
      : {},
    KillPicker: {
      props: {
        trigger: { kind: 'kill', mode: 'query', filter: '', from: 0, to: 4 },
        anchor: { x: 40, y: 80, lineBottom: 96 },
      },
      mock: { list_processes: fixtures.PROCESSLIST_RESULT },
    },
    ErMinimap: {
      props: {
        tables: [{ name: 'orders', columns: [{ name: 'id', pk: true }] }],
        pos: new Map([['orders', { x: 0, y: 0 }]]),
        density: 'header', bounds: { w: 400, h: 300 },
        view: { x: 0, y: 0, w: 400, h: 300 }, selected: null,
      },
    },
    ResultDiffPanel: {
      props: { results: [
        { id: 1, label: 'Result 1', result: fixtures.ORDERS_RESULT },
        { id: 2, label: 'Result 2', result: fixtures.queryResult(['id', 'customer'], [[1, 'Aisha Rahman']]) },
      ] },
    },
    RoutineDebugger: { props: { def: routineDef } },
    RedisBrowser: {
      props: {
        session: {
          connectionId: 'c4', sessionId: 's4', connectionName: 'cache (redis)',
          engine: 'redis', environment: 'dev', readOnly: false,
        },
      },
      mock: fixtures.mockFor('redis'),
    },
    ColumnFilterPopover: {
      props: { anchor: { x: 40, y: 80 }, top: [{ value: 'shipped', count: 12 }, { value: 'pending', count: 7 }] },
    },
    'replay-LineChart': {
      props: {
        timestamps: ['2026-10-01 10:00:00', '2026-10-01 10:00:01', '2026-10-01 10:00:02'],
        series: { 'rows/s': [1, 4, 2], 'locks': [0, 1, 0] },
        currentTs: '2026-10-01 10:00:02',
      },
    },
    'replay-ReplayChooser': {
      props: { probe: { is_recording: true, metadata: null, snapshot_count: 0, first_timestamp: null, last_timestamp: null } },
    },
    ErNode: {
      props: { table: { name: 'orders', columns: [{ name: 'id', type: 'bigint', pk: true, fk: false, unique: true }] } },
    },
    TableDesigner: { props: { table: undefined } },
    VirtualFkModal: { props: { table: 'shop.orders' } },
    SqlEditor: {
      props: {
        flavor: 'mysql', initialValue: 'SELECT * FROM orders', initialHistory: [],
        minimap: false, schemaCompletions: [],
        getColumns: () => [], getFks: () => [], getSchemaTables: () => [],
        getServerVariables: () => ({}), getRoutineSignature: () => null,
        explainNowRef: { current: null }, runNowRef: { current: null },
        runBareNowRef: { current: null }, killReplaceRef: { current: null },
        tabId: 't1', active: true, showInvisibles: false, zoom: 1,
        diagContext: null, statementRuns: [], duckdbSpatial: false,
      },
    },
    GaleraClusterPanel: {
      mock: { galera_cluster_status: fixtures.galeraFixture?.() ?? null },
    },
  };
}

export function sweepTargets(fixturesByName = {}) {
  const dir = path.join(ROOT, 'src', 'components');
  const names = fs.readdirSync(dir)
    .filter(f => /\.tsx$/.test(f) && !NON_PANEL.has(f))
    .map(f => f.replace(/\.tsx$/, ''));
  // replay/ subdirectory components; panels.tsx there is a barrel, not a panel
  const replayDir = path.join(dir, 'replay');
  if (fs.existsSync(replayDir)) {
    for (const f of fs.readdirSync(replayDir)) {
      if (/\.tsx$/.test(f) && f !== 'panels.tsx') names.push(`replay/${f.replace(/\.tsx$/, '')}`);
    }
  }
  return names.sort().map(name => {
    // Mount tier by default: the render body AND its effects (invoke calls,
    // observers, timers) all run. ssr-only where a target opts out.
    const base = { name: name.replace(/\//g, '-'), file: `src/components/${name}.tsx`, tier: 'mount' };
    const extra = fixturesByName[base.name];
    return extra ? { ...base, ...extra } : base;
  });
}

export { CANNOT };
