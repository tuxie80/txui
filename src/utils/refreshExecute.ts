import { buildRefreshPolicySql, resolveRefreshTable } from './refreshPlan.ts';
import type { RefreshTimeColumn } from './refreshPlan.ts';
import type { RefreshCatalogAnalysis, RefreshGraphTable } from './refreshCatalog.ts';
import type { RefreshExecutionPlan } from './refreshExecution.ts';
import type { RefreshMaskPlan } from './refreshMask.ts';
import type { RefreshSpec, RefreshTablePolicy } from './refreshSpec.ts';

export type RefreshRunStatus = 'completed' | 'cancelled' | 'failed' | 'uncertain';

export interface RefreshProgressState {
  runKey: string | null;
  phase: 'idle' | 'starting' | 'planning' | 'copying' | 'done';
  status: RefreshRunStatus | null;
  table: string | null;
  tableIndex: number;
  tableCount: number;
  keyRowsRead: number;
  sourceRowsRead: number;
  plannedRows: number | null;
  committedRows: number;
  inFlightRows: number;
  remainingRows: number | null;
  chunksCommitted: number;
  sourceBytesRead: number;
  targetBytesWritten: number;
  sourceBackendId: number | null;
  targetBackendId: number | null;
  requestedRows: number | null;
  closureRows: number | null;
  elapsedMs: number;
  error: string | null;
}

export function initialRefreshProgress(): RefreshProgressState {
  return {
    runKey: null, phase: 'idle', status: null, table: null, tableIndex: 0, tableCount: 0,
    keyRowsRead: 0, sourceRowsRead: 0, plannedRows: null, committedRows: 0, inFlightRows: 0,
    remainingRows: null, chunksCommitted: 0, sourceBytesRead: 0, targetBytesWritten: 0,
    sourceBackendId: null, targetBackendId: null, requestedRows: null, closureRows: null,
    elapsedMs: 0, error: null,
  };
}

export interface RefreshExecutionEvent {
  type: 'started' | 'progress' | 'done';
  run_key: string;
  phase?: 'starting' | 'planning' | 'copying';
  status?: RefreshRunStatus;
  table?: string | null;
  table_index?: number;
  table_count?: number;
  key_rows_read?: number;
  source_rows_read?: number;
  planned_rows?: number | null;
  committed_rows?: number;
  in_flight_rows?: number;
  remaining_rows?: number | null;
  chunks_committed?: number;
  source_bytes_read?: number;
  target_bytes_written?: number;
  source_backend_id?: number;
  target_backend_id?: number;
  requested_rows?: number | null;
  closure_rows?: number | null;
  elapsed_ms?: number;
  error?: string | null;
}

export function applyRefreshExecutionEvent(
  state: RefreshProgressState, event: RefreshExecutionEvent,
): RefreshProgressState {
  const next = { ...state, runKey: event.run_key };
  if (event.type === 'done') {
    return {
      ...next, phase: 'done', status: event.status ?? 'failed',
      table: event.table ?? null, tableIndex: event.table_index ?? next.tableIndex,
      tableCount: event.table_count ?? next.tableCount,
      keyRowsRead: event.key_rows_read ?? next.keyRowsRead,
      sourceRowsRead: event.source_rows_read ?? next.sourceRowsRead,
      plannedRows: event.planned_rows ?? next.plannedRows,
      committedRows: event.committed_rows ?? next.committedRows,
      inFlightRows: event.in_flight_rows ?? 0,
      remainingRows: event.remaining_rows ?? next.remainingRows,
      chunksCommitted: event.chunks_committed ?? next.chunksCommitted,
      sourceBytesRead: event.source_bytes_read ?? next.sourceBytesRead,
      targetBytesWritten: event.target_bytes_written ?? next.targetBytesWritten,
      requestedRows: event.requested_rows ?? next.requestedRows,
      closureRows: event.closure_rows ?? next.closureRows,
      elapsedMs: event.elapsed_ms ?? next.elapsedMs,
      error: event.error ?? null,
    };
  }
  return {
    ...next,
    phase: event.type === 'started' ? 'starting' : event.phase ?? next.phase,
    table: event.table === undefined ? next.table : event.table,
    tableIndex: event.table_index ?? next.tableIndex,
    tableCount: event.table_count ?? next.tableCount,
    keyRowsRead: event.key_rows_read ?? next.keyRowsRead,
    sourceRowsRead: event.source_rows_read ?? next.sourceRowsRead,
    plannedRows: event.planned_rows === undefined ? next.plannedRows : event.planned_rows,
    committedRows: event.committed_rows ?? next.committedRows,
    inFlightRows: event.in_flight_rows ?? next.inFlightRows,
    remainingRows: event.remaining_rows === undefined ? next.remainingRows : event.remaining_rows,
    chunksCommitted: event.chunks_committed ?? next.chunksCommitted,
    sourceBytesRead: event.source_bytes_read ?? next.sourceBytesRead,
    targetBytesWritten: event.target_bytes_written ?? next.targetBytesWritten,
    sourceBackendId: event.source_backend_id ?? next.sourceBackendId,
    targetBackendId: event.target_backend_id ?? next.targetBackendId,
    requestedRows: event.requested_rows === undefined ? next.requestedRows : event.requested_rows,
    closureRows: event.closure_rows === undefined ? next.closureRows : event.closure_rows,
    elapsedMs: event.elapsed_ms ?? next.elapsedMs,
  };
}

