import { reviewTypesEqual } from './changeReview.ts';
import { buildRefreshPlan, resolveRefreshTable } from './refreshPlan.ts';
import type { RefreshPlan, RefreshTimeColumn } from './refreshPlan.ts';
import { parseRefreshSpec } from './refreshSpec.ts';
import type { RefreshSpec, RefreshTablePolicy } from './refreshSpec.ts';
import { MYSQL_SNAPSHOT_SQL, buildSnapshot } from './schemaCollect.ts';
import type { Grid } from './schemaCollect.ts';
import type {
  CatalogColumn, CatalogFk, CatalogIndex, SchemaSnapshot,
} from './schemaRules.ts';

export interface RefreshUniqueKey {
  name: string;
  columns: string[];
}

export interface RefreshGraphTable {
  key: string;
  schema: string;
  name: string;
  columns: CatalogColumn[];
  indexes: CatalogIndex[];
  primaryKey: RefreshUniqueKey | null;
  uniqueKeys: RefreshUniqueKey[];
  generatedColumns: string[];
  estimatedRows: number | null;
  dataBytes: number | null;
}

export interface RefreshForeignKeyPart {
  ordinal: number;
  column: string;
  refColumn: string;
  nullable: boolean;
}

export interface RefreshForeignKeyEdge {
  key: string;
  name: string;
  schema: string;
  table: string;
  refSchema: string;
  refTable: string;
  parts: RefreshForeignKeyPart[];
  nullable: boolean;
  selfReference: boolean;
  external: boolean;
  onDelete: string;
  onUpdate: string;
}

export interface RefreshCatalogGraph {
  tables: RefreshGraphTable[];
  foreignKeys: RefreshForeignKeyEdge[];
  cycles: string[][];
  blockers: string[];
}

export interface RefreshCompatibilityTable {
  table: string;
  action: RefreshTablePolicy['policy'] | 'dependency';
  source: string | null;
  target: string | null;
  key: RefreshUniqueKey | null;
  generatedColumns: string[];
  notes: string[];
  blockers: string[];
}

export interface RefreshCatalogAnalysis {
  plan: RefreshPlan;
  graph: RefreshCatalogGraph;
  tables: RefreshCompatibilityTable[];
  blockers: string[];
  complete: boolean;
  scanned: {
    sourceSchemas: number;
    targetSchemas: number;
    sourceTables: number;
    targetTables: number;
    foreignKeys: number;
    selfReferences: number;
    cycles: number;
  };
}

export type RefreshGridRunner = (sessionId: string, sql: string) => Promise<Grid | null>;

const tableKey = (schema: string, table: string) => `${schema}.${table}`;
const internalKey = (schema: string, table: string) => `${schema}\u0000${table}`;
const generated = (column: CatalogColumn) => column.generationExpression != null || /\bgenerated\b/i.test(column.extra);
const generatedStorage = (column: CatalogColumn) => /\bvirtual\b/i.test(column.extra) ? 'VIRTUAL' : 'STORED';
const normalizedExpression = (column: CatalogColumn) => (column.generationExpression ?? '').replace(/\s+/g, ' ').trim();
const normalizedName = (value: string | null) => value?.toLowerCase() ?? null;

function graphTableMap(graph: RefreshCatalogGraph): Map<string, RefreshGraphTable> {
  return new Map(graph.tables.map(table => [internalKey(table.schema, table.name), table]));
}

function usableUniqueKeys(columns: CatalogColumn[], indexes: CatalogIndex[]): RefreshUniqueKey[] {
  const byName = new Map(columns.map(column => [column.name, column]));
  const keys: RefreshUniqueKey[] = [];
  for (const index of indexes) {
    const ordered = [...index.columns].sort((a, b) => a.seq - b.seq);
    const primary = index.name === 'PRIMARY';
    if ((!index.unique && !primary) || ordered.length === 0 || ordered.some(column => column.subPart != null)) continue;
    if (ordered.some(column => !byName.get(column.name) || byName.get(column.name)!.nullable)) continue;
    keys.push({ name: index.name, columns: ordered.map(column => column.name) });
  }
  return keys.sort((a, b) => a.name === 'PRIMARY' ? -1 : b.name === 'PRIMARY' ? 1 : a.name.localeCompare(b.name));
}

