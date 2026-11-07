import { buildRefreshPlan, buildRefreshPolicySql, resolveRefreshTable } from './refreshPlan.ts';
import type { RefreshTimeColumn } from './refreshPlan.ts';
import { parseRefreshSpec } from './refreshSpec.ts';
import type { RefreshSpec, RefreshTablePolicy } from './refreshSpec.ts';
import type {
  RefreshCatalogAnalysis, RefreshForeignKeyEdge, RefreshGraphTable, RefreshGridRunner, RefreshUniqueKey,
} from './refreshCatalog.ts';
import type { Grid } from './schemaCollect.ts';
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

type Scalar = string | number;
type NullableScalar = Scalar | null;

interface Key {
  values: Scalar[];
  canonical: string;
}

interface RowRecord {
  key: Key;
  identities: Map<string, Key>;
  references: Map<string, (NullableScalar[])>;
}

interface TableState {
  table: RefreshGraphTable;
  requested: Set<string>;
  closure: Set<string>;
  rows: Map<string, RowRecord>;
  lookups: Map<string, Map<string, string>>;
}

export interface RefreshRowSetCounts {
  table: string;
  action: RefreshTablePolicy['policy'] | 'dependency';
  requested: number | null;
  closureAdded: number | null;
  final: number | null;
  notes: string[];
}

export interface RefreshRowSetPlan {
  readOnly: true;
  specSha256: string;
  fixedPoint: boolean;
  iterations: number;
  sourceQueries: number;
  sourceRowsRead: number;
  tables: RefreshRowSetCounts[];
  totals: { requested: number | null; closureAdded: number | null; final: number | null };
  blockers: string[];
}

class RowSetBlocker extends Error {}

const columnSetKey = (columns: string[]) => columns.join('\u0000');
const quoted = (name: string) => quoteIdent(name, 'mysql');

function scalar(value: unknown, table: string, column: string, nullable: false): Scalar;
function scalar(value: unknown, table: string, column: string, nullable: true): NullableScalar;
function scalar(value: unknown, table: string, column: string, nullable: boolean): NullableScalar {
  if (value === null && nullable) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && !value.includes('\0')) return value;
  throw new RowSetBlocker(`${table}.${column} has an unsupported or non-exact key/FK value type`);
}

function key(values: Scalar[]): Key {
  return {
    values,
    canonical: values.map(value => {
      const text = String(value);
      return `${typeof value === 'number' ? 'n' : 's'}${text.length}:${text}`;
    }).join('|'),
  };
}

function reader(grid: Grid, table: string): (row: unknown[], name: string) => unknown {
  const indexes = new Map<string, number>();
  grid.columns.forEach((name, index) => {
    const normalized = name.toLowerCase();
    if (indexes.has(normalized)) throw new RowSetBlocker(`${table} key query returned duplicate column ${name}`);
    indexes.set(normalized, index);
  });
  return (row, name) => {
    const index = indexes.get(name.toLowerCase());
    if (index === undefined || index >= row.length) throw new RowSetBlocker(`${table} key query omitted column ${name}`);
    return row[index];
  };
}

function outgoing(graph: RefreshCatalogAnalysis, table: RefreshGraphTable): RefreshForeignKeyEdge[] {
  return graph.graph.foreignKeys.filter(edge => edge.schema === table.schema && edge.table === table.name);
}

function keyColumns(table: RefreshGraphTable): string[] {
  return [...new Set([
    ...table.uniqueKeys.flatMap(unique => unique.columns),
    ...table.indexes.filter(index => index.name === 'PRIMARY').flatMap(index => index.columns.map(column => column.name)),
  ])];
}

function projection(graph: RefreshCatalogAnalysis, table: RefreshGraphTable): string[] {
  return [...new Set([
    ...keyColumns(table),
    ...outgoing(graph, table).flatMap(edge => edge.parts.map(part => part.column)),
  ])];
}

function chosenKey(table: RefreshGraphTable): RefreshUniqueKey {
  const chosen = table.uniqueKeys[0];
  if (!chosen) throw new RowSetBlocker(`${table.key} has no proven unique NOT-NULL key`);
  return chosen;
}

