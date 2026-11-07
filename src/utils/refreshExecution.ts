import { sha256Hex } from './datagenStandards.ts';
import { buildRefreshPlan, resolveRefreshTable } from './refreshPlan.ts';
import { buildRefreshRootPageSql } from './refreshRowSets.ts';
import type { RefreshRowSetPlan } from './refreshRowSets.ts';
import type {
  RefreshCatalogAnalysis, RefreshGraphTable,
} from './refreshCatalog.ts';
import type { RefreshSpec, RefreshTablePolicy } from './refreshSpec.ts';
import { planChunks } from './syncChunk.ts';
import type { IndexMeta } from './syncChunk.ts';

export interface RefreshExecutionTable {
  table: string;
  action: RefreshTablePolicy['policy'] | 'dependency';
  sourceSchema: string;
  targetSchema: string;
  keySource: string;
  keyColumns: string[];
  batchRows: number;
  requestedRows: number;
  closureRows: number;
  selectedRows: number;
  estimatedDataBatches: number;
  estimatedChunkBytes: number | null;
  sourceStatsRows: number | null;
  firstPageSql: string | null;
  notes: string[];
}

export interface RefreshExecutionPlan {
  version: 1;
  readOnly: true;
  executable: boolean;
  specSha256: string;
  catalogSha256: string;
  rowSetSha256: string;
  insertionOrder: string[];
  tables: RefreshExecutionTable[];
  blockers: string[];
}

function hash(value: unknown): string {
  return sha256Hex(Array.from(new TextEncoder().encode(JSON.stringify(value))));
}

export function refreshCatalogSha256(catalog: RefreshCatalogAnalysis): string {
  return hash(catalog.graph.tables.map(table => ({
    schema: table.schema, name: table.name,
    columns: table.columns.map(column => [
      column.name, column.dataType, column.columnType, column.nullable, column.charset, column.collation,
      column.charMaxLen, column.extra, column.generationExpression,
    ]),
    indexes: table.indexes.map(index => [
      index.name, index.unique, index.type,
      index.columns.map(column => [column.name, column.seq, column.subPart]),
    ]),
    foreignKeys: catalog.graph.foreignKeys.filter(edge => edge.schema === table.schema && edge.table === table.name)
      .map(edge => [edge.name, edge.refSchema, edge.refTable, edge.onDelete, edge.onUpdate,
        edge.parts.map(part => [part.ordinal, part.column, part.refColumn, part.nullable])]),
  })));
}

export function refreshRowSetSha256(rowSets: RefreshRowSetPlan): string {
  return hash({
    specSha256: rowSets.specSha256,
    fixedPoint: rowSets.fixedPoint,
    totals: rowSets.totals,
    tables: rowSets.tables.map(table => [table.table, table.action, table.requested, table.closureAdded, table.final]),
    blockers: rowSets.blockers,
  });
}

function indexes(table: RefreshGraphTable): IndexMeta[] {
  const nullable = new Set(table.columns.filter(column => column.nullable).map(column => column.name));
  return table.uniqueKeys.map(unique => ({
    name: unique.name, unique: true, columns: unique.columns,
    nullable: unique.columns.some(column => nullable.has(column)),
  }));
}

function insertionOrder(catalog: RefreshCatalogAnalysis): { order: string[]; blockers: string[] } {
  const selected = new Set(catalog.tables.filter(table => table.action !== 'exclude' && table.action !== 'generate' && table.source).map(table => table.source!));
  const remaining = new Set(selected);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(tableName => {
      const table = catalog.graph.tables.find(candidate => candidate.key === tableName);
      if (!table) return false;
      return catalog.graph.foreignKeys
        .filter(edge => edge.schema === table.schema && edge.table === table.name)
        .every(edge => !remaining.has(`${edge.refSchema}.${edge.refTable}`));
    }).sort();
    if (ready.length === 0) {
      return {
        order: [],
        blockers: [`insertion order cannot be proven for self/cyclic dependencies: ${[...remaining].sort().join(', ')}; R4.3 must prove a strategy before execution`],
      };
    }
    for (const tableName of ready) {
      order.push(tableName);
      remaining.delete(tableName);
    }
  }
  return { order, blockers: [] };
}