function canonicalCycle(cycle: string[]): string {
  const values = cycle.map(value => value.split('\u0000').join('.'));
  let best = 0;
  for (let index = 1; index < values.length; index++) {
    if (values[index].localeCompare(values[best]) < 0) best = index;
  }
  return [...values.slice(best), ...values.slice(0, best)].join(' -> ');
}

function findCycles(graph: RefreshCatalogGraph): string[][] {
  const outgoing = new Map<string, string[]>();
  for (const table of graph.tables) outgoing.set(internalKey(table.schema, table.name), []);
  for (const edge of graph.foreignKeys) {
    const child = internalKey(edge.schema, edge.table);
    const parent = internalKey(edge.refSchema, edge.refTable);
    if (outgoing.has(child) && outgoing.has(parent)) outgoing.get(child)!.push(parent);
  }
  for (const parents of outgoing.values()) parents.sort();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (node: string) => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const parent of outgoing.get(node) ?? []) {
      if (state.get(parent) === 'visiting') {
        const start = stack.indexOf(parent);
        cycles.add(canonicalCycle(stack.slice(start)));
      } else if (!state.has(parent)) {
        visit(parent);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of [...outgoing.keys()].sort()) {
    if (!state.has(node)) visit(node);
  }
  return [...cycles].sort().map(cycle => cycle.split(' -> '));
}

export function buildRefreshGraph(snapshots: SchemaSnapshot[]): RefreshCatalogGraph {
  const blockers = new Set<string>();
  const tables: RefreshGraphTable[] = [];
  const byKey = new Map<string, RefreshGraphTable>();
  const schemas = new Set<string>();
  for (const snapshot of snapshots) {
    if (schemas.has(snapshot.schema)) blockers.add(`duplicate catalog for schema ${snapshot.schema}`);
    schemas.add(snapshot.schema);
    for (const table of snapshot.tables) {
      const key = internalKey(snapshot.schema, table.name);
      if (byKey.has(key)) {
        blockers.add(`duplicate source table ${tableKey(snapshot.schema, table.name)}`);
        continue;
      }
      const value: RefreshGraphTable = {
        key: tableKey(snapshot.schema, table.name), schema: snapshot.schema, name: table.name,
        columns: [], indexes: [], primaryKey: null, uniqueKeys: [], generatedColumns: [], estimatedRows: table.rows,
        dataBytes: table.dataBytes,
      };
      byKey.set(key, value);
      tables.push(value);
    }
  }
  for (const snapshot of snapshots) {
    for (const column of snapshot.columns) {
      const table = byKey.get(internalKey(snapshot.schema, column.table));
      if (!table) {
        blockers.add(`column ${snapshot.schema}.${column.table}.${column.name} has no catalog table`);
        continue;
      }
      if (table.columns.some(existing => existing.name === column.name)) {
        blockers.add(`duplicate column ${table.key}.${column.name}`);
        continue;
      }
      table.columns.push(column);
    }
    for (const index of snapshot.indexes) {
      const table = byKey.get(internalKey(snapshot.schema, index.table));
      if (!table) {
        blockers.add(`index ${snapshot.schema}.${index.table}.${index.name} has no catalog table`);
        continue;
      }
      table.indexes.push(index);
    }
  }
  for (const table of tables) {
    table.uniqueKeys = usableUniqueKeys(table.columns, table.indexes);
    table.primaryKey = table.uniqueKeys.find(key => key.name === 'PRIMARY') ?? null;
    table.generatedColumns = table.columns.filter(generated).map(column => column.name);
  }
  const grouped = new Map<string, CatalogFk[]>();
  for (const snapshot of snapshots) {
    for (const fk of snapshot.foreignKeys) {
      const schema = fk.schema ?? snapshot.schema;
      const refSchema = fk.refSchema ?? snapshot.schema;
      const key = internalKey(schema, fk.table) + `\u0000${fk.name}\u0000${internalKey(refSchema, fk.refTable)}`;
      const list = grouped.get(key) ?? [];
      list.push({ ...fk, schema, refSchema });
      grouped.set(key, list);
    }
  }
  const foreignKeys: RefreshForeignKeyEdge[] = [];
  for (const [key, parts] of grouped) {
    const ordered = [...parts].sort((a, b) => a.ordinal - b.ordinal);
    const first = ordered[0];
    const schema = first.schema!;
    const refSchema = first.refSchema!;
    const child = byKey.get(internalKey(schema, first.table));
    const parent = byKey.get(internalKey(refSchema, first.refTable));
    const ordinals = ordered.map(part => part.ordinal);
    if (new Set(ordinals).size !== ordinals.length || ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      blockers.add(`foreign key ${schema}.${first.table}.${first.name} has duplicate or non-contiguous ordinals`);
    }
    const mappedParts = ordered.map(part => {
      const column = child?.columns.find(candidate => candidate.name === part.column);
      const referenced = parent?.columns.find(candidate => candidate.name === part.refColumn);
      if (!column) blockers.add(`foreign key ${schema}.${first.table}.${first.name} references missing child column ${part.column}`);
      if (!referenced && parent) blockers.add(`foreign key ${schema}.${first.table}.${first.name} references missing parent column ${refSchema}.${first.refTable}.${part.refColumn}`);
      return { ordinal: part.ordinal, column: part.column, refColumn: part.refColumn, nullable: column?.nullable ?? false };
    });
    foreignKeys.push({
      key, name: first.name, schema, table: first.table, refSchema, refTable: first.refTable,
      parts: mappedParts, nullable: mappedParts.some(part => part.nullable),
      selfReference: schema === refSchema && first.table === first.refTable,
      external: !parent, onDelete: first.onDelete, onUpdate: first.onUpdate,
    });
  }
  tables.sort((a, b) => a.key.localeCompare(b.key));
  foreignKeys.sort((a, b) => a.key.localeCompare(b.key));
  const graph: RefreshCatalogGraph = { tables, foreignKeys, cycles: [], blockers: [...blockers].sort() };
  graph.cycles = findCycles(graph);
  return graph;
}