function timeType(table: RefreshGraphTable, policy: RefreshTablePolicy): RefreshTimeColumn {
  if (policy.policy !== 'time_window') return 'datetime';
  const dataType = table.columns.find(column => column.name === policy.column)?.dataType.toLowerCase();
  if (dataType === 'date' || dataType === 'datetime' || dataType === 'timestamp') return dataType;
  throw new RowSetBlocker(`${table.key}.${policy.column} has no proven temporal type`);
}

function rowRecord(
  graph: RefreshCatalogAnalysis,
  table: RefreshGraphTable,
  grid: Grid,
  row: unknown[],
): RowRecord {
  const get = reader(grid, table.key);
  const chosen = chosenKey(table);
  const identity = key(chosen.columns.map(column => scalar(get(row, column), table.key, column, false)));
  const identities = new Map<string, Key>();
  for (const unique of table.uniqueKeys) {
    identities.set(columnSetKey(unique.columns), key(unique.columns.map(column => scalar(get(row, column), table.key, column, false))));
  }
  const references = new Map<string, NullableScalar[]>();
  for (const edge of outgoing(graph, table)) {
    const values = edge.parts.map(part => scalar(get(row, part.column), table.key, part.column, true));
    references.set(edge.key, values);
  }
  return { key: identity, identities, references };
}

function totalKeys(states: Map<string, TableState>): number {
  return [...states.values()].reduce((total, state) => total + state.rows.size, 0);
}

function addRow(
  states: Map<string, TableState>,
  state: TableState,
  record: RowRecord,
  kind: 'requested' | 'closure',
  maximum: number,
): void {
  if (state.rows.has(record.key.canonical)) throw new RowSetBlocker(`${state.table.key} returned a duplicate row identity`);
  if (totalKeys(states) >= maximum) {
    throw new RowSetBlocker(`planning exceeds the ${maximum.toLocaleString()} key cap; no temporary key file or unbounded queue was used`);
  }
  for (const [signature, identity] of record.identities) {
    const lookups = state.lookups.get(signature) ?? new Map<string, string>();
    const existing = lookups.get(identity.canonical);
    if (existing && existing !== record.key.canonical) {
      throw new RowSetBlocker(`${state.table.key} returned contradictory unique-key identities`);
    }
    lookups.set(identity.canonical, record.key.canonical);
    state.lookups.set(signature, lookups);
  }
  state.rows.set(record.key.canonical, record);
  state[kind].add(record.key.canonical);
}

async function queryGrid(
  runner: RefreshGridRunner,
  sessionId: string,
  table: string,
  sql: string,
): Promise<Grid> {
  try {
    const grid = await runner(sessionId, sql);
    if (!grid) throw new RowSetBlocker(`${table} key query was denied or returned no result`);
    if (grid.truncated) throw new RowSetBlocker(`${table} key query was truncated; row-set proof is incomplete`);
    return grid;
  } catch (error) {
    if (error instanceof RowSetBlocker) throw error;
    throw new RowSetBlocker(`${table} key query failed; database error details are omitted to avoid exposing row values`);
  }
}

function literal(value: Scalar): string {
  return typeof value === 'number' ? String(value) : sqlLiteral(value, 'mysql');
}

export function buildRefreshParentLookupSql(
  table: RefreshGraphTable,
  graph: RefreshCatalogAnalysis,
  edge: RefreshForeignKeyEdge,
  parents: Scalar[][],
): string {
  if (parents.length === 0 || parents.some(values => values.length !== edge.parts.length)) {
    throw new RowSetBlocker(`${table.key} parent lookup has an empty or malformed key batch`);
  }
  const selected = projection(graph, table).map(quoted).join(', ');
  const relation = `${quoted(table.schema)}.${quoted(table.name)}`;
  const columns = edge.parts.map(part => quoted(part.refColumn)).join(', ');
  const tuples = parents.map(values => `(${values.map(literal).join(', ')})`).join(', ');
  return `SELECT ${selected} FROM ${relation} WHERE (${columns}) IN (${tuples})`;
}