function temporalType(table: RefreshGraphTable, policy: RefreshTablePolicy): RefreshTimeColumn {
  if (policy.policy !== 'time_window') return 'datetime';
  const type = table.columns.find(column => column.name === policy.column)?.dataType.toLowerCase();
  if (type === 'date' || type === 'datetime' || type === 'timestamp') return type;
  throw new Error(`${table.key}.${policy.column} has no proven temporal type`);
}

function projection(catalog: RefreshCatalogAnalysis, table: RefreshGraphTable): string[] {
  return [...new Set([
    ...table.uniqueKeys.flatMap(unique => unique.columns),
    ...catalog.graph.foreignKeys.filter(edge => edge.schema === table.schema && edge.table === table.name)
      .flatMap(edge => edge.parts.map(part => part.column)),
  ])];
}

export function buildRefreshExecutionInput(input: {
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
  executionPlan: RefreshExecutionPlan;
  maskPlan: RefreshMaskPlan;
  runKey: string;
  productionConfirmation: string | null;
}): Record<string, unknown> {
  const { spec, catalog, executionPlan, maskPlan } = input;
  if (!executionPlan.executable || !catalog.complete || !maskPlan.complete) {
    throw new Error('Refresh execution requires complete catalog, row-set, insertion-order and mask proofs');
  }
  if (executionPlan.specSha256 !== maskPlan.specSha256 || executionPlan.catalogSha256 !== maskPlan.catalogSha256) {
    throw new Error('Refresh execution evidence belongs to different specification or catalog hashes');
  }
  const policies = new Map<string, RefreshTablePolicy>();
  for (const policy of spec.tables) {
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') throw new Error(resolved);
    policies.set(`${resolved.sourceSchema}.${resolved.tableName}`, policy);
  }
  const selected = new Set(executionPlan.insertionOrder);
  if (selected.size !== executionPlan.insertionOrder.length || selected.size === 0) {
    throw new Error('Refresh insertion order is empty or contains duplicate tables');
  }
  const tables = executionPlan.insertionOrder.map(sourceKey => {
    const source = catalog.graph.tables.find(table => table.key === sourceKey);
    const compatibility = catalog.tables.find(table => table.source === sourceKey);
    const execution = executionPlan.tables.find(table => table.sourceSchema === source?.schema && table.table === compatibility?.table);
    if (!source || !compatibility?.target || !execution || execution.keyColumns.length === 0 || execution.batchRows < 1) {
      throw new Error(`${sourceKey} has no executable source/target/key mapping`);
    }
    const targetSchema = compatibility.target.split('.').slice(0, -1).join('.');
    const policy = policies.get(sourceKey);
    const projected = projection(catalog, source);
    const rootSql = policy && policy.policy !== 'exclude' && policy.policy !== 'generate'
      ? buildRefreshPolicySql(spec, policy, source.schema, temporalType(source, policy), projected) : null;
    if (!rootSql && compatibility.action !== 'dependency') throw new Error(`${sourceKey} has no executable root selection`);
    return {
      source_schema: source.schema, target_schema: targetSchema, table: source.name,
      action: compatibility.action, root_sql: rootSql,
      policy: policy?.policy ?? 'dependency',
      hard_limit: policy && (policy.policy === 'row_limit' || policy.policy === 'sample') && policy.limitKind === 'hard' ? policy.rows : null,
      key_columns: execution.keyColumns,
      unique_keys: source.uniqueKeys,
      batch_rows: execution.batchRows,
      columns: source.columns.map(column => ({
        name: column.name, data_type: column.dataType, column_type: column.columnType,
        nullable: column.nullable, collation: column.collation, charset: column.charset,
        char_max_len: column.charMaxLen, generation_expression: column.generationExpression ?? null,
        extra: column.extra,
      })),
      indexes: source.indexes.map(index => ({
        name: index.name, unique: index.unique, columns: [...index.columns].sort((a, b) => a.seq - b.seq)
          .map(column => ({ name: column.name, seq: column.seq, sub_part: column.subPart })),
      })),
    };
  });
  const foreignKeys = catalog.graph.foreignKeys.filter(edge => selected.has(`${edge.schema}.${edge.table}`)).map(edge => ({
    key: edge.key, name: edge.name, schema: edge.schema, table: edge.table,
    ref_schema: edge.refSchema, ref_table: edge.refTable,
    parts: edge.parts.map(part => ({ ordinal: part.ordinal, column: part.column, ref_column: part.refColumn, nullable: part.nullable })),
  }));
  const maskTables = tables.map(table => ({
    name: `${table.source_schema}.${table.table}`,
    columns: table.columns.map(column => ({
      name: column.name, data_type: column.data_type, collation: column.collation,
      char_max_len: column.char_max_len, generation_expression: column.generation_expression,
      extra: column.extra,
    })),
    indexes: table.indexes.filter(index => index.unique || index.name === 'PRIMARY').map(index => ({
      name: index.name, unique: index.unique || index.name === 'PRIMARY', columns: index.columns.map(column => column.name),
    })),
  }));
  const rules = maskPlan.rules.filter(rule => selected.has(rule.table)).map(rule => {
    const source = spec.masks.find(mask => {
      if (mask.column !== rule.column) return false;
      const resolved = resolveRefreshTable(spec, mask.table);
      return typeof resolved !== 'string' && `${resolved.sourceSchema}.${resolved.tableName}` === rule.table;
    });
    return {
      table: rule.table, column: rule.column, rule: rule.rule, generator: rule.generator,
      value: source?.rule === 'constant' ? source.value : null, relation: rule.relation,
    };
  });
  const relations = foreignKeys.flatMap(edge => edge.parts.flatMap(part => [
    { relation: `${edge.key}:${part.ordinal}`, table: `${edge.schema}.${edge.table}`, column: part.column },
    { relation: `${edge.key}:${part.ordinal}`, table: `${edge.ref_schema}.${edge.ref_table}`, column: part.ref_column },
  ]));
  const preflightTables = spec.tables.filter(policy => policy.policy !== 'exclude' && policy.policy !== 'generate').map(policy => {
    const resolved = resolveRefreshTable(spec, policy.table);
    if (typeof resolved === 'string') throw new Error(resolved);
    return { source_schema: resolved.sourceSchema, target_schema: resolved.targetSchema, table: resolved.tableName };
  });
  return {
    run_key: input.runKey,
    expected_catalog_sha256: executionPlan.catalogSha256,
    expected_row_set_sha256: executionPlan.rowSetSha256,
    max_chunk_bytes: spec.limits.maxBytesPerChunk,
    planning_key_batch: spec.limits.planningKeyBatch,
    max_planning_keys: spec.limits.maxPlanningKeys,
    preflight: {
      source_session_id: spec.source.sessionId, target_session_id: spec.target.sessionId,
      source_connection_id: spec.source.connectionId, target_connection_id: spec.target.connectionId,
      spec_sha256: executionPlan.specSha256, production_confirmation: input.productionConfirmation,
      tables: preflightTables,
    },
    tables, foreign_keys: foreignKeys,
    mask: {
      seed: spec.seed, rules, tables: maskTables, relations, rows: [],
      allow_fk_breaking: spec.allowFkBreaking,
      acknowledge_unmasked_sensitive: spec.acknowledgeUnmaskedSensitive ?? false,
      committed_scope: { committed_rows: 0, in_flight_rows: 0 },
      max_unique_keys: spec.limits.maxPlanningKeys,
    },
  };
}