function sameKey(key: RefreshUniqueKey, columns: string[]): boolean {
  return key.columns.length === columns.length && key.columns.every(column => columns.includes(column));
}

function compareColumns(source: RefreshGraphTable, target: RefreshGraphTable): string[] {
  const blockers: string[] = [];
  const targetColumns = new Map(target.columns.map(column => [column.name, column]));
  const sourceColumns = new Map(source.columns.map(column => [column.name, column]));
  for (const column of source.columns) {
    const other = targetColumns.get(column.name);
    if (!other) {
      blockers.push(`${target.key} is missing column ${column.name}`);
      continue;
    }
    const rawType = column.columnType || column.dataType;
    const targetType = other.columnType || other.dataType;
    const exactSetType = /^(?:enum|set)\s*\(/i.test(rawType);
    if (exactSetType ? rawType.replace(/\s+/g, ' ').trim() !== targetType.replace(/\s+/g, ' ').trim()
      : !reviewTypesEqual(rawType, targetType, 'mysql')) {
      blockers.push(`${source.key}.${column.name} type ${rawType} is incompatible with ${target.key}.${targetType}`);
    }
    if (column.nullable !== other.nullable) {
      blockers.push(`${source.key}.${column.name} nullability differs from ${target.key}`);
    }
    if (normalizedName(column.charset) !== normalizedName(other.charset)
        || normalizedName(column.collation) !== normalizedName(other.collation)
        || (column.charMaxLen ?? null) !== (other.charMaxLen ?? null)) {
      blockers.push(`${source.key}.${column.name} character width/charset/collation differs from ${target.key}`);
    }
    if (generated(column) !== generated(other)) {
      blockers.push(`${source.key}.${column.name} generated-column behavior differs from ${target.key}`);
    } else if (generated(column) && (column.generationExpression == null || other.generationExpression == null)) {
      blockers.push(`${source.key}.${column.name} generated expression metadata is incomplete`);
    } else if (generated(column) && (generatedStorage(column) !== generatedStorage(other)
        || normalizedExpression(column) !== normalizedExpression(other))) {
      blockers.push(`${source.key}.${column.name} generated expression/storage differs from ${target.key}`);
    }
  }
  for (const column of target.columns) {
    if (!sourceColumns.has(column.name)) blockers.push(`${target.key} has unexpected column ${column.name}`);
  }
  return blockers;
}

function fkAction(action: string): string {
  const upper = action.toUpperCase();
  return upper === 'RESTRICT' ? 'NO ACTION' : upper;
}

function fkShape(edge: RefreshForeignKeyEdge): string {
  const ordered = [...edge.parts].sort((a, b) => a.ordinal - b.ordinal);
  return [
    ordered.map(part => part.column).join(','), edge.refSchema, edge.refTable,
    ordered.map(part => part.refColumn).join(','), fkAction(edge.onDelete), fkAction(edge.onUpdate),
  ].join('|');
}

function compareForeignKeys(
  source: RefreshGraphTable,
  target: RefreshGraphTable,
  graph: RefreshCatalogGraph,
  targetGraph: RefreshCatalogGraph,
  spec: RefreshSpec,
): string[] {
  const blockers: string[] = [];
  const sourceEdges = graph.foreignKeys.filter(edge => edge.schema === source.schema && edge.table === source.name);
  const targetEdges = targetGraph.foreignKeys.filter(edge => edge.schema === target.schema && edge.table === target.name);
  const expected = new Set<string>();
  for (const edge of sourceEdges) {
    const mapping = spec.schemaMappings.find(candidate => candidate.source === edge.refSchema);
    if (!mapping) {
      blockers.push(`${source.key} foreign key ${edge.name} references unmapped schema ${edge.refSchema}`);
      continue;
    }
    const mapped = { ...edge, refSchema: mapping.target };
    const shape = fkShape(mapped);
    expected.add(shape);
    if (!targetEdges.some(candidate => fkShape(candidate) === shape)) {
      blockers.push(`${target.key} is missing foreign key equivalent to ${source.key}.${edge.name}`);
    }
  }
  for (const edge of targetEdges) {
    if (!expected.has(fkShape(edge))) blockers.push(`${target.key} has unexpected foreign key ${edge.name}`);
  }
  return blockers;
}

export function analyzeRefreshCatalog(input: {
  spec: RefreshSpec;
  source: SchemaSnapshot[];
  target: SchemaSnapshot[];
}): RefreshCatalogAnalysis {
  const spec = parseRefreshSpec(input.spec);
  const graph = buildRefreshGraph(input.source);
  const targetGraph = buildRefreshGraph(input.target);
  const sourceTables = graphTableMap(graph);
  const targetTables = graphTableMap(targetGraph);
  const timeColumns = new Map<string, RefreshTimeColumn>();
  for (const policy of spec.tables) {
    if (policy.policy !== 'time_window') continue;
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') continue;
    const column = sourceTables.get(internalKey(resolved.sourceSchema, resolved.tableName))?.columns
      .find(candidate => candidate.name === policy.column);
    const dataType = column?.dataType.toLowerCase();
    if (dataType === 'date' || dataType === 'datetime' || dataType === 'timestamp') timeColumns.set(policy.table, dataType);
  }
  const plan = buildRefreshPlan(spec, timeColumns);
  const blockers = new Set<string>([...plan.blockers, ...graph.blockers, ...targetGraph.blockers.map(error => `target: ${error}`)]);
  const tables: RefreshCompatibilityTable[] = [];
  const bySource = new Map<string, RefreshCompatibilityTable>();
  const ensureTable = (policy: RefreshTablePolicy | null, resolved: Exclude<ReturnType<typeof resolveRefreshTable>, string>) => {
    const sourceKey = internalKey(resolved.sourceSchema, resolved.tableName);
    const existing = bySource.get(sourceKey);
    if (existing) return existing;
    const value: RefreshCompatibilityTable = {
      table: tableKey(resolved.sourceSchema, resolved.tableName),
      action: policy?.policy ?? 'dependency', source: tableKey(resolved.sourceSchema, resolved.tableName),
      target: tableKey(resolved.targetSchema, resolved.tableName), key: null, generatedColumns: [], notes: [], blockers: [],
    };
    bySource.set(sourceKey, value);
    tables.push(value);
    return value;
  };
  const required = new Map<string, { policy: RefreshTablePolicy | null; resolved: Exclude<ReturnType<typeof resolveRefreshTable>, string> }>();
  for (const policy of spec.tables) {
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') {
      blockers.add(resolved);
      continue;
    }
    required.set(internalKey(resolved.sourceSchema, resolved.tableName), { policy, resolved });
  }
  const queue = [...required.values()].filter(item => item.policy?.policy !== 'exclude');
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (item.policy?.policy === 'generate') continue;
    for (const edge of graph.foreignKeys.filter(candidate => candidate.schema === item.resolved.sourceSchema && candidate.table === item.resolved.tableName)) {
      const mapping = spec.schemaMappings.find(candidate => candidate.source === edge.refSchema);
      if (!mapping) {
        blockers.add(`${item.resolved.sourceSchema}.${item.resolved.tableName} requires unmapped parent ${edge.refSchema}.${edge.refTable}`);
        continue;
      }
      const parentKey = internalKey(edge.refSchema, edge.refTable);
      if (!required.has(parentKey)) {
        const parent = { policy: null, resolved: { sourceSchema: edge.refSchema, targetSchema: mapping.target, tableName: edge.refTable } };
        required.set(parentKey, parent);
        queue.push(parent);
      } else if (required.get(parentKey)?.policy?.policy === 'exclude') {
        blockers.add(`${tableKey(edge.refSchema, edge.refTable)} is required by ${tableKey(item.resolved.sourceSchema, item.resolved.tableName)} but is excluded`);
      }
    }
  }
  for (const { policy, resolved } of required.values()) {
    const result = ensureTable(policy, resolved);
    if (policy?.policy === 'exclude') {
      result.notes.push('Excluded by policy; no source or target compatibility requirement');
      continue;
    }
    const source = sourceTables.get(internalKey(resolved.sourceSchema, resolved.tableName));
    const target = targetTables.get(internalKey(resolved.targetSchema, resolved.tableName));
    if (!source && policy?.policy !== 'generate') result.blockers.push(`source table ${result.source} does not exist`);
    if (!target) result.blockers.push(`target table ${result.target} does not exist; Refresh does not create schemas or tables`);
    result.key = source?.uniqueKeys[0] ?? target?.uniqueKeys[0] ?? null;
    result.generatedColumns = source?.generatedColumns ?? target?.generatedColumns ?? [];
    if (source && source.uniqueKeys.length === 0) result.blockers.push(`${source.key} has no primary key or complete unique NOT-NULL index`);
    if (target && target.uniqueKeys.length === 0) result.blockers.push(`${target.key} has no primary key or complete unique NOT-NULL index`);
    if (!result.key) result.blockers.push(`${result.table} has no usable source or target key`);
    if (result.generatedColumns.length) result.notes.push(`Generated columns will be omitted from future inserts: ${result.generatedColumns.join(', ')}`);
    if (source && target) {
      result.blockers.push(...compareColumns(source, target));
      result.blockers.push(...compareForeignKeys(source, target, graph, targetGraph, spec));
    }
    if (source && policy) {
      const column = (name: string) => source.columns.find(candidate => candidate.name === name);
      if (policy.policy === 'time_window') {
        const selected = column(policy.column);
        if (!selected) result.blockers.push(`${source.key} has no time-window column ${policy.column}`);
        else if (!['date', 'datetime', 'timestamp'].includes(selected.dataType.toLowerCase())) {
          result.blockers.push(`${source.key}.${policy.column} is ${selected.columnType}; expected DATE, DATETIME or TIMESTAMP`);
        }
      }
      if (policy.policy === 'row_limit' || policy.policy === 'sample') {
        if (policy.tieBreaker.some(name => !column(name))) result.blockers.push(`${source.key} is missing one or more tie-breaker columns`);
        if (!source.uniqueKeys.some(key => sameKey(key, policy.tieBreaker))) {
          result.blockers.push(`${source.key} tie-breaker (${policy.tieBreaker.join(', ')}) is not a complete unique NOT-NULL key`);
        }
      }
      if (policy.policy === 'row_limit') {
        if (policy.orderBy.some(name => !column(name))) result.blockers.push(`${source.key} is missing one or more ordering columns`);
        if (policy.orderBy.some(name => policy.tieBreaker.includes(name))) result.blockers.push(`${source.key} duplicates a column between orderBy and tieBreaker`);
      }
    }
    for (const blocker of result.blockers) blockers.add(blocker);
  }
  tables.sort((a, b) => a.table.localeCompare(b.table));
  return {
    plan, graph, tables, blockers: [...blockers].sort(), complete: blockers.size === 0,
    scanned: {
      sourceSchemas: input.source.length, targetSchemas: input.target.length,
      sourceTables: graph.tables.length, targetTables: targetGraph.tables.length,
      foreignKeys: graph.foreignKeys.length,
      selfReferences: graph.foreignKeys.filter(edge => edge.selfReference).length,
      cycles: graph.cycles.length,
    },
  };
}

