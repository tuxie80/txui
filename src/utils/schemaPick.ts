/**
 * In-panel schema picking for the engine with no default-database plumbing.
 *
 * `engineCaps` sets `databaseSelect: false` for SQL Server (the driver uses
 * three-part names and never issues USE — a shared-connection race), so the
 * query tab's `currentDb` is always empty there and DbScopeBar hides itself.
 * A panel that takes its schema from that prop would render "Select a
 * database first" forever. The fix the panels share: when no schema prop
 * arrives, enumerate the schemas themselves (the same query
 * SequencePanel/ColumnProfilePanel already ran inline) and offer an in-panel
 * picker, defaulting to `dbo`.
 *
 * The SQL is the same statement those panels run, extracted once so the next
 * panel does not grow a fourth copy. sys.schemas rather than
 * information_schema.schemata on SQL Server: the view lists a schema per
 * fixed database role (db_datareader and friends) — a dozen empty entries
 * nobody has ever put an object in — and `schema_id < 16384` drops them.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Engine } from './engineCaps.ts';

/**
 * The schema-list query for a panel's own picker, system schemas filtered
 * out. `null` where the engine has no such list to offer — the caller then
 * keeps whatever behaviour it already had.
 */
export function schemaListSql(engine: Engine): string | null {
  switch (engine) {
    case 'sqlserver':
      return 'SELECT name FROM sys.schemas '
        + "WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') "
        + 'ORDER BY name';
    case 'mysql':
      return 'SELECT schema_name FROM information_schema.schemata '
        + "WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') "
        + 'ORDER BY schema_name';
    case 'postgres':
      return 'SELECT schema_name FROM information_schema.schemata '
        + "WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name";
    default:
      return null;
  }
}

/**
 * The schema a freshly opened picker lands on: `dbo` on SQL Server — the one
 * schema every database has and the one the rest of the app defaults to —
 * otherwise the first of the enumerated list.
 */
export function defaultSchema(engine: Engine, schemas: string[]): string {
  if (engine === 'sqlserver' && schemas.includes('dbo')) return 'dbo';
  return schemas[0] ?? '';
}
