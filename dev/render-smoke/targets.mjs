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
import { createHash } from 'node:crypto';
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
    ...[
      { name: 'App_migration_handoff', production: false, tampered: false },
      { name: 'App_migration_prod_handoff', production: true, tampered: false },
      { name: 'App_migration_handoff_tampered', production: false, tampered: true },
    ].map(testCase => ({
      name: testCase.name, file: 'src/App.tsx', tier: 'mount', settleMs: 60,
      mock: {
        vault_status: VAULT_UNLOCKED,
        list_connections: [{
          id: 'c-target', name: 'target shop', engine: 'mysql',
          environment: testCase.production ? 'prod' : 'dev', read_only: false,
          color: null, auto_connect: false, tags: [], labels: [],
        }],
        open_connection: () => 's-target',
        set_session_db: null,
        migration_scratch_list: [],
        list_schema: [],
        get_app_version: '0.0.0-smoke',
        monitor_query: ({ sql }) => String(sql).includes('DATABASE()')
          ? fixtures.queryResult(['DATABASE()'], [['shop']]) : fixtures.queryResult([], []),
      },
      interact: async ({ container, act, shim }) => {
        await act(async () => {
          shim.window.dispatchEvent(new shim.window.CustomEvent('dbgui:open-migration', { detail: {
            version: 1, engine: 'mysql', database: 'shop',
            sql: 'ALTER TABLE orders ADD COLUMN note varchar(40);', origin: 'schema-compare',
            targetConnectionId: 'c-target', ...(testCase.tampered ? { phase: 'done', rehearsalProof: {} } : {}),
          } }));
          await new Promise(resolve => setTimeout(resolve, 100));
        });
        if (testCase.production || testCase.tampered) {
          container.__handoffDialogText = shim.document.body.textContent;
          const buttons = [];
          const walk = node => {
            if (node.nodeName === 'BUTTON' && node.textContent === 'OK') buttons.push(node);
            for (const child of node.childNodes ?? []) walk(child);
          };
          walk(shim.document.body);
          await act(async () => { buttons[0]?.dispatchEvent(new shim.window.Event('click', { bubbles: true })); });
        }
      },
      assert: ({ container, html, calls }) => {
        const opened = calls.some(call => call.cmd === 'open_connection' && call.args.id === 'c-target');
        const dialogText = container.__handoffDialogText ?? '';
        if (testCase.production) {
          if (opened) return 'unacknowledged production target was opened by a handoff';
          if (!dialogText.includes('Open and acknowledge the production target')) return 'production handoff refusal was not explained';
          return;
        }
        if (testCase.tampered) {
          if (opened) return 'tampered handoff opened its target';
          if (!dialogText.includes('unexpected fields')) return 'tampered proof fields were not rejected visibly';
          return;
        }
        if (!opened) return 'exact non-production target was not opened';
        if (!calls.some(call => call.cmd === 'set_session_db' && call.args.db === 'shop')) return 'handoff database was not selected';
        const editors = [];
        const walk = node => {
          if (node.nodeName === 'TEXTAREA') editors.push(node);
          for (const child of node.childNodes ?? []) walk(child);
        };
        walk(container);
        if (!editors.some(editor => String(editor.value ?? '').includes('ALTER TABLE orders ADD COLUMN note varchar(40);'))) return 'handoff SQL did not reach Migration Cockpit';
        if (!html.includes('Phase: draft')) return 'handoff bypassed the initial unreviewed draft';
        if (calls.some(call => call.cmd === 'migration_preflight')) return 'handoff ran review/preflight without a user action';
      },
    })),
    {
      name: 'EnvironmentRefreshPanel_spec_journey', file: 'src/components/EnvironmentRefreshPanel.tsx', tier: 'mount', settleMs: 30,
      mock: {
        open: () => '/mock/imported-refresh.json',
        save: () => '/mock/exported-refresh.json',
        refresh_spec_load: () => JSON.stringify({
          version: 1, engine: 'mysql',
          source: { connectionId: 'c-source', sessionId: 'old-source' },
          target: { connectionId: 'c-target', sessionId: 'old-target' },
          schemaMappings: [{ source: 'shop', target: 'shop' }], seed: 'imported-seed', allowFkBreaking: false,
          tables: [
            { table: 'countries', policy: 'full' },
            { table: 'orders', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 7, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
            { table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling', amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: '2026-11-06T12:00:00.000Z' },
          ],
          masks: [{ table: 'customers', column: 'email', rule: 'hash' }],
          limits: { maxRowsPerChunk: 50000, maxBytesPerChunk: 67108864, planningKeyBatch: 10000, maxPlanningKeys: 1000000 },
          verification: { exactCounts: true, foreignKeyOrphans: true, contentSha256: true },
        }),
        refresh_spec_save: null,
      },
      props: {
        session: { connectionId: 'c-source', sessionId: 's-source', connectionName: 'source fixture', engine: 'mysql', environment: 'dev', readOnly: true },
        openSessions: [
          { connectionId: 'c-source', sessionId: 's-source', connectionName: 'source fixture', engine: 'mysql', environment: 'dev', readOnly: true },
          { connectionId: 'c-target', sessionId: 's-target', connectionName: 'target fixture', engine: 'mysql', environment: 'dev', readOnly: false },
        ],
        onClose: () => {},
      },
      interact: async ({ container, act }) => {
        const click = async (text, waitMs = 20) => {
          const buttons = [];
          const walk = node => {
            if (node.nodeName === 'BUTTON' && node.textContent.includes(text)) buttons.push(node);
            for (const child of node.childNodes ?? []) walk(child);
          };
          walk(container);
          await act(async () => {
            buttons[0]?.dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, waitMs));
          });
        };
        await click('Import JSON', 80);
        container.__afterImport = container.textContent;
        const selects = [];
        const walk = node => {
          if (node.nodeName === 'SELECT') selects.push(node);
          for (const child of node.childNodes ?? []) walk(child);
        };
        walk(container);
        for (const [select, value] of [[selects[0], 's-source'], [selects[1], 's-target']]) {
          await act(async () => {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 10));
          });
        }
        await click('Reconfirm source and target');
        await click('Export JSON');
        await click('Export report .md');
      },
      assert: ({ html, calls, container }) => {
        if (!calls.some(call => call.cmd === 'refresh_spec_load')) return 'specification was not loaded';
        if (!calls.some(call => call.cmd === 'refresh_spec_save')) return 'specification was not saved atomically';
        if (!html.includes('Endpoints reconfirmed')) return 'endpoint reconfirmation was not visible';
        const saved = calls.find(call => call.cmd === 'refresh_spec_save');
        for (const needle of ['"sessionId": "s-source"', '"sessionId": "s-target"', '"seed": "imported-seed"']) {
          if (!saved.args.contents.includes(needle)) return `exported specification lacks ${needle}: ${container.__afterImport}`;
        }
        for (const forbidden of ['confirmed', 'password', 'connectionUrl', 'queryResult', 'private-row']) {
          if (saved.args.contents.includes(forbidden)) return `exported specification contains ${forbidden}`;
        }
        const report = calls.find(call => call.cmd === 'write_text_file');
        if (!report) return 'Refresh Markdown report was not written';
        if (!report.args.contents.includes('# Safe Environment Refresh report') || !report.args.contents.includes('Specification SHA-256')) return 'Refresh report lacks its identity';
        if (report.args.contents.includes('imported-seed') || report.args.contents.includes('private-row')) return 'Refresh report leaked a seed or row value';
        if (!report.args.contents.includes('Refresh execution has not run')) return 'pre-execution report did not lead with incomplete evidence';
        if (!html.includes('Read-only plan preview')) return 'compiled plan preview is missing';
        if (!html.includes('SELECT * FROM `shop`.`countries`')) return 'full-table plan SQL is missing';
        if (!html.includes('3 reads · 0 generate · 0 excluded · 0 blockers')) return 'plan action counts are missing or wrong';
        if (calls.some(call => call.cmd === 'monitor_query')) return 'specification editing unexpectedly queried a database';
      },
    },
    {
      name: 'QueryTabs_refresh_generate_handoff', file: 'src/components/QueryTabs.tsx', tier: 'mount', settleMs: 50,
      props: {
        session: { connectionId: 'c-target', sessionId: 's-target', connectionName: 'target fixture', engine: 'mysql', environment: 'dev', readOnly: false },
        openSessions: [{ connectionId: 'c-target', sessionId: 's-target', connectionName: 'target fixture', engine: 'mysql', environment: 'dev', readOnly: false }],
        isActive: true, externalMigrationHandoff: null,
      },
      interact: async ({ container, act }) => {
        const handoff = {
          version: 1, origin: 'environment-refresh', targetSessionId: 's-target', targetConnectionId: 'c-target',
          specSha256: 'a'.repeat(64),
          generate: {
            table: 'stage.customers', rowCount: 25, seed: 42, locale: 'default', useCopy: false, createDdl: null,
            specs: [
              { name: 'id', typeName: 'int', generator: 'sequence', unique: true, params: {} },
              { name: 'email', typeName: 'varchar(64)', generator: 'fullName', params: {} },
            ],
          },
        };
        await act(async () => {
          window.dispatchEvent(new CustomEvent('dbgui:generate-instead', { detail: { ...handoff, targetSessionId: 's-other' } }));
          window.dispatchEvent(new CustomEvent('dbgui:generate-instead', { detail: { ...handoff, autoRun: true } }));
          await new Promise(resolve => setTimeout(resolve, 50));
        });
        container.__beforeValidHandoff = container.textContent;
        await act(async () => {
          window.dispatchEvent(new CustomEvent('dbgui:generate-instead', { detail: handoff }));
          await new Promise(resolve => setTimeout(resolve, 300));
        });
      },
      assert: ({ html, calls, container }) => {
        if (container.__beforeValidHandoff.includes('Environment Refresh handoff')) return 'wrong-session or tampered handoff populated datagen';
        if (!html.includes('Environment Refresh handoff') || !html.includes('25 rows')) return 'valid handoff did not populate datagen';
        if (!html.includes('nothing has generated or inserted')) return 'handoff does not explain its review-only state';
        if (calls.some(call => ['generate_data', 'generate_database', 'preview_datagen'].includes(call.cmd))) return 'handoff generated data without a user action';
      },
    },
    {
      name: 'QueryLabPanel_spec_journey', file: 'src/components/QueryLabPanel.tsx', tier: 'mount', settleMs: 30,
      mock: {
        query_lab_baseline: args => ({
          run_key: args.input.run_key, spec_sha256: args.input.spec_sha256,
          execution_mode: args.input.execution_mode, database: 'shop', engine: 'postgres', version: '18.0',
          backend_id: 42, timeout_ms: args.input.timeout_ms, cost_estimates: true,
          index_evidence_mode: args.input.index_evidence_mode,
          comparison_policy: args.input.index_evidence_mode === 'hypothetical'
            ? 'Hypothetical index: plan/cost evidence only; measured runtime comparison is forbidden'
            : args.input.index_evidence_mode === 'real'
              ? 'Real index on scratch: measured runtime evidence is permitted'
              : 'No index candidate: query plan evidence only',
          estimated_plan: { label: 'estimated', format: 'json', content: '{"query_block":{"select_id":1}}', elapsed_ms: 1 },
          measured_plan: args.input.execution_mode === 'measured'
            ? { label: 'executed_query', format: 'text', content: '-> Covering index scan on orders (actual time=0.01 rows=1 loops=1)', elapsed_ms: 2 }
            : null,
          settings: [{ name: 'cleanup', value: 'timeout restored and dedicated connection closed' }],
          cache_observations: ['No complete cache control or cold/warm-cache claim is made'],
          cleanup: { timeout_restored: true, connection_closed: true },
        }),
        query_lab_hypopg_estimate: args => ({
          run_key: args.input.run_key, spec_sha256: args.input.spec_sha256,
          candidate_id: args.input.candidate.id, backend_id: 43,
          baseline_plan: { label: 'estimated', format: 'json', content: '{"Plan":{"Total Cost":100}}', elapsed_ms: 1 },
          candidate_plan: { label: 'hypothetical', format: 'json', content: '{"Plan":{"Total Cost":75}}', elapsed_ms: 1 },
          created_index_names: ['<13342>btree_orders_customer_id'], used_index_names: ['<13342>btree_orders_customer_id'],
          baseline_cost: 100, candidate_cost: 75, absolute_delta: -25, percent_delta: -25,
          index_used: true, verdict: 'lower_estimated_cost',
          comparison_policy: 'Hypothetical index: plan/cost evidence only; measured runtime comparison is forbidden',
          cleanup: { timeout_restored: true, connection_closed: true, hypopg_reset: true },
        }),
        migration_scratch_list: () => [{
          run_key: '01234567-89ab-cdef-8123-456789abcdef', session_id: 's-lab', connection_id: 'c-lab',
          engine: 'postgres', name: 'txui_mig_0123456789abcdef', status: 'active', error: null,
          created_at: '2026-11-08 00:00:00', updated_at: '2026-11-08 00:00:00',
        }],
        query_lab_real_index_measure: args => ({
          run_key: args.input.baseline.run_key, spec_sha256: args.input.baseline.spec_sha256,
          candidate_id: args.input.candidate.id, scratch_run_key: args.input.baseline.scratch.run_key,
          scratch_database: args.input.baseline.scratch.database, backend_id: 44,
          index_name: 'txui_lab_0123456789abcdef', index_build_ms: 17,
          baseline_plan: { label: 'executed_query', format: 'json', content: '{"Plan":{"Total Cost":100}}', elapsed_ms: 4 },
          candidate_plan: { label: 'executed_query', format: 'json', content: '{"Plan":{"Index Name":"txui_lab_0123456789abcdef"}}', elapsed_ms: 2 },
          index_used: true,
          comparison_policy: 'Real index on Migration scratch: both plans executed the read-only query once; create wall time includes lock wait and rebuild and is not a runtime verdict',
          cleanup: { index_dropped: true, scratch_dropped: true, timeout_restored: true, connection_closed: true },
        }),
        query_lab_rewrite_measure: args => ({
          run_key: args.input.baseline.run_key, spec_sha256: args.input.baseline.spec_sha256,
          candidate_id: args.input.candidate.id, backend_id: 45,
          correctness: 'equal', reason: null,
          row_order_policy: args.input.row_order_policy, max_rows: args.input.max_rows, max_bytes: args.input.max_bytes,
          baseline: {
            columns: [{ name: 'id', type_name: 'INT8' }], rows_observed: 2, bytes_observed: 24,
            sha256: 'a'.repeat(64), complete: true, unverified_reason: null,
          },
          candidate: {
            columns: [{ name: 'id', type_name: 'INT8' }], rows_observed: 2, bytes_observed: 24,
            sha256: 'a'.repeat(64), complete: true, unverified_reason: null,
          },
          cleanup: { timeout_restored: true, connection_closed: true },
        }),
        query_lab_benchmark: args => {
          const pairs = Array.from({ length: args.input.repetitions }, (_, index) => ({
            repetition: index + 1, order: index % 2 === 0 ? 'baseline_first' : 'candidate_first',
            baseline_ms: 10 + index, candidate_ms: 8 + index,
          }));
          return {
            run_key: args.input.rewrite.baseline.run_key, spec_sha256: args.input.rewrite.baseline.spec_sha256,
            candidate_id: args.input.rewrite.candidate.id, backend_id: 46,
            warmup_runs: args.input.warmup_runs, repetitions: args.input.repetitions,
            pairs,
            baseline_ms: pairs.map(pair => pair.baseline_ms), candidate_ms: pairs.map(pair => pair.candidate_ms),
            baseline: { count: pairs.length, min_ms: 10, median_ms: 13, p95_ms: 16, max_ms: 16 },
            candidate: { count: pairs.length, min_ms: 8, median_ms: 11, p95_ms: 14, max_ms: 14 },
            baseline_sha256: 'a'.repeat(64), candidate_sha256: 'a'.repeat(64),
            cleanup: { timeout_restored: true, connection_closed: true },
          };
        },
      },
      props: {
        session: { connectionId: 'c-lab', sessionId: 's-lab', connectionName: 'lab fixture', engine: 'postgres', environment: 'dev', readOnly: false },
        schema: 'shop', onClose: () => {},
      },
      interact: async ({ container, act }) => {
        const selects = [];
        const findMode = node => {
          if (node.nodeName === 'SELECT') selects.push(node);
          for (const child of node.childNodes ?? []) findMode(child);
        };
        findMode(container);
        const mode = selects[2];
        if (!mode) throw new Error('Experiment mode select not found');
        const click = async (label = 'Validate experiment') => {
          const buttons = [];
          const walk = node => {
            if (node.nodeName === 'BUTTON' && node.textContent.includes(label)) buttons.push(node);
            for (const child of node.childNodes ?? []) walk(child);
          };
          walk(container);
          if (!buttons[0]) throw new Error(`${label} button not found`);
          await act(async () => {
            buttons[0].dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 20));
          });
        };
        await act(async () => {
          mode.value = 'measured';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        await click();
        container.__modeErrors = container.textContent;
        await act(async () => {
          mode.value = 'estimate';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        await click();
        await click('Capture baseline');
        container.__estimatedBaseline = container.textContent;
        await act(async () => {
          mode.value = 'measured';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        for (const label of ['Measured timing', 'Result equality']) {
          const walk = node => {
            if (node.nodeName === 'LABEL' && node.textContent.includes(label)) {
              const input = [...(node.childNodes ?? [])].find(child => child.nodeName === 'INPUT');
              if (input) {
                input.checked = true;
                input.dispatchEvent(new Event('click', { bubbles: true }));
              }
            }
            for (const child of node.childNodes ?? []) walk(child);
          };
          await act(async () => { walk(container); });
        }
        await click();
        await click('Capture baseline');
        container.__measuredBaseline = container.textContent;
        await act(async () => {
          mode.value = 'estimate';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        for (const label of ['Measured timing', 'Result equality']) {
          const walk = node => {
            if (node.nodeName === 'LABEL' && node.textContent.includes(label)) {
              const input = [...(node.childNodes ?? [])].find(child => child.nodeName === 'INPUT');
              if (input) {
                input.checked = false;
                input.dispatchEvent(new Event('click', { bubbles: true }));
              }
            }
            for (const child of node.childNodes ?? []) walk(child);
          };
          await act(async () => { walk(container); });
        }
        await click();
        await click('Estimate index (HypoPG)');
        container.__hypopgResult = container.textContent;
        await act(async () => {
          mode.value = 'measured';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        for (const label of ['Measured timing', 'Result equality']) {
          const walk = node => {
            if (node.nodeName === 'LABEL' && node.textContent.includes(label)) {
              const input = [...(node.childNodes ?? [])].find(child => child.nodeName === 'INPUT');
              if (input) {
                input.checked = true;
                input.dispatchEvent(new Event('click', { bubbles: true }));
              }
            }
            for (const child of node.childNodes ?? []) walk(child);
          };
          await act(async () => { walk(container); });
        }
        let migrationScratch;
        const findScratch = node => {
          if (node.nodeName === 'SELECT' && node.getAttribute('aria-label') === 'Migration scratch') migrationScratch = node;
          for (const child of node.childNodes ?? []) findScratch(child);
        };
        findScratch(container);
        if (!migrationScratch) throw new Error('Migration scratch selector not found');
        await act(async () => {
          migrationScratch.value = '01234567-89ab-cdef-8123-456789abcdef';
          migrationScratch.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        await click();
        await click('Build & measure real index');
        container.__realIndexResult = container.textContent;
        let candidateKind;
        const findCandidateKind = node => {
          if (node.nodeName === 'SELECT' && node.getAttribute('aria-label') === 'Candidate 1 kind') candidateKind = node;
          for (const child of node.childNodes ?? []) findCandidateKind(child);
        };
        findCandidateKind(container);
        if (!candidateKind) throw new Error('Candidate kind selector not found');
        await act(async () => {
          candidateKind.value = 'rewrite';
          candidateKind.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        await click();
        await click('Check rewrite results');
        container.__rewriteResult = container.textContent;
        await click('Benchmark rewrite');
      },
      assert: ({ html, calls, container }) => {
        if (!container.__modeErrors.includes('no database invocation is possible') || !container.__modeErrors.includes('requires timing evidence')) return 'measured mode did not produce its evidence blocker';
        if (!container.__estimatedBaseline.includes('Estimated plan') || !container.__estimatedBaseline.includes('query_block')) return 'estimated baseline was not rendered';
        if (!html.includes('Validated without a database call')) return 'valid experiment did not produce local proof';
        if (!html.includes('customer_id = 1')) return 'concrete parameter did not resolve';
        if (!container.__measuredBaseline.includes('EXECUTED QUERY') || !container.__measuredBaseline.includes('actually executed the read-only statement')) return 'measured plan was not labelled as execution';
        if (!html.includes('timeout restored') || !html.includes('dedicated connection closed')) return 'baseline cleanup was not rendered';
        if (!container.__hypopgResult.includes('Hypothetical index: plan/cost evidence only; measured runtime comparison is forbidden')) return 'index comparison policy was not rendered';
        if (!container.__hypopgResult.includes('lower_estimated_cost') || !container.__hypopgResult.includes('HypoPG reset complete')) return 'HypoPG verdict or reset was not rendered';
        if (!container.__realIndexResult.includes('Real index on Migration scratch') || !container.__realIndexResult.includes('Create wall time: 17 ms')) return 'real-index evidence was not rendered';
        if (!container.__realIndexResult.includes('EXECUTED BASELINE') || !container.__realIndexResult.includes('EXECUTED CANDIDATE')) return 'real-index plans were not labelled as execution';
        if (!container.__realIndexResult.includes('candidate index dropped') || !container.__realIndexResult.includes('Migration scratch dropped') || !container.__realIndexResult.includes('Candidate index used: yes')) return 'real-index usage or cleanup was not rendered';
        if (!container.__realIndexResult.includes('Verdict: inconclusive') || !container.__realIndexResult.includes('At least three matched baseline/candidate pairs')) return 'one-shot real-index result was not kept inconclusive';
        const realIndex = calls.find(call => call.cmd === 'query_lab_real_index_measure');
        if (!realIndex) return 'real-index candidate was not invoked';
        if (realIndex.args.input.baseline.index_evidence_mode !== 'real' || realIndex.args.input.baseline.execution_mode !== 'measured') return 'real-index evidence contract was not preserved';
        if (realIndex.args.input.baseline.scratch.run_key !== '01234567-89ab-cdef-8123-456789abcdef' || realIndex.args.input.baseline.scratch.database !== 'txui_mig_0123456789abcdef') return 'Migration scratch identity was not preserved';
        if (!container.__rewriteResult.includes('Rewrite correctness') || !container.__rewriteResult.includes('equal') || !container.__rewriteResult.includes('complete canonical hash') || !container.__rewriteResult.includes('2 observed rows')) return 'rewrite correctness evidence was not rendered';
        const rewrite = calls.find(call => call.cmd === 'query_lab_rewrite_measure');
        if (!rewrite) return 'rewrite candidate was not invoked';
        if (rewrite.args.input.baseline.index_evidence_mode !== 'none' || !rewrite.args.input.baseline.has_rewrite_candidate || !rewrite.args.input.baseline.evidence.result_equality) return 'rewrite evidence contract was not preserved';
        if (rewrite.args.input.row_order_policy !== 'ordered' || rewrite.args.input.max_rows !== 100000 || rewrite.args.input.max_bytes !== 67108864) return 'rewrite policy or budgets were not preserved';
        if (!rewrite.args.input.candidate.sql.includes('customer_id = 1')) return 'rewrite parameters were not resolved';
        if (!html.includes('1 warmup + 7 repetitions') || !html.includes('Raw timings: [10, 11, 12, 13, 14, 15, 16] ms') || !html.includes('Repetition 7 · baseline_first · baseline 16 ms · candidate 14 ms')) return 'benchmark raw evidence was not rendered';
        if (!html.includes('Verdict: <b>improved</b>') || !html.includes('baseline-on-baseline noise 1 ms') || !html.includes('configured threshold 0.65 ms')) return 'noise-aware benchmark verdict was not rendered';
        const benchmark = calls.find(call => call.cmd === 'query_lab_benchmark');
        if (!benchmark) return 'benchmark was not invoked';
        if (benchmark.args.input.warmup_runs !== 1 || benchmark.args.input.repetitions !== 7) return 'benchmark schedule was not preserved';
        if (benchmark.args.input.rewrite.candidate.sql !== rewrite.args.input.candidate.sql || benchmark.args.input.rewrite.row_order_policy !== 'ordered') return 'benchmark rewrite contract was not preserved';
        const hypopg = calls.find(call => call.cmd === 'query_lab_hypopg_estimate');
        if (!hypopg) return 'HypoPG candidate was not invoked';
        if (hypopg.args.input.index_evidence_mode !== 'hypothetical') return 'HypoPG was invoked with incompatible evidence';
        if (hypopg.args.input.candidate.columns.join(',') !== 'customer_id') return 'HypoPG candidate columns were not preserved';
        const baselines = calls.filter(call => call.cmd === 'query_lab_baseline');
        if (baselines.length !== 2) return `expected two guarded baseline calls, got ${baselines.length}`;
        if (baselines[0].args.input.execution_mode !== 'estimate' || baselines[1].args.input.execution_mode !== 'measured') return 'baseline modes were not preserved';
        if (baselines[0].args.input.index_evidence_mode !== 'hypothetical' || baselines[1].args.input.index_evidence_mode !== 'real') return 'index evidence did not follow the execution modes';
        if (calls.some(call => call.cmd === 'monitor_query')) return 'Query Lab bypassed the guarded baseline command';
      },
    },
    ...[
      { name: 'EnvironmentRefreshPanel_catalog_journey', missingTarget: false },
      { name: 'EnvironmentRefreshPanel_catalog_blocked', missingTarget: true },
      { name: 'EnvironmentRefreshPanel_rust_mask_journey', rustMask: true },
      { name: 'EnvironmentRefreshPanel_activity_survives_close', rustMask: true, activity: true },
    ].map(testCase => ({
      name: testCase.name, file: testCase.activity ? 'dev/refresh_activity_smoke.tsx' : 'src/components/EnvironmentRefreshPanel.tsx', tier: 'mount', settleMs: 30,
      mock: {
        monitor_query: ({ sessionId, sql }) => {
          const target = sessionId === 's-target';
          const names = [...(testCase.rustMask ? ['customers'] : []), 'countries', 'orders', 'events'].filter(name => !(target && testCase.missingTarget && name === 'events'));
          if (sql.includes('information_schema.SCHEMATA')) return fixtures.queryResult(
            ['server_charset', 'server_collation', 'server_version', 'schema_charset', 'schema_collation'],
            [['utf8mb4', 'utf8mb4_0900_ai_ci', '8.4.0', 'utf8mb4', 'utf8mb4_0900_ai_ci']]);
          if (sql.includes('mysql.innodb_table_stats')) return fixtures.queryResult(
            ['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'],
            names.map(name => [name, 0, 0, 0, null]));
          if (sql.includes('information_schema.TABLES')) return fixtures.queryResult(
            ['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT'],
            names.map(name => [name, 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']));
          if (sql.includes('information_schema.COLUMNS')) {
            const rows = [];
            for (const name of names) {
              rows.push([name, 'id', 'int', 'int', 'NO', null, '', null, null, null, null, '']);
              if (name !== 'countries') rows.push([name, 'created_at', 'datetime', 'datetime', 'NO', null, '', null, null, null, null, '']);
              if (name === 'customers') rows.push([name, 'email', 'varchar', 'varchar(64)', 'NO', null, '', 'utf8mb4', 'utf8mb4_0900_ai_ci', 64, null, '']);
            }
            return fixtures.queryResult(
              ['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'GENERATION_EXPRESSION', 'COLUMN_COMMENT'], rows);
          }
          if (sql.includes('information_schema.STATISTICS')) return fixtures.queryResult(
            ['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE'],
            names.flatMap(name => [
              [name, 'PRIMARY', 0, 1, 'id', null, 0, 'BTREE'],
              ...(name === 'customers' ? [[name, 'uq_email', 0, 1, 'email', null, 0, 'BTREE']] : []),
            ]));
          if (sql.includes('KEY_COLUMN_USAGE')) return fixtures.queryResult(
            ['CONSTRAINT_NAME', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE'], []);
          if (sql.startsWith('SELECT `id`') && sql.includes('FROM `shop`.')) return fixtures.queryResult(['id'], []);
          throw new Error(`unexpected Refresh query: ${sql}`);
        },
        refresh_mask_apply: () => ({ rows: [], accepted_rows: 0, masked_cells: 0, unique_keys: 0, elapsed_ms: 1 }),
        refresh_preflight: () => ({ ok: true, preflight_sha256: 'preflight-smoke', tables: [
          { source_schema: 'shop', target_schema: 'shop', table: 'countries', empty: true },
          { source_schema: 'shop', target_schema: 'shop', table: 'orders', empty: true },
          { source_schema: 'shop', target_schema: 'shop', table: 'events', empty: true },
        ] }),
        refresh_execute: args => {
          const runKey = args.input.run_key;
          args.onEvent.onmessage?.({ type: 'started', run_key: runKey, source_backend_id: 41, target_backend_id: 42 });
          args.onEvent.onmessage?.({
            type: 'chunk', run_key: runKey, table: 'shop.events', table_index: 3, table_count: 3,
            chunk_index: 1, outcome: 'committed', rows: 0,
            requested_rows: 0, closure_rows: 0, planned_rows: 0, committed_rows: 0,
            rows_inserted: 0, in_flight_rows: 0, remaining_rows: 0, chunks_committed: 1,
            rows_per_second: 0, eta_seconds: 0, elapsed_ms: 2,
            current_key_range: { start_sha256: 'a'.repeat(64), end_sha256: 'b'.repeat(64) },
          });
          if (testCase.activity) return new Promise(() => {});
          args.onEvent.onmessage?.({
            type: 'done', run_key: runKey, status: 'completed', table_index: 3, table_count: 3,
            requested_rows: 0, closure_rows: 0, planned_rows: 0, committed_rows: 0,
            rows_inserted: 0, in_flight_rows: 0, remaining_rows: 0, chunks_committed: 1,
            rows_per_second: 0, eta_seconds: 0, elapsed_ms: 2,
            current_key_range: { start_sha256: 'a'.repeat(64), end_sha256: 'b'.repeat(64) },
          });
          return { status: 'completed', committed_rows: 0, in_flight_rows: 0, remaining_rows: 0 };
        },
        refresh_cancel: () => null,
      },
      props: {
        session: { connectionId: 'c-source', sessionId: 's-source', connectionName: 'source fixture', engine: 'mysql', environment: 'dev', readOnly: true },
        openSessions: [
          { connectionId: 'c-source', sessionId: 's-source', connectionName: 'source fixture', engine: 'mysql', environment: 'dev', readOnly: true },
          { connectionId: 'c-target', sessionId: 's-target', connectionName: 'target fixture', engine: 'mysql', environment: 'dev', readOnly: false },
        ],
        onClose: () => {},
      },
      interact: async ({ container, act }) => {
        const click = async text => {
          const buttons = [];
          const walk = node => {
            if (node.nodeName === 'BUTTON' && node.textContent.includes(text)) buttons.push(node);
            for (const child of node.childNodes ?? []) walk(child);
          };
          walk(container);
          if (!buttons[0]) throw new Error(`button not found: ${text}`);
          await act(async () => {
            buttons[0].dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 20));
          });
        };
        await click('Reconfirm source and target');
        await click('Analyze catalogs');
        if (!testCase.missingTarget) await click('Plan row sets');
        if (testCase.rustMask) {
          await click('Verify Rust masking');
          await click('Check target empty');
          await click('Run Refresh');
          if (testCase.activity) {
            await click('×');
            await click('Cancel hidden work');
          }
        }
      },
      assert: ({ html, calls }) => {
        const queries = calls.filter(call => call.cmd === 'monitor_query');
        const expectedQueries = testCase.missingTarget ? 12 : testCase.rustMask ? 18 : 15;
        if (queries.length !== expectedQueries) return `expected ${expectedQueries} catalog/key reads, got ${queries.length}`;
        if (queries.slice(0, 12).some(call => !/information_schema|innodb_table_stats/.test(call.args.sql))) return 'catalog analysis read application rows';
        if (testCase.activity) {
          const executeCall = calls.find(call => call.cmd === 'refresh_execute');
          if (!executeCall) return 'Refresh executor was not invoked before close';
          if (!html.includes('refresh-execute') || !html.includes('Environment refresh · copying')) return 'closing the panel hid its running activity';
          if (!html.includes('committed') || !html.includes('rows/s')) return 'surviving activity lost its progress detail';
          if (!calls.some(call => call.cmd === 'refresh_cancel')) return 'surviving activity could not cancel the hidden run';
          if (html.includes('No running Refresh activity')) return 'running activity was cleared on unmount';
          if (JSON.stringify(executeCall.args).includes('private-row')) return 'activity payload contains a planted row value';
          return undefined;
        }
        if (testCase.missingTarget) {
          if (!html.includes('Catalog compatibility is blocked')) return 'missing target did not block analysis';
          if (!html.includes('target table shop.events does not exist')) return 'missing target table was not named';
          if (html.includes('Catalog compatibility proven')) return 'missing target produced a success badge';
        } else {
          if (!html.includes('Catalog compatibility proven')) return 'clean catalogs did not produce compatibility proof';
          const tableCount = testCase.rustMask ? 4 : 3;
          if (!html.includes(`${tableCount} source tables · ${tableCount} target tables · 0 FKs`)) return 'catalog counts are missing or wrong';
          if (!html.includes('Requested 0 + closure 0 = final 0')) return 'row-set totals were not rendered';
          if (!html.includes('Fixed-point row-set plan complete')) return 'fixed-point proof was not rendered';
          if (!html.includes('Execution plan is deterministic and schema-bound')) return 'deterministic execution proof was not rendered';
          const order = '1. shop.countries · 2. shop.events · 3. shop.orders';
          if (!html.includes(`Insertion order: ${order}`)) return 'parent/insertion order was not rendered';
          if (!html.includes('full-root keys retained 0')) return 'memory counters were not rendered';
          if (!testCase.rustMask) {
            if (!html.includes('Mask contract blocked: 1 blockers')) return 'missing mask column was not reported';
            if (!html.includes('shop.customers.email has no source catalog column')) return 'mask blocker did not name the missing column';
            if (!html.includes('Mask safety blocked: 1 blockers')) return 'mask safety blockers were not rendered';
          }
          if (!html.includes('Acknowledge listed unmasked sensitive columns')) return 'sensitive acknowledgment control is missing';
          if (testCase.rustMask) {
            const rustCall = calls.find(call => call.cmd === 'refresh_mask_apply');
            if (!rustCall) return 'Rust mask command was not invoked';
            if (!html.includes('Rust masking verified: 0 accepted rows')) return 'Rust count-only result was not rendered';
            if (!html.includes('Mask safety valid: 1 unique indexes require runtime checks')) return 'valid unique-email mask safety was not rendered';
            if (JSON.stringify(rustCall.args).includes('private-row')) return 'Rust payload contains a planted row value';
            if (!calls.some(call => call.cmd === 'refresh_preflight')) return 'target preflight was not invoked';
            if (!html.includes('Target preflight passed: 3 selected tables are empty')) return 'target-empty result was not rendered';
            const executeCall = calls.find(call => call.cmd === 'refresh_execute');
            if (!executeCall) return 'Refresh executor was not invoked after preflight';
            if (JSON.stringify(executeCall.args).includes('private-row')) return 'execution payload contains a planted row value';
            if (testCase.activity) {
              if (!html.includes('refresh-execute') || !html.includes('Environment refresh · copying')) return 'closing the panel hid its running activity';
              if (!html.includes('committed') || !html.includes('rows/s')) return 'surviving activity lost its progress detail';
              if (!calls.some(call => call.cmd === 'refresh_cancel')) return 'surviving activity could not cancel the hidden run';
              if (html.includes('No running Refresh activity')) return 'running activity was cleared on unmount';
            } else {
              if (!html.includes('Snapshot execution · completed')) return 'terminal execution progress was not rendered';
              if (!html.includes('0 committed') || !html.includes('0 in flight') || !html.includes('0 remaining')) return 'honest execution counters were not rendered';
              if (!html.includes('target backend 42')) return 'target backend identity was not rendered';
              if (!html.includes('Chunk 1 · committed')) return 'per-chunk outcome was not rendered';
              if (!html.includes('committed rows/s')) return 'measured throughput was not rendered';
              if (!html.includes('Current hashed key range')) return 'safe key-range evidence was not rendered';
              if (!html.includes('inserted including uncommitted')) return 'inserted/committed distinction was not rendered';
            }
          }
          if (queries.slice(12).some(call => call.args.sessionId !== 's-source' || !call.args.sql.startsWith('SELECT `id`'))) return 'row-set planning did not use source key-only queries';
        }
      },
    })),
    ...[
      { name: 'MigrationPanel', file: 'src/components/MigrationPanel.tsx', supported: ['mysql', 'postgres'], readyText: 'Review migration' },
      { name: 'EnvironmentRefreshPanel', file: 'src/components/EnvironmentRefreshPanel.tsx', supported: ['mysql'], readyText: 'Specification only' },
      { name: 'QueryLabPanel', file: 'src/components/QueryLabPanel.tsx', supported: ['mysql', 'postgres'], readyText: 'Contract is valid' },
    ].flatMap(target => ['mysql', 'postgres', 'redis', 'clickhouse', 'sqlite', 'parquet', 'duckdb', 'mongodb', 'sqlserver'].map(engine => ({
      name: `${target.name}_${engine}`, file: target.file, tier: 'mount',
      mock: { migration_scratch_list: () => [] },
      props: {
        session: {
          connectionId: `c-${engine}`, sessionId: `s-${engine}`,
          connectionName: `${engine} fixture`, engine, environment: 'dev', readOnly: false,
        },
        schema: null, initialSql: '', initialOrigin: 'editor', onClose: () => {},
      },
      assert: ({ html }) => {
        const expected = target.supported.includes(engine) ? target.readyText : 'not available';
        if (!html.includes(expected)) return `${target.name} on ${engine} lacks "${expected}"`;
      },
    }))),
    ...[
      { name: 'MigrationPanel_review', denied: false },
      { name: 'MigrationPanel_catalog_denied', denied: true },
      { name: 'MigrationPanel_preflight_denied', denied: false, preflightDenied: true },
      { name: 'MigrationPanel_scratch_lifecycle', denied: false, scratch: true },
      { name: 'MigrationPanel_target_verification_mismatch', denied: false, scratch: true, targetMismatch: true },
      { name: 'MigrationPanel_verification_mismatch', denied: false, scratch: true, mismatch: true },
      { name: 'MigrationPanel_scratch_cancelled', denied: false, scratch: true, cancelCreate: true },
    ].map(testCase => ({
      name: testCase.name, file: 'src/components/MigrationPanel.tsx', tier: 'mount', settleMs: 30,
      mock: {
        save: () => '/mock/migration-report.md',
        migration_scratch_list: () => testCase.activeScratch ? [testCase.activeScratch] : [],
        migration_rehearsal_create: args => {
          if (testCase.cancelCreate) throw { code: 'cancelled', message: 'scratch creation cancelled' };
          testCase.activeScratch = {
            run_key: args.runKey, session_id: args.sessionId, connection_id: 'c-migration',
            engine: 'mysql', name: 'txui_mig_smoke', status: 'active', error: null,
            created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
          };
          return testCase.activeScratch;
        },
        migration_rehearsal_clone: args => ({
          run_key: args.runKey, tables_cloned: 2, statements_executed: 5,
          total_statements: 5, serial_sequences: 0, foreign_keys_added: 3,
        }),
        migration_rehearsal_execute: args => {
          testCase.activeScratch = { ...testCase.activeScratch, status: 'executed' };
          return {
            run_key: args.runKey, sql_sha256: args.expectedSqlSha256, backend_id: 42,
            statement_total: 1, executed: 1, committed: 1, unknown: 0, failed: 0, not_started: 0,
            statements: [{ number: 1, line: 1, ms: 12, rows_affected: 0, ok: true, error: null, error_code: '', db_code: '', sqlstate: '' }],
            ok: true, cancelled: false, partial: false, ms: 13, error: null,
          };
        },
        migration_deploy_execute: args => {
          testCase.deploymentDone = true;
          const statement = { number: 1, line: 1, ms: 9, rows_affected: 0, ok: true, error: null, error_code: '', db_code: '', sqlstate: '' };
          args.onEvent.onmessage?.({ type: 'backend', backend_id: 43 });
          args.onEvent.onmessage?.({ type: 'statement', statement, committed: 1, unknown: 0, failed: 0, not_started: 0 });
          args.onEvent.onmessage?.({ type: 'done', ok: true, cancelled: false, committed: 1, unknown: 0, failed: 0, not_started: 0 });
          return {
            run_key: args.runKey, sql_sha256: args.expectedSqlSha256, backend_id: 43,
            statement_total: 1, executed: 1, committed: 1, unknown: 0, failed: 0, not_started: 0,
            statements: [statement], ok: true, cancelled: false, partial: false, ms: 10, error: null,
          };
        },
        migration_rehearsal_cleanup: args => {
          const record = testCase.activeScratch ?? {
            run_key: args.runKey, session_id: 's-migration', connection_id: 'c-migration',
            engine: 'mysql', name: 'txui_mig_smoke', status: 'active', error: null,
            created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
          };
          testCase.activeScratch = null;
          return { ...record, status: 'dropped' };
        },
        monitor_query: ({ sql }) => {
          if (testCase.denied) throw new Error('SELECT command denied to user');
          const columns = sql.includes('information_schema.SCHEMATA')
            ? ['server_charset', 'server_collation', 'schema_charset', 'schema_collation', 'server_version']
            : sql.includes('information_schema.TABLES') && sql.includes('TABLE_COMMENT')
              ? ['TABLE_NAME', 'ENGINE', 'TABLE_COLLATION', 'AUTO_INCREMENT', 'TABLE_COMMENT']
              : sql.includes('information_schema.COLUMNS')
                ? ['TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'CHARACTER_MAXIMUM_LENGTH', 'COLUMN_COMMENT']
                : sql.includes('information_schema.STATISTICS')
                  ? ['TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'SUB_PART', 'CARDINALITY', 'INDEX_TYPE']
                  : sql.includes('KEY_COLUMN_USAGE')
                    ? ['CONSTRAINT_NAME', 'TABLE_NAME', 'COLUMN_NAME', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME', 'ORDINAL_POSITION', 'DELETE_RULE', 'UPDATE_RULE']
                    : ['table_name', 'n_rows', 'data_bytes', 'index_bytes', 'last_update'];
          const verified = testCase.activeScratch?.status === 'executed';
          const rows = !verified ? []
            : columns.includes('TABLE_NAME') && columns.includes('TABLE_COMMENT')
              ? [['orders', 'InnoDB', 'utf8mb4_0900_ai_ci', null, '']]
              : columns.includes('COLUMN_NAME') && columns.includes('DATA_TYPE')
                ? [['orders', 'id', 'int', 'int', 'NO', null, '', null, null, null, '']]
                : columns.includes('INDEX_NAME')
                  ? (testCase.mismatch || (testCase.targetMismatch && testCase.deploymentDone)) ? [] : [['orders', 'PRIMARY', 0, 1, 'id', null, 1, 'BTREE']]
                  : [];
          return fixtures.queryResult(columns, rows);
        },
        migration_preflight: args => {
          if (testCase.preflightDenied) {
            throw { code: 'guard_refused', message: 'connection is read-only — write statement rejected' };
          }
          const objects = [...new Set(args.statements.map(statement => statement.table).filter(Boolean))].sort();
          return {
            sql_sha256: createHash('sha256').update(args.sql).digest('hex'),
            statement_count: args.statements.length,
            affected_objects: objects,
            unsupported: args.statements.filter(statement => !statement.supported).length,
            destructive: args.statements.filter(statement => statement.destructive).length,
            lossy: args.statements.filter(statement => statement.lossy).length,
            implicit_commits: args.statements.length,
            statements: args.statements.map((statement, index) => ({ ...statement, number: index + 1, implicit_commit: true })),
            environment: 'dev', read_only: false,
            prod_allow_ddl: false, prod_allow_unfiltered_write: false,
            stop_on_first_error: true,
          };
        },
      },
      props: {
        session: {
          connectionId: 'c-migration', sessionId: 's-migration', connectionName: 'migration fixture',
          engine: 'mysql', environment: 'dev', readOnly: false,
        },
        schema: 'shop', initialSql: 'CREATE TABLE orders(id int PRIMARY KEY);', initialOrigin: 'editor', onClose: () => {},
      },
      interact: async ({ container, act }) => {
        const click = async text => {
          const buttons = [];
          const walk = node => {
            if (node.nodeName === 'BUTTON' && node.textContent.includes(text)) buttons.push(node);
            for (const child of node.childNodes ?? []) walk(child);
          };
          walk(container);
          await act(async () => {
            buttons[0]?.dispatchEvent(new Event('click', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 15));
          });
        };
        await click('Review migration');
        if (testCase.scratch) {
          await click('Create scratch');
          if (!testCase.cancelCreate) await click('Clone before-state');
          if (!testCase.cancelCreate) await click('Execute migration in scratch');
          if (!testCase.cancelCreate) await click('Compare final objects');
          if (!testCase.cancelCreate && !testCase.mismatch) {
            await click('Prepare target deployment');
            await click('Deploy exact SQL now');
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
            testCase.verifyingBeforeFinal = container.textContent.includes('Phase: verifying');
            await click('Verify deployed target');
            await click('Export report .md');
          }
          if (!testCase.cancelCreate) await click('Drop scratch');
        }
      },
      assert: ({ html, calls }) => {
        if (!calls.some(call => call.cmd === 'monitor_query')) return 'catalog was never read';
        if (!calls.some(call => call.cmd === 'migration_preflight')) return 'backend preflight was never called';
        if (testCase.cancelCreate) {
          if (!calls.some(call => call.cmd === 'migration_rehearsal_create')) return 'scratch creation was not attempted';
          if (!html.includes('Scratch creation cancelled')) return 'cancelled creation was not reported honestly';
        } else if (testCase.scratch) {
          if (!calls.some(call => call.cmd === 'migration_rehearsal_create')) return 'scratch was not created';
          if (!calls.some(call => call.cmd === 'migration_rehearsal_clone')) return 'before-state was not cloned';
          if (!calls.some(call => call.cmd === 'migration_rehearsal_execute')) return 'exact migration was not executed in scratch';
          if (!calls.some(call => call.cmd === 'migration_rehearsal_cleanup')) return 'scratch was not dropped';
          if (!html.includes('migration SQL was not executed')) return 'clone result did not distinguish cloning from migration execution';
          if (!html.includes('Exact migration hash executed')) return 'execution result was not rendered';
          if (testCase.mismatch) {
            if (!html.includes('Rehearsal proof withheld')) return 'mismatch did not visibly withhold rehearsal proof';
            if (!html.includes('Phase: reviewed')) return 'mismatch incorrectly advanced the proof phase';
          } else {
            if (!html.includes('Final objects match the expected model')) return 'final-object comparison did not render its clean result';
            if (!calls.some(call => call.cmd === 'migration_deploy_execute')) return 'confirmed target deployment was not executed';
            if (!testCase.verifyingBeforeFinal) return 'successful deployment did not stop at target verification';
            if (!html.includes('1 committed · 0 unknown · 0 failed · 0 not started')) return 'honest deployment counts were not rendered';
            if (testCase.targetMismatch) {
              if (!html.includes('Final verification withheld')) return 'target drift did not withhold final verification';
              if (!html.includes('Phase: verifying')) return 'target drift incorrectly completed the migration';
              if (html.includes('Deployed target verified')) return 'target drift produced a success badge';
            } else {
              if (!html.includes('Phase: done')) return 'clean target comparison did not complete the migration';
              if (!html.includes('Deployed target verified')) return 'final target verification badge was not rendered';
            }
            const reportCall = calls.find(call => call.cmd === 'write_text_file');
            if (!reportCall) return 'migration report was not written';
            for (const needle of ['Migration Cockpit report', 'Rehearsal execution', 'Deployment execution', 'Deployment and verification', 'SQL SHA-256']) {
              if (!reportCall.args.contents.includes(needle)) return `migration report lacks ${needle}`;
            }
          }
          if (!html.includes('Scratch txui_mig_smoke dropped')) return 'successful cleanup was not rendered';
        }
        if (testCase.preflightDenied) {
          if (!html.includes('Backend preflight refused') || !html.includes('1/1 modeled')) {
            return 'guard refusal was not shown while preserving the review';
          }
          if (html.includes('SQL hash verified')) return 'guard refusal claimed a preflight proof';
        } else if (!html.includes('SQL hash verified')) return 'successful backend preflight was not rendered';
        if (testCase.denied) {
          if (!html.includes('Migration-only')) return 'failed catalog reads did not produce migration-only state';
          if (html.includes('Live before-state —')) return 'failed catalog reads claimed live verification';
        } else if (!html.includes('Live before-state') || !html.includes('1/1 modeled')) {
          return 'complete catalog review did not render its live proof and statement summary';
        }
      },
    })),
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
    MigrationPanel: { props: { initialOrigin: 'editor' } },
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
    ResultSetTabs: { props: { result: fixtures.ORDERS_RESULT, engine: 'mysql' } },
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
