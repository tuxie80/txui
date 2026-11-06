export const OPERATION_HANDOFF_VERSION = 1;
export const OPEN_MIGRATION_EVENT = 'dbgui:open-migration';
export const OPEN_QUERY_LAB_EVENT = 'dbgui:open-query-lab';
export const MAX_HANDOFF_SQL_BYTES = 16 * 1024 * 1024;

export type SafeOperationEngine = 'mysql' | 'postgres';
export type MigrationOrigin = 'editor' | 'schema-compare' | 'table-designer' | 'query-lab';

export interface MigrationHandoff {
  version: typeof OPERATION_HANDOFF_VERSION;
  engine: SafeOperationEngine;
  database: string | null;
  sql: string;
  origin: MigrationOrigin;
  targetConnectionId?: string;
}

export interface QueryLabMetric {
  name: string;
  value: number;
  unit?: string;
}

export interface QueryLabEvidence {
  mode: 'estimate' | 'measured';
  sqlSha256: string;
  metrics: QueryLabMetric[];
}

export interface QueryLabHandoff extends Omit<MigrationHandoff, 'origin'> {
  origin: 'editor' | 'query-history' | 'slow-log';
  evidence?: QueryLabEvidence;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length) throw new Error(`${label} has unexpected fields: ${unexpected.join(', ')}`);
  const optional = ['evidence', 'unit', 'targetConnectionId'];
  const missing = allowed.filter(key => !optional.includes(key) && !(key in value));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
}

function sqlBytes(sql: string): number {
  return new TextEncoder().encode(sql).byteLength;
}

function parseBase(value: unknown, label: string): Omit<MigrationHandoff, 'origin'> {
  const input = object(value, label);
  if (input.version !== OPERATION_HANDOFF_VERSION) {
    throw new Error(`${label} has unsupported version ${String(input.version)}`);
  }
  if (input.engine !== 'mysql' && input.engine !== 'postgres') {
    throw new Error(`${label} has unsupported engine ${String(input.engine)}`);
  }
  if (input.database !== null && (typeof input.database !== 'string' || !input.database.trim())) {
    throw new Error(`${label}.database must be null or a non-empty string`);
  }
  if (typeof input.sql !== 'string' || !input.sql.trim()) {
    throw new Error(`${label}.sql must be a non-empty string`);
  }
  if (sqlBytes(input.sql) > MAX_HANDOFF_SQL_BYTES) {
    throw new Error(`${label}.sql exceeds the ${MAX_HANDOFF_SQL_BYTES}-byte handoff limit`);
  }
  return {
    version: OPERATION_HANDOFF_VERSION,
    engine: input.engine,
    database: input.database as string | null,
    sql: input.sql,
  };
}

export function parseMigrationHandoff(value: unknown): MigrationHandoff {
  const label = 'migration handoff';
  const input = object(value, label);
  exactKeys(input, ['version', 'engine', 'database', 'sql', 'origin', 'targetConnectionId'], label);
  if (!['editor', 'schema-compare', 'table-designer', 'query-lab'].includes(String(input.origin))) {
    throw new Error(`${label} has invalid origin ${String(input.origin)}`);
  }
  if (input.targetConnectionId !== undefined
      && (typeof input.targetConnectionId !== 'string' || !input.targetConnectionId.trim())) {
    throw new Error(`${label}.targetConnectionId must be a non-empty string when present`);
  }
  return {
    ...parseBase(input, label), origin: input.origin as MigrationOrigin,
    ...(input.targetConnectionId === undefined ? {} : { targetConnectionId: input.targetConnectionId as string }),
  };
}

function parseEvidence(value: unknown): QueryLabEvidence {
  const label = 'query lab evidence';
  const input = object(value, label);
  exactKeys(input, ['mode', 'sqlSha256', 'metrics'], label);
  if (input.mode !== 'estimate' && input.mode !== 'measured') {
    throw new Error(`${label}.mode must be estimate or measured`);
  }
  if (typeof input.sqlSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sqlSha256)) {
    throw new Error(`${label}.sqlSha256 must be a lowercase SHA-256 digest`);
  }
  if (!Array.isArray(input.metrics)) throw new Error(`${label}.metrics must be an array`);
  const names = new Set<string>();
  const metrics = input.metrics.map((entry, index): QueryLabMetric => {
    const metricLabel = `${label}.metrics[${index}]`;
    const metric = object(entry, metricLabel);
    exactKeys(metric, ['name', 'value', 'unit'], metricLabel);
    if (typeof metric.name !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(metric.name)) {
      throw new Error(`${metricLabel}.name is invalid`);
    }
    if (names.has(metric.name)) throw new Error(`${label}.metrics contains duplicate ${metric.name}`);
    names.add(metric.name);
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
      throw new Error(`${metricLabel}.value must be finite`);
    }
    if (metric.unit !== undefined && (typeof metric.unit !== 'string' || metric.unit.length > 16)) {
      throw new Error(`${metricLabel}.unit is invalid`);
    }
    return { name: metric.name, value: metric.value, ...(metric.unit === undefined ? {} : { unit: metric.unit }) };
  });
  return { mode: input.mode, sqlSha256: input.sqlSha256, metrics };
}

export function parseQueryLabHandoff(value: unknown): QueryLabHandoff {
  const label = 'query lab handoff';
  const input = object(value, label);
  exactKeys(input, ['version', 'engine', 'database', 'sql', 'origin', 'evidence'], label);
  if (!['editor', 'query-history', 'slow-log'].includes(String(input.origin))) {
    throw new Error(`${label} has invalid origin ${String(input.origin)}`);
  }
  return {
    ...parseBase(input, label),
    origin: input.origin as QueryLabHandoff['origin'],
    ...(input.evidence === undefined ? {} : { evidence: parseEvidence(input.evidence) }),
  };
}