function lookupIdentity(state: TableState, edge: RefreshForeignKeyEdge, values: Scalar[]): Key {
  const signature = columnSetKey(edge.parts.map(part => part.refColumn));
  if (!state.lookups.has(signature)) {
    throw new RowSetBlocker(`${state.table.key} has no unique key matching FK ${edge.name}`);
  }
  return key(values);
}

export async function planRefreshRowSets(input: {
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
  runGrid: RefreshGridRunner;
  onProgress?: (event: { phase: 'requested' | 'closure'; table: string; queries: number; rowsRead: number }) => void;
}): Promise<RefreshRowSetPlan> {
  const spec = parseRefreshSpec(input.spec);
  if (!input.catalog.complete) throw new RowSetBlocker('catalog compatibility has blockers; row-set planning is not allowed');
  const expectedHash = buildRefreshPlan(spec).specSha256;
  if (input.catalog.plan.specSha256 !== expectedHash) throw new RowSetBlocker('catalog analysis belongs to a different specification');
  if (!spec.source.sessionId) throw new RowSetBlocker('source session is not selected');
  const sessionId = spec.source.sessionId;
  const blockers = new Set<string>();
  const states = new Map<string, TableState>();
  for (const table of input.catalog.graph.tables) {
    const lookups = new Map<string, Map<string, string>>();
    for (const unique of table.uniqueKeys) lookups.set(columnSetKey(unique.columns), new Map());
    states.set(table.key, { table, requested: new Set(), closure: new Set(), rows: new Map(), lookups });
  }
  const policies = new Map<string, RefreshTablePolicy>();
  for (const policy of spec.tables) {
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') throw new RowSetBlocker(resolved);
    policies.set(`${resolved.sourceSchema}.${resolved.tableName}`, policy);
  }
  let sourceQueries = 0;
  let sourceRowsRead = 0;
  const progress = (phase: 'requested' | 'closure', table: string) => input.onProgress?.({
    phase, table, queries: sourceQueries, rowsRead: sourceRowsRead,
  });
  let iterations = 0;
  try {
    for (const [tableName, policy] of policies) {
      if (policy.policy === 'generate') {
        blockers.add(`${tableName} uses generate; FK closure cannot be proven before deterministic generation supplies keys`);
        continue;
      }
      if (policy.policy === 'exclude') continue;
      const state = states.get(tableName);
      if (!state) throw new RowSetBlocker(`${tableName} has no source catalog table`);
      const sql = buildRefreshPolicySql(spec, policy, state.table.schema, timeType(state.table, policy), projection(input.catalog, state.table));
      sourceQueries += 1;
      const grid = await queryGrid(input.runGrid, sessionId, tableName, sql);
      sourceRowsRead += grid.rows.length;
      for (const row of grid.rows) addRow(states, state, rowRecord(input.catalog, state.table, grid, row), 'requested', spec.limits.maxPlanningKeys);
      progress('requested', tableName);
    }

    let changed = true;
    while (changed && blockers.size === 0) {
      changed = false;
      iterations += 1;
      for (const state of states.values()) {
        for (const edge of outgoing(input.catalog, state.table)) {
          const parentName = `${edge.refSchema}.${edge.refTable}`;
          const parent = states.get(parentName);
          if (!parent) throw new RowSetBlocker(`${state.table.key}.${edge.name} has no loaded parent ${parentName}`);
          const missing = new Map<string, Scalar[]>();
          for (const row of state.rows.values()) {
            const values = row.references.get(edge.key);
            if (!values) throw new RowSetBlocker(`${state.table.key}.${edge.name} is missing projected FK columns`);
            if (values.some(value => value === null)) continue;
            const identity = lookupIdentity(parent, edge, values as Scalar[]);
            const lookups = parent.lookups.get(columnSetKey(edge.parts.map(part => part.refColumn)))!;
            if (!lookups.has(identity.canonical)) missing.set(identity.canonical, identity.values);
          }
          const requests = [...missing.values()];
          const parentRowsBefore = parent.rows.size;
          for (let offset = 0; offset < requests.length; offset += spec.limits.planningKeyBatch) {
            const batch = requests.slice(offset, offset + spec.limits.planningKeyBatch);
            const sql = buildRefreshParentLookupSql(parent.table, input.catalog, edge, batch);
            sourceQueries += 1;
            const grid = await queryGrid(input.runGrid, sessionId, parentName, sql);
            sourceRowsRead += grid.rows.length;
            for (const row of grid.rows) addRow(states, parent, rowRecord(input.catalog, parent.table, grid, row), 'closure', spec.limits.maxPlanningKeys);
            const lookups = parent.lookups.get(columnSetKey(edge.parts.map(part => part.refColumn)))!;
            for (const values of batch) {
              if (!lookups.has(key(values).canonical)) {
                throw new RowSetBlocker(`${state.table.key}.${edge.name} requires a missing parent in ${parentName}; source FK integrity is not assumed`);
              }
            }
            progress('closure', parentName);
          }
          if (parent.rows.size > parentRowsBefore) changed = true;
        }
      }
    }
    for (const [tableName, policy] of policies) {
      if (policy.policy !== 'row_limit' && policy.policy !== 'sample') continue;
      if (policy.limitKind !== 'hard') continue;
      const state = states.get(tableName);
      const final = (state?.requested.size ?? 0) + (state?.closure.size ?? 0);
      if (final > policy.rows) {
        blockers.add(`${tableName} hard maximum ${policy.rows.toLocaleString()} is exceeded by FK closure: ${final.toLocaleString()} rows would be required; refusing to orphan dependent selections`);
      }
    }
    const tables = input.catalog.tables.map(compatibility => {
      const state = compatibility.source ? states.get(compatibility.source) : undefined;
      if (compatibility.action === 'generate') {
        return { table: compatibility.table, action: compatibility.action, requested: null, closureAdded: null, final: null, notes: ['Generated keys do not exist yet; counts and FK closure are not proven'] };
      }
      const requested = state?.requested.size ?? 0;
      const closureAdded = state?.closure.size ?? 0;
      const final = requested + closureAdded;
      const policy = policies.get(compatibility.table);
      const limited = policy && (policy.policy === 'row_limit' || policy.policy === 'sample') ? policy : null;
      const notes = compatibility.action === 'exclude'
        ? ['Excluded by policy']
        : closureAdded > 0
          ? [`${closureAdded} parent rows were added by FK closure outside this table's own selection`]
          : ['No closure rows required beyond the requested set'];
      if (limited && final > limited.rows) {
        if (limited.limitKind === 'hard') notes.push(`Hard maximum ${limited.rows.toLocaleString()} rejected; dependent selections were not pruned`);
        else notes.push(`FK closure exceeds the soft selection limit ${limited.rows.toLocaleString()} by ${(final - limited.rows).toLocaleString()}; this is allowed and reported`);
      }
      return {
        table: compatibility.table, action: compatibility.action,
        requested, closureAdded, final, notes,
      };
    });
    const finalIterations = iterations;
    const sum = (field: 'requested' | 'closureAdded' | 'final') => blockers.size > 0 || tables.some(table => table[field] === null)
      ? null : tables.reduce((total, table) => total + (table[field] ?? 0), 0);
    return {
      readOnly: true, specSha256: expectedHash, fixedPoint: blockers.size === 0, iterations: finalIterations,
      sourceQueries, sourceRowsRead, tables,
      totals: { requested: sum('requested'), closureAdded: sum('closureAdded'), final: sum('final') },
      blockers: [...blockers].sort(),
    };
  } catch (error) {
    const message = error instanceof RowSetBlocker ? error.message : 'row-set planning failed without exposing row values';
    blockers.add(message);
    const tables = input.catalog.tables.map(compatibility => {
      const state = compatibility.source ? states.get(compatibility.source) : undefined;
      const requested = state?.requested.size ?? 0;
      const closureAdded = state?.closure.size ?? 0;
      return {
        table: compatibility.table, action: compatibility.action, requested, closureAdded,
        final: requested + closureAdded, notes: ['Partial counts before the blocker; not an executable row-set plan'],
      };
    });
    return {
      readOnly: true, specSha256: expectedHash, fixedPoint: false, iterations,
      sourceQueries, sourceRowsRead, tables,
      totals: { requested: null, closureAdded: null, final: null }, blockers: [...blockers].sort(),
    };
  }
}
