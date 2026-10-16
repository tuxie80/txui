/**
 * Panel-input conformance — the "a panel the menu offers can obtain its
 * inputs on this engine" pin, born from the MSSQL currentDb class of bugs.
 *
 * QueryTabs feeds schema-taking panels `schema={c.currentDb || null}`. On an
 * engine with `engineCaps.databaseSelect: false` (SQL Server, SQLite, …)
 * there is no default-database plumbing, so `currentDb` is empty forever and
 * a panel that trusts the prop renders "Select a database first" until
 * closed. The fix each panel must show ONE of:
 *
 *   - 'schemaPick' — imports utils/schemaPick (self-enumerating picker);
 *   - 'inline'     — runs its own schema-list query (`sys.schemas` on T-SQL);
 *   - 'viewDdl'    — the picker's query lives in utils/viewDdl's schemaListSql;
 *   - 'fallback'   — a built-in default per dialect (TableDesigner's 'dbo');
 *   - 'dbList'     — its own database picker fed by the dbList prop
 *                    (ComparePanel's DbScopeBar).
 *
 * This is a source pin (the convention of tests/menuBar.test.ts /
 * tests/mongoGraphics.test.ts), not a renderer: it reads the panel sources
 * and QueryTabs, and cross-checks menu reachability against ENGINE_CAPS so
 * "exempt because only reachable where databaseSelect is true" is itself
 * pinned, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE_CAPS, can, type Engine } from '../src/utils/engineCaps.ts';
import { PLUGIN_MENU } from '../src/utils/pluginMenu.ts';

const queryTabs = readFileSync('src/components/QueryTabs.tsx', 'utf8');
const panelSrc = (file: string) => readFileSync(`src/components/${file}`, 'utf8');

type Mechanism = 'schemaPick' | 'inline' | 'viewDdl' | 'fallback' | 'dbList' | 'delegates';

const MECHANISM_RE: Record<Mechanism, RegExp> = {
  schemaPick: /from '\.\.\/utils\/schemaPick'/,
  inline:     /sys\.schemas/,
  viewDdl:    /schemaListSql[\s\S]*?from '\.\.\/utils\/viewDdl'|from '\.\.\/utils\/viewDdl'[\s\S]*?schemaListSql/,
  fallback:   /dialect === 'sqlserver' \? 'dbo'/,
  dbList:     /\bdbList\b/,
  // FindPanel is the scope switcher: it consumes no schema itself, but must
  // hand the prop to both server scopes (each self-enumerates — pinned in the
  // FindPanel test below), or they would starve on databaseSelect:false engines.
  delegates:  /<DbSearchPanel session=\{session\} schema=\{schema\}[\s\S]*?<FindUsagesPanel session=\{session\} schema=\{schema\}|<FindUsagesPanel session=\{session\} schema=\{schema\}[\s\S]*?<DbSearchPanel session=\{session\} schema=\{schema\}/,
};

interface Entry {
  /** PANEL_META key in QueryTabs / PLUGIN_MENU panel id. */
  panel: string;
  /** Component fed `schema={c.…}` in QueryTabs. */
  component: string;
  file: string;
  /** How the panel obtains a schema when the prop arrives empty/null. */
  mechanism: Mechanism;
}

/** Every panel QueryTabs feeds a schema — the count pin below fails if a
 *  thirteenth appears without being registered here. */