export function buildRefreshExecutionPlan(input: {
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
  rowSets: RefreshRowSetPlan;
}): RefreshExecutionPlan {
  const { spec, catalog, rowSets } = input;
  const specSha256 = buildRefreshPlan(spec).specSha256;
  const catalogSha256 = refreshCatalogSha256(catalog);
  const rowSetSha256 = refreshRowSetSha256(rowSets);
  const blockers = new Set<string>();
  if (!catalog.complete) blockers.add('catalog compatibility is incomplete');
  if (catalog.plan.specSha256 !== specSha256 || rowSets.specSha256 !== specSha256) blockers.add('specification changed between catalog and row-set planning');
  if (!rowSets.fixedPoint) blockers.add('row-set planning has not reached a clean fixed point');
  const ordering = insertionOrder(catalog);
  for (const blocker of ordering.blockers) blockers.add(blocker);
  const policies = new Map<string, RefreshTablePolicy>();
  for (const policy of spec.tables) {
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') {
      blockers.add(resolved);
      continue;
    }
    policies.set(`${resolved.sourceSchema}.${resolved.tableName}`, policy);
  }
  const tables = catalog.tables.map(compatibility => {
    const sourceName = compatibility.source ?? compatibility.table;
    const source = catalog.graph.tables.find(table => table.key === sourceName);
    const counts = rowSets.tables.find(table => table.table === compatibility.table);
    const requestedRows = counts?.requested ?? 0;
    const closureRows = counts?.closureAdded ?? 0;
    const selectedValue = counts?.final ?? requestedRows + closureRows;
    if (selectedValue === null) blockers.add(`${compatibility.table} has unknown selected-row counts`);
    const selectedRows = selectedValue ?? 0;
    if (!source) {
      if (compatibility.action !== 'exclude' && compatibility.action !== 'generate') blockers.add(`${sourceName} has no source table for execution planning`);
      return {
        table: compatibility.table, action: compatibility.action,
        sourceSchema: '', targetSchema: '', keySource: '', keyColumns: [], batchRows: 0,
        requestedRows, closureRows, selectedRows, estimatedDataBatches: 0, estimatedChunkBytes: null,
        sourceStatsRows: null, firstPageSql: null, notes: ['No source table is available'],
      };
    }
    const estimatedRows = source.estimatedRows;
    const avgRowLength = source.dataBytes != null && estimatedRows != null && estimatedRows > 0
      ? Math.max(1, Math.round(source.dataBytes! / estimatedRows)) : null;
    const chunks = planChunks({
      schema: source.schema, name: source.name,
      estimatedRows: selectedRows,
      avgRowLength,
      indexes: indexes(source),
    }, {
      softCapRows: spec.limits.maxRowsPerChunk,
      chunkBytes: spec.limits.maxBytesPerChunk,
    });
    if (chunks.strategy !== 'keyset' || !chunks.keySource) blockers.add(`${source.key} has no unique NOT-NULL keyset boundary`);
    const batchRows = Math.min(spec.limits.planningKeyBatch, chunks.rowsPerChunk);
    const policy = policies.get(source.key);
    const firstPageSql = policy && batchRows > 0 ? buildRefreshRootPageSql({
      spec, policy, table: source, graph: catalog, after: null, batch: batchRows,
    }) : null;
    if (compatibility.action !== 'dependency' && compatibility.action !== 'exclude' && compatibility.action !== 'generate' && !firstPageSql) {
      blockers.add(`${source.key} has no exact root-page query`);
    }
    return {
      table: compatibility.table, action: compatibility.action,
      sourceSchema: source.schema, targetSchema: spec.schemaMappings.find(mapping => mapping.source === source.schema)?.target ?? '',
      keySource: chunks.keySource ?? '', keyColumns: chunks.keyColumns,
      batchRows, requestedRows, closureRows, selectedRows,
      estimatedDataBatches: selectedRows === 0 ? 0 : Math.ceil(selectedRows / Math.max(1, batchRows)),
      estimatedChunkBytes: avgRowLength == null ? null : avgRowLength * batchRows,
      sourceStatsRows: estimatedRows,
      firstPageSql,
      notes: [
        chunks.note,
        'Batch estimates describe exact selected-row counts; source statistics are estimates and are not progress denominators',
        'Subsequent pages require the previous page’s unique key values; OFFSET is never used',
      ],
    };
  });
  return {
    version: 1, readOnly: true, executable: blockers.size === 0,
    specSha256, catalogSha256, rowSetSha256,
    insertionOrder: ordering.order, tables, blockers: [...blockers].sort(),
  };
}

export function validateRefreshExecutionPlan(input: {
  plan: RefreshExecutionPlan;
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
  rowSets: RefreshRowSetPlan;
}): string[] {
  const blockers: string[] = [];
  if (input.plan.specSha256 !== buildRefreshPlan(input.spec).specSha256) blockers.push('specification hash changed');
  if (input.plan.catalogSha256 !== refreshCatalogSha256(input.catalog)) blockers.push('source schema/catalog changed');
  if (input.plan.rowSetSha256 !== refreshRowSetSha256(input.rowSets)) blockers.push('requested/closure row sets changed');
  if (!input.catalog.complete || !input.rowSets.fixedPoint) blockers.push('current catalog or row-set proof is incomplete');
  return blockers;
}
