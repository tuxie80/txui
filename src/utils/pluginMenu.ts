/**
 * The plugin menu: which panel lives in which dropdown of the session menu bar
 * (the strip that replaced the row of bare icon buttons at the right end of
 * the tab bar — see components/QueryTabs.tsx).
 *
 * Pure data, deliberately free of React/Tauri, so tests/pluginMenu.test.ts can
 * hold it against PANEL_META: a panel added without a menu entry here would be
 * unreachable from the menu — exactly the drift tests/toolsMenu.test.ts guards
 * for the native Tools menu, which lists the same panels one level up.
 *
 * `when` is the render gate the old icon bar applied inline, kept as data so
 * the component evaluates one table instead of repeating 30 conditions:
 *   undefined    → every session
 *   'postgres' / 'clickhouse'
 *                → that engine only (no engineCaps capability exists for them)
 *   anything else → an engineCaps capability, checked with `can(engine, when)`
 * Privilege gating is NOT here — it is role-dependent, not engine-dependent,
 * and stays with `panelBlocked` in the component (greyed, never hidden).
 */
import type { EngineCaps } from './engineCaps';

export interface PluginMenuItem {
  /** Panel id — a key of PANEL_META in components/QueryTabs.tsx. */
  panel: string;
  /** Full name, matching the native Tools menu item (src-tauri/src/lib.rs). */
  label: string;
  /** Hover text — the data-tip the icon button used to carry. */
  tip: string;
  when?: keyof EngineCaps | 'mysql' | 'postgres' | 'clickhouse';
}

export interface PluginMenuGroup {
  id: string;
  label: string;
  items: PluginMenuItem[];
}