const PANELS: Entry[] = [
  { panel: 'routines',   component: 'RoutinePanel',       file: 'RoutinePanel.tsx',       mechanism: 'schemaPick' },
  { panel: 'find',       component: 'FindPanel',          file: 'FindPanel.tsx',          mechanism: 'delegates' },
  { panel: 'colprofile', component: 'ColumnProfilePanel', file: 'ColumnProfilePanel.tsx', mechanism: 'inline' },
  { panel: 'sequences',  component: 'SequencePanel',      file: 'SequencePanel.tsx',      mechanism: 'inline' },
  { panel: 'types',      component: 'TypePanel',          file: 'TypePanel.tsx',          mechanism: 'inline' },    // exempt: PostgreSQL-only
  { panel: 'views',      component: 'ViewPanel',          file: 'ViewPanel.tsx',          mechanism: 'viewDdl' },
  { panel: 'dictionary', component: 'DictionaryPanel',    file: 'DictionaryPanel.tsx',    mechanism: 'inline' },    // exempt: ClickHouse-only
  { panel: 'designer',   component: 'TableDesigner',      file: 'TableDesigner.tsx',      mechanism: 'fallback' },
  { panel: 'compare',    component: 'ComparePanel',       file: 'ComparePanel.tsx',       mechanism: 'dbList' },
  { panel: 'maintenance', component: 'MaintenancePanel',  file: 'MaintenancePanel.tsx',   mechanism: 'schemaPick' },
  { panel: 'documenter', component: 'DocumenterPanel',    file: 'DocumenterPanel.tsx',    mechanism: 'schemaPick' },
  { panel: 'datagen',    component: 'DataGenPanel',       file: 'DataGenPanel.tsx',       mechanism: 'inline' },
];

/** Engines with no default-database plumbing — currentDb never arrives. */
const NO_DB_SELECT = (Object.keys(ENGINE_CAPS) as Engine[])
  .filter(e => !ENGINE_CAPS[e].databaseSelect);

/** PLUGIN_MENU reachability: undefined `when` = every session; an engine name
 *  = that engine only; anything else = an engineCaps capability. */
function reachable(panel: string, engine: Engine): boolean {
  const item = PLUGIN_MENU.flatMap(g => g.items).find(i => i.panel === panel);
  if (!item) return false;
  if (!item.when) return true;
  if (item.when === 'mysql' || item.when === 'postgres' || item.when === 'clickhouse') {
    return item.when === engine;
  }
  return can(engine, item.when);
}

test('the pin covers every panel QueryTabs feeds a schema — no more, no less', () => {
  const feeds = queryTabs.match(/schema=\{c\./g) ?? [];
  assert.equal(feeds.length, PANELS.length,
    'a schema-fed panel was added or removed in QueryTabs — register it in PANELS');
  for (const p of PANELS) {
    const re = new RegExp(`<${p.component}\\b[\\s\\S]{0,400}?schema=\\{c\\.`);
    assert.match(queryTabs, re, `${p.component} no longer receives schema={c.…} in QueryTabs`);
  }
});

test('a schema panel reachable without databaseSelect can self-supply the schema', () => {
  for (const p of PANELS) {
    const reachableNoSelect = NO_DB_SELECT.filter(e => reachable(p.panel, e));
    const src = panelSrc(p.file);
    if (reachableNoSelect.length === 0) {
      // Exempt — only reachable where the schema prop always arrives. The
      // dedicated test below pins WHICH panels may claim this.
      continue;
    }
    assert.match(src, MECHANISM_RE[p.mechanism],
      `${p.component} is reachable on ${reachableNoSelect.join(', ')} (databaseSelect: false) `
      + `but ${p.file} lost its ${p.mechanism} schema source — it would render `
      + `"Select a database first" forever there`);
  }
});

test('the exemptions are the engine-gated panels, and stay that way', () => {
  // Types is PostgreSQL-only, Dictionary ClickHouse-only — both engines have
  // databaseSelect: true, so the schema prop always arrives.
  for (const panel of ['types', 'dictionary']) {
    assert.equal(NO_DB_SELECT.filter(e => reachable(panel, e)).length, 0,
      `${panel} became reachable on a databaseSelect:false engine — it needs a mechanism`);
  }
});

test('FindPanel forwards the schema to sub-panels that self-enumerate', () => {
  // DbSearchPanel is not a PANEL_META entry — FindPanel mounts it for the
  // "in database" scope, so the feed is pinned one hop out. Both consumers
  // must self-supply the schema on databaseSelect:false engines.
  assert.match(panelSrc('DbSearchPanel.tsx'), MECHANISM_RE.schemaPick,
    'DbSearchPanel lost the schemaPick import — on SQL Server its schema prop is always null');
  assert.match(panelSrc('FindUsagesPanel.tsx'), MECHANISM_RE.inline,
    'FindUsagesPanel lost its inline schema enumeration');
});
