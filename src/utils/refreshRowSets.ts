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
  references: Map<string, NullableScalar[]>;
}

interface TableState {
  table: RefreshGraphTable;
  requestedCount: number;
  closure: Set<string>;
  closureIdentities: Map<string, Map<string, string>>;
  recentRequested: Map<string, Map<string, string>>;
}

interface MemoryState {
  closureIdentities: number;
  recentRequestedIdentities: number;
  frontierIdentities: number;
  peakRetainedKeys: number;
  peakFrontierRows: number;
  peakBufferedRows: number;
}

export interface RefreshPlanningMemory {
  maxPlanningKeys: number;
  planningKeyBatch: number;
  closureIdentities: number;
  recentRequestedIdentities: number;
  peakRetainedKeys: number;
  peakFrontierRows: number;
  peakBufferedRows: number;
  fullRootKeysRetained: 0;
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
  memory: RefreshPlanningMemory;
  blockers: string[];
}

class RowSetBlocker extends Error {}

const RECENT_REQUESTED_IDENTITIES = 10_000;
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

function projection(graph: RefreshCatalogAnalysis, table: RefreshGraphTable): string[] {
  return [...new Set([
    ...table.uniqueKeys.flatMap(unique => unique.columns),
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
  get: (row: unknown[], name: string) => unknown,
  row: unknown[],
): RowRecord {
  const chosen = chosenKey(table);
  const identity = key(chosen.columns.map(column => scalar(get(row, column), table.key, column, false)));
  const identities = new Map<string, Key>();
  for (const unique of table.uniqueKeys) {
    identities.set(columnSetKey(unique.columns), key(unique.columns.map(column => scalar(get(row, column), table.key, column, false))));
  }
  const references = new Map<string, NullableScalar[]>();
  for (const edge of outgoing(graph, table)) {
    references.set(edge.key, edge.parts.map(part => scalar(get(row, part.column), table.key, part.column, true)));
  }
  return { key: identity, identities, references };
}

function literal(value: Scalar): string {
  return typeof value === 'number' ? String(value) : sqlLiteral(value, 'mysql');
}

function tuple(columns: string[], values: Scalar[]): string {
  return `(${columns.map(quoted).join(', ')}) > (${values.map(literal).join(', ')})`;
}

function inTuples(columns: string[], values: Scalar[][]): string {
  return `(${columns.map(quoted).join(', ')}) IN (${values.map(item => `(${item.map(literal).join(', ')})`).join(', ')})`;
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
  const columns = edge.parts.map(part => part.refColumn);
  return `SELECT ${selected} FROM ${relation} WHERE ${inTuples(columns, parents)}`;
}

export function buildRefreshRootPageSql(input: {
  spec: RefreshSpec;
  policy: RefreshTablePolicy;
  table: RefreshGraphTable;
  graph: RefreshCatalogAnalysis;
  after: Scalar[] | null;
  batch: number;
}): string {
  const columns = projection(input.graph, input.table);
  const selected = columns.map(quoted).join(', ');
  const inner = buildRefreshPolicySql(
    input.spec, input.policy, input.table.schema, timeType(input.table, input.policy), columns,
  );
  const chosen = chosenKey(input.table);
  const where = input.after ? ` WHERE ${tuple(chosen.columns, input.after)}` : '';
  return `SELECT ${selected} FROM (${inner}) AS \`__txui_refresh_selection\`${where} ORDER BY ${chosen.columns.map(quoted).join(', ')} LIMIT ${input.batch}`;
}

function buildRefreshMembershipSql(input: {
  spec: RefreshSpec;
  policy: RefreshTablePolicy;
  table: RefreshGraphTable;
  edge: RefreshForeignKeyEdge;
  parents: Scalar[][];
}): string {
  const columns = input.edge.parts.map(part => part.refColumn);
  const selected = columns.map(quoted).join(', ');
  const inner = buildRefreshPolicySql(input.spec, input.policy, input.table.schema, timeType(input.table, input.policy), columns);
  return `SELECT ${selected} FROM (${inner}) AS \`__txui_refresh_membership\` WHERE ${inTuples(columns, input.parents)}`;
}

async function queryGrid(
  runner: RefreshGridRunner,
  sessionId: string,
  table: string,
  sql: string,
  batch: number,
): Promise<Grid> {
  try {
    const grid = await runner(sessionId, sql);
    if (!grid) throw new RowSetBlocker(`${table} key query was denied or returned no result`);
    if (grid.truncated) throw new RowSetBlocker(`${table} key query was truncated; row-set proof is incomplete`);
    if (grid.rows.length > batch) throw new RowSetBlocker(`${table} key query exceeded the ${batch.toLocaleString()} row buffer cap`);
    return grid;
  } catch (error) {
    if (error instanceof RowSetBlocker) throw error;
    throw new RowSetBlocker(`${table} key query failed; database error details are omitted to avoid exposing row values`);
  }
}

function signature(edge: RefreshForeignKeyEdge): string {
  return columnSetKey(edge.parts.map(part => part.refColumn));
}

function seen(state: TableState, edge: RefreshForeignKeyEdge, identity: Key): boolean {
  const name = signature(edge);
  return state.closureIdentities.get(name)?.has(identity.canonical)
    || state.recentRequested.get(name)?.has(identity.canonical)
    || false;
}

function refreshPeak(memory: MemoryState): void {
  memory.peakRetainedKeys = Math.max(
    memory.peakRetainedKeys,
    memory.closureIdentities + memory.recentRequestedIdentities,
  );
  memory.peakFrontierRows = Math.max(memory.peakFrontierRows, memory.frontierIdentities);
}

function rememberClosure(state: TableState, record: RowRecord, memory: MemoryState, maximum: number): boolean {
  if (state.closure.has(record.key.canonical)) return false;
  const additions = [...record.identities.values()].reduce((total, identity) => {
    return total + ([...state.closureIdentities.values()].filter(map => !map.has(identity.canonical)).length);
  }, 0);
  if (memory.closureIdentities + memory.recentRequestedIdentities + additions > maximum) {
    throw new RowSetBlocker(`planning exceeds the ${maximum.toLocaleString()} retained-key cap; no temporary key file or unbounded queue was used`);
  }
  for (const [name, identity] of record.identities) {
    const map = state.closureIdentities.get(name);
    if (!map) throw new RowSetBlocker(`${state.table.key} has an unregistered unique identity`);
    const previous = map.get(identity.canonical);
    if (previous && previous !== record.key.canonical) throw new RowSetBlocker(`${state.table.key} returned contradictory unique-key identities`);
    if (!previous) memory.closureIdentities += 1;
    map.set(identity.canonical, record.key.canonical);
  }
  state.closure.add(record.key.canonical);
  refreshPeak(memory);
  return true;
}

function rememberRequested(
  states: Map<string, TableState>, state: TableState, record: RowRecord, memory: MemoryState, maximum: number,
): boolean {
  const chosenSignature = columnSetKey(chosenKey(state.table).columns);
  if (state.recentRequested.get(chosenSignature)?.has(record.key.canonical)) return false;
  const cacheCap = Math.min(RECENT_REQUESTED_IDENTITIES, maximum);
  const additions = [...record.identities.values()].reduce((total, identity) => {
    return total + ([...state.recentRequested.values()].filter(map => !map.has(identity.canonical)).length);
  }, 0);
  const overBudget = () => memory.recentRequestedIdentities + additions > cacheCap
    || memory.closureIdentities + memory.recentRequestedIdentities + additions > maximum;
  while (overBudget()) {
    let removed = false;
    for (const candidate of states.values()) {
      for (const map of candidate.recentRequested.values()) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) continue;
        map.delete(oldest);
        memory.recentRequestedIdentities -= 1;
        removed = true;
        break;
      }
      if (removed) break;
    }
    if (!removed) return true;
  }
  for (const [name, identity] of record.identities) {
    const map = state.recentRequested.get(name);
    if (!map) throw new RowSetBlocker(`${state.table.key} has an unregistered unique identity`);
    if (!map.has(identity.canonical)) memory.recentRequestedIdentities += 1;
    map.delete(identity.canonical);
    map.set(identity.canonical, record.key.canonical);
  }
  refreshPeak(memory);
  return true;
}

function memoryResult(memory: MemoryState, maximum: number, batch: number): RefreshPlanningMemory {
  return {
    maxPlanningKeys: maximum, planningKeyBatch: batch,
    closureIdentities: memory.closureIdentities,
    recentRequestedIdentities: memory.recentRequestedIdentities,
    peakRetainedKeys: memory.peakRetainedKeys,
    peakFrontierRows: memory.peakFrontierRows,
    peakBufferedRows: memory.peakBufferedRows,
    fullRootKeysRetained: 0,
  };
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
  const batchSize = spec.limits.planningKeyBatch;
  const maximum = spec.limits.maxPlanningKeys;
  const blockers = new Set<string>();
  const states = new Map<string, TableState>();
  for (const table of input.catalog.graph.tables) {
    const closureIdentities = new Map<string, Map<string, string>>();
    const recentRequested = new Map<string, Map<string, string>>();
    for (const unique of table.uniqueKeys) {
      closureIdentities.set(columnSetKey(unique.columns), new Map());
      recentRequested.set(columnSetKey(unique.columns), new Map());
    }
    states.set(table.key, { table, requestedCount: 0, closure: new Set(), closureIdentities, recentRequested });
  }
  const policies = new Map<string, RefreshTablePolicy>();
  for (const policy of spec.tables) {
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') throw new RowSetBlocker(resolved);
    policies.set(`${resolved.sourceSchema}.${resolved.tableName}`, policy);
  }
  const memory: MemoryState = {
    closureIdentities: 0, recentRequestedIdentities: 0, frontierIdentities: 0,
    peakRetainedKeys: 0, peakFrontierRows: 0, peakBufferedRows: 0,
  };
  let sourceQueries = 0;
  let sourceRowsRead = 0;
  let iterations = 0;
  const progress = (phase: 'requested' | 'closure', table: string) => input.onProgress?.({
    phase, table, queries: sourceQueries, rowsRead: sourceRowsRead,
  });
  const query = async (table: string, sql: string): Promise<Grid> => {
    sourceQueries += 1;
    const grid = await queryGrid(input.runGrid, sessionId, table, sql, batchSize);
    sourceRowsRead += grid.rows.length;
    memory.peakBufferedRows = Math.max(memory.peakBufferedRows, grid.rows.length);
    return grid;
  };

  const processFrontier = async (frontier: { state: TableState; record: RowRecord }[]) => {
    iterations += 1;
    const next: { state: TableState; record: RowRecord }[] = [];
    const groups = new Map<string, {
      child: TableState; parent: TableState; edge: RefreshForeignKeyEdge; requests: Map<string, Scalar[]>;
    }>();
    for (const { state, record } of frontier) {
      for (const edge of outgoing(input.catalog, state.table)) {
        const parentName = `${edge.refSchema}.${edge.refTable}`;
        const parent = states.get(parentName);
        if (!parent) throw new RowSetBlocker(`${state.table.key}.${edge.name} has no loaded parent ${parentName}`);
        const values = record.references.get(edge.key);
        if (!values) throw new RowSetBlocker(`${state.table.key}.${edge.name} is missing projected FK columns`);
        if (values.some(value => value === null)) continue;
        const identity = key(values as Scalar[]);
        if (seen(parent, edge, identity)) continue;
        const group = groups.get(edge.key) ?? { child: state, parent, edge, requests: new Map<string, Scalar[]>() };
        group.requests.set(identity.canonical, identity.values);
        groups.set(edge.key, group);
      }
    }
    for (const { child, parent, edge, requests } of groups.values()) {
      const parentName = parent.table.key;
      const identities = [...requests.values()];
      for (let offset = 0; offset < identities.length; offset += batchSize) {
        const batch = identities.slice(offset, offset + batchSize);
        const candidateGrid = await query(parentName, buildRefreshParentLookupSql(parent.table, input.catalog, edge, batch));
        const get = reader(candidateGrid, parentName);
        const policy = policies.get(parentName);
        let requestedMembership = new Set<string>();
        if (policy?.policy === 'full') {
          requestedMembership = new Set(batch.map(values => key(values).canonical));
        } else if (policy && policy.policy !== 'exclude' && policy.policy !== 'generate') {
          const membershipGrid = await query(parentName, buildRefreshMembershipSql({
            spec, policy, table: parent.table, edge, parents: batch,
          }));
          const membershipGet = reader(membershipGrid, parentName);
          requestedMembership = new Set(membershipGrid.rows.map(row => key(edge.parts.map(part => scalar(membershipGet(row, part.refColumn), parentName, part.refColumn, false))).canonical));
        }
        const candidates = new Map<string, RowRecord>();
        for (const row of candidateGrid.rows) {
          const candidate = rowRecord(input.catalog, parent.table, get, row);
          const candidateReference = candidate.identities.get(signature(edge));
          if (!candidateReference) throw new RowSetBlocker(`${parentName} has no unique key matching FK ${edge.name}`);
          if (candidates.has(candidateReference.canonical)) throw new RowSetBlocker(`${parentName} returned duplicate parent identities`);
          candidates.set(candidateReference.canonical, candidate);
        }
        for (const values of batch) {
          const identity = key(values);
          const candidate = candidates.get(identity.canonical);
          if (!candidate) throw new RowSetBlocker(`${child.table.key}.${edge.name} requires a missing parent in ${parentName}; source FK integrity is not assumed`);
          if (parent.closure.has(candidate.key.canonical)) continue;
          if (requestedMembership.has(identity.canonical)) {
            if (rememberRequested(states, parent, candidate, memory, maximum)) next.push({ state: parent, record: candidate });
          } else if (rememberClosure(parent, candidate, memory, maximum)) {
            next.push({ state: parent, record: candidate });
          }
        }
        memory.frontierIdentities = next.length;
        if (next.length > batchSize) throw new RowSetBlocker(`closure frontier exceeds the ${batchSize.toLocaleString()} row batch cap`);
        refreshPeak(memory);
        progress('closure', parentName);
      }
    }
    return next;
  };

  try {
    for (const [tableName, policy] of policies) {
      if (policy.policy === 'generate') {
        blockers.add(`${tableName} uses generate; FK closure cannot be proven before deterministic generation supplies keys`);
        continue;
      }
      if (policy.policy === 'exclude') continue;
      const state = states.get(tableName);
      if (!state) throw new RowSetBlocker(`${tableName} has no source catalog table`);
      let after: Scalar[] | null = null;
      let previousPageFirst: string | null = null;
      for (;;) {
        const grid = await query(tableName, buildRefreshRootPageSql({
          spec, policy, table: state.table, graph: input.catalog, after, batch: batchSize,
        }));
        const get = reader(grid, tableName);
        const page: { state: TableState; record: RowRecord }[] = [];
        let previousIdentity: string | null = null;
        for (const row of grid.rows) {
          const record = rowRecord(input.catalog, state.table, get, row);
          if (record.key.canonical === previousIdentity) throw new RowSetBlocker(`${tableName} returned a duplicate row identity`);
          if (state.closure.has(record.key.canonical)) {
            throw new RowSetBlocker(`${tableName} changed between requested and closure reads; restart with one consistent source snapshot`);
          }
          previousIdentity = record.key.canonical;
          state.requestedCount += 1;
          page.push({ state, record });
        }
        if (page.length > 0) {
          const first = page[0].record.key.canonical;
          if (first === previousPageFirst) throw new RowSetBlocker(`${tableName} repeated a keyset page; refusing an unbounded root loop`);
          previousPageFirst = first;
        }
        memory.frontierIdentities = 0;
        refreshPeak(memory);
        progress('requested', tableName);
        let frontier = page;
        while (frontier.length > 0) frontier = await processFrontier(frontier);
        if (grid.rows.length < batchSize) break;
        after = page[page.length - 1].record.key.values;
      }
    }

    for (const [tableName, policy] of policies) {
      if (policy.policy !== 'row_limit' && policy.policy !== 'sample') continue;
      if (policy.limitKind !== 'hard') continue;
      const state = states.get(tableName);
      const final = (state?.requestedCount ?? 0) + (state?.closure.size ?? 0);
      if (final > policy.rows) {
        blockers.add(`${tableName} hard maximum ${policy.rows.toLocaleString()} is exceeded by FK closure: ${final.toLocaleString()} rows would be required; refusing to orphan dependent selections`);
      }
    }
    const tables = input.catalog.tables.map(compatibility => {
      const state = compatibility.source ? states.get(compatibility.source) : undefined;
      if (compatibility.action === 'generate') {
        return { table: compatibility.table, action: compatibility.action, requested: null, closureAdded: null, final: null, notes: ['Generated keys do not exist yet; counts and FK closure are not proven'] };
      }
      const requested = state?.requestedCount ?? 0;
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
      return { table: compatibility.table, action: compatibility.action, requested, closureAdded, final, notes };
    });
    const sum = (field: 'requested' | 'closureAdded' | 'final') => blockers.size > 0 || tables.some(table => table[field] === null)
      ? null : tables.reduce((total, table) => total + (table[field] ?? 0), 0);
    return {
      readOnly: true, specSha256: expectedHash, fixedPoint: blockers.size === 0, iterations,
      sourceQueries, sourceRowsRead, tables,
      totals: { requested: sum('requested'), closureAdded: sum('closureAdded'), final: sum('final') },
      memory: memoryResult(memory, maximum, batchSize), blockers: [...blockers].sort(),
    };
  } catch (error) {
    const message = error instanceof RowSetBlocker ? error.message : 'row-set planning failed without exposing row values';
    blockers.add(message);
    const tables = input.catalog.tables.map(compatibility => {
      const state = compatibility.source ? states.get(compatibility.source) : undefined;
      const requested = state?.requestedCount ?? 0;
      const closureAdded = state?.closure.size ?? 0;
      return {
        table: compatibility.table, action: compatibility.action, requested, closureAdded,
        final: requested + closureAdded, notes: ['Partial counts before the blocker; not an executable row-set plan'],
      };
    });
    return {
      readOnly: true, specSha256: expectedHash, fixedPoint: false, iterations,
      sourceQueries, sourceRowsRead, tables,
      totals: { requested: null, closureAdded: null, final: null },
      memory: memoryResult(memory, maximum, batchSize), blockers: [...blockers].sort(),
    };
  }
}