async function readMysqlSnapshot(
  sessionId: string,
  schema: string,
  side: 'source' | 'target',
  runGrid: RefreshGridRunner,
  onLog: (message: string) => void,
): Promise<SchemaSnapshot> {
  onLog(`Reading ${side} catalog schema ${schema}; metadata only, no table rows.`);
  const [defaults, tables, columns, indexes, foreignKeys] = await Promise.all([
    runGrid(sessionId, MYSQL_SNAPSHOT_SQL.defaults(schema)),
    runGrid(sessionId, MYSQL_SNAPSHOT_SQL.tables(schema)),
    runGrid(sessionId, MYSQL_SNAPSHOT_SQL.columns(schema)),
    runGrid(sessionId, MYSQL_SNAPSHOT_SQL.indexes(schema)),
    runGrid(sessionId, MYSQL_SNAPSHOT_SQL.foreignKeys(schema)),
  ]);
  if (!defaults || defaults.rows.length !== 1) throw new Error(`${side} schema ${schema} does not exist or is not visible`);
  for (const [name, grid] of Object.entries({ tables, columns, indexes, foreignKeys })) {
    if (!grid) throw new Error(`${side} ${schema} ${name} catalog read failed or was denied`);
    if (grid.truncated) throw new Error(`${side} ${schema} ${name} catalog was truncated; compatibility cannot be proven`);
  }
  const optionalGrid = async (sql: string) => {
    try {
      return await runGrid(sessionId, sql);
    } catch {
      return null;
    }
  };
  let stats = await optionalGrid(MYSQL_SNAPSHOT_SQL.stats(schema));
  let statsSource = 'mysql.innodb_table_stats';
  if (!stats) {
    stats = await optionalGrid(MYSQL_SNAPSHOT_SQL.statsFallback(schema));
    statsSource = 'information_schema.TABLES (estimated)';
  }
  const snapshot = buildSnapshot({ schema, engine: 'mysql', defaults, tables, columns, indexes, foreignKeys, stats, statsSource });
  onLog(`${side} ${schema}: ${snapshot.tables.length} tables, ${snapshot.columns.length} columns, ${snapshot.indexes.length} indexes, ${snapshot.foreignKeys.length} FK parts.`);
  return snapshot;
}

export async function readRefreshCatalogAnalysis(input: {
  spec: RefreshSpec;
  runGrid: RefreshGridRunner;
  onLog?: (message: string) => void;
}): Promise<RefreshCatalogAnalysis> {
  const spec = parseRefreshSpec(input.spec);
  if (!spec.source.sessionId || !spec.target.sessionId || spec.source.sessionId === spec.target.sessionId) {
    throw new Error('choose two different open sessions before reading Refresh catalogs');
  }
  const onLog = input.onLog ?? (() => {});
  const source: SchemaSnapshot[] = [];
  const target: SchemaSnapshot[] = [];
  for (const mapping of spec.schemaMappings) {
    source.push(await readMysqlSnapshot(spec.source.sessionId, mapping.source, 'source', input.runGrid, onLog));
    target.push(await readMysqlSnapshot(spec.target.sessionId, mapping.target, 'target', input.runGrid, onLog));
  }
  return analyzeRefreshCatalog({ spec, source, target });
}