export const PLUGIN_MENU: PluginMenuGroup[] = [
  {
    id: 'activity',
    label: 'Activity',
    items: [
      { panel: 'processes', label: 'Processes', tip: 'Processes (processlist + kill)', when: 'processList' },
      // One panel for the whole subject (components/LocksPanel.tsx): blocking
      // chains + kill on one tab, the deadlock wait-for graph and recorded
      // incident history on the other.
      { panel: 'locks', label: 'Locks & Deadlocks', tip: 'Locks & Deadlocks — blocking chains, deadlock graph & incident history', when: 'lockWaits' },
      // One Watch panel, three modes (metrics / statement / wait profile —
      // components/WatchPanel.tsx). No engine gate: the Metrics mode runs any
      // query on any engine; the statement mode (longQueryWatch) and the wait
      // profile (PostgreSQL) are greyed inside the panel where the engine or
      // the role cannot serve them.
      { panel: 'watch', label: 'Watch', tip: 'Watch — interval metrics, a statement\'s live phase + progress, or a wait-event profile' },
      { panel: 'replication', label: 'Replication', tip: 'Replication status', when: 'replication' },
      { panel: 'pglisten', label: 'Listen / Notify', tip: 'Listen / Notify — watch a PostgreSQL channel', when: 'postgres' },
      // Playground lives under Activity, not Server: it is about live
      // activity (spawned load), not server configuration.
      { panel: 'playground', label: 'Playground', tip: 'Playground — generate a scenario (spawn mess: threads, locks, rogue queries)', when: 'playground' },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    items: [
      { panel: 'stmtstats', label: 'Statement statistics', tip: 'Statement statistics — snapshot and diff cumulative statement digests over time', when: 'stmtStats' },
      { panel: 'querystore', label: 'Query Store', tip: 'Query Store — plan regressions and plan forcing (SQL Server)', when: 'queryStore' },
      { panel: 'slowlog', label: 'Slow-log analyzer', tip: 'Slow-query-log analyzer (pt-query-digest style)', when: 'mysql' },
      { panel: 'binlog', label: 'Binary logs', tip: 'Binary log events viewer + PITR helper', when: 'mysql' },
      { panel: 'history', label: 'Query history', tip: 'Query history' },
    ],
  },
  {
    id: 'server',
    label: 'Server',
    items: [
      { panel: 'serverinfo', label: 'Server variables & status', tip: 'Server variables & status', when: 'serverInfo' },
      // Every engine has a curated view set — MySQL sys/P_S, PostgreSQL
      // pg_stat, Redis INFO/CLIENT/SLOWLOG/MEMORY (the tip says which).
      { panel: 'dbaviews', label: 'DBA views', tip: 'DBA views (sys / performance_schema / pg_stat)' },
      { panel: 'tuner', label: 'Server tuner', tip: 'Server tuner — health score & guided fixes (read-only)', when: 'tuner' },
      { panel: 'users', label: 'Users & grants', tip: 'Users & grants (changes generate SQL for review)', when: 'userAdmin' },
      { panel: 'maintenance', label: 'Maintenance', tip: 'Maintenance — table upkeep (SQL) or file upkeep (SQLite)', when: 'maintenance' },
      { panel: 'vacuum', label: 'Vacuum & Bloat', tip: 'Vacuum & Bloat — running vacuums, autovacuum backlog, bloat, wraparound, and the fix', when: 'postgres' },
      // Fleet lives under Server, not Activity: it is a per-server property
      // (checks across every server sharing a label), not one session's load.
      { panel: 'fleet', label: 'Fleet', tip: 'Fleet — checks across every server sharing a label', when: 'fleet' },
    ],
  },
  {
    id: 'schema',
    label: 'Schema',
    items: [
      { panel: 'erdiagram', label: 'ER diagram', tip: 'ER diagram (visual schema)', when: 'erDiagram' },
      // No engine gate, same as the native Tools menu (no PANEL_ENGINE_CAP
      // entry): the designer refuses gracefully on engines it cannot serve.
      { panel: 'designer', label: 'Table designer', tip: 'Table designer — create or alter a table’s structure' },
      { panel: 'routines', label: 'Routines', tip: 'Routines — edit procedures, functions, triggers and events', when: 'routines' },
      { panel: 'views', label: 'Views', tip: 'Views — create, replace, refresh, drop', when: 'sql' },
      { panel: 'sequences', label: 'Sequences', tip: 'Sequences — create, alter, restart', when: 'sequences' },
      // Composite types, enums and domains — PostgreSQL-only objects.
      { panel: 'types', label: 'Types', tip: 'Types — composite types, enums and domains', when: 'postgres' },
      // Dictionaries — a ClickHouse-only object.
      { panel: 'dictionary', label: 'Dictionary', tip: 'Dictionary — create, replace, drop ClickHouse dictionaries', when: 'clickhouse' },
      { panel: 'documenter', label: 'Documenter', tip: 'Documenter — commit-ready schema documentation', when: 'documenter' },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    items: [
      { panel: 'datagen', label: 'Data generator', tip: 'Data generator (objects + rows)', when: 'dataGen' },
      { panel: 'csvimport', label: 'CSV import', tip: 'CSV import', when: 'csvImport' },
      { panel: 'colprofile', label: 'Column profile', tip: 'Column profile — what is actually in each column', when: 'columnProfile' },
    ],
  },
  {
    id: 'findcompare',
    label: 'Find & Compare',
    items: [
      // One Find panel, three scopes (usages / in database / in files —
      // components/FindPanel.tsx). No engine gate: the files scope works on
      // every engine, including offline; the two server scopes are greyed
      // inside the panel where the engine cannot serve them.
      { panel: 'find', label: 'Find', tip: 'Find — what references a table or column, a value in every table, or text in .sql files' },
      // One Compare panel, four modes (schema / data / results / scripts —
      // components/ComparePanel.tsx). No engine gate: the schema, results and
      // scripts modes work on every engine; the data mode is greyed inside the
      // panel where the engine cannot serve it.
      { panel: 'compare', label: 'Compare', tip: 'Compare — schemas or instances, table rows, result sets, or SQL scripts' },
    ],
  },
  {
    id: 'sql',
    label: 'SQL',
    items: [
      { panel: 'txshell', label: 'TxShell', tip: 'TxShell — SQL command line (\\help for commands)', when: 'sql' },
      { panel: 'quality', label: 'SQL Quality', tip: 'SQL Quality — deep query analysis', when: 'sqlQuality' },
      { panel: 'saved', label: 'Saved queries', tip: 'Saved queries' },
    ],
  },
];
