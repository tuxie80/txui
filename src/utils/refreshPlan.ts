import { sha256Hex } from './datagenStandards.ts';
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';
import { parseRefreshSpec, serializeRefreshSpec } from './refreshSpec.ts';
import type {
  RefreshSchemaMapping, RefreshSpec, RefreshTablePolicy,
} from './refreshSpec.ts';

export interface RefreshTablePlan {
  table: string;
  policy: RefreshTablePolicy['policy'] | 'blocked';
  action: 'read' | 'generate' | 'exclude' | 'blocked';
  sourceSchema: string | null;
  targetSchema: string | null;
  sourceSql: string | null;
  estimatedRows: null;
  notes: string[];
}

export interface RefreshPlan {
  version: 1;
  engine: 'mysql';
  specSha256: string;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  readOnly: true;
  tables: RefreshTablePlan[];
  blockers: string[];
}

export interface ResolvedRefreshTable {
  sourceSchema: string;
  targetSchema: string;
  tableName: string;
}

export function resolveRefreshTable(spec: RefreshSpec, table: string): ResolvedRefreshTable | string {
  const parts = table.split('.');
  if (parts.length === 1 && spec.schemaMappings.length !== 1) {
    return `${table} is ambiguous across ${spec.schemaMappings.length} schema mappings; use schema.table`;
  }
  if (parts.length > 2) return `${table} is not a valid table or schema.table name`;
  const sourceSchema = parts.length === 2 ? parts[0] : spec.schemaMappings[0].source;
  const tableName = parts[parts.length - 1];
  if (!sourceSchema || !tableName) return `${table} is not a valid table name`;
  const mapping = spec.schemaMappings.find(candidate => candidate.source === sourceSchema);
  if (!mapping) return `${table} has no mapping for source schema ${sourceSchema}`;
  return { sourceSchema, targetSchema: mapping.target, tableName };
}

function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema, 'mysql')}.${quoteIdent(table, 'mysql')}`;
}

function columns(names: string[]): string {
  return names.map(name => quoteIdent(name, 'mysql')).join(', ');
}

function order(names: string[], direction: 'asc' | 'desc'): string {
  return names.map(name => `${quoteIdent(name, 'mysql')} ${direction.toUpperCase()}`).join(', ');
}

function zonedDate(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') values[part.type] = Number(part.value);
  }
  return { year: values.year, month: values.month, day: values.day };
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, timeZoneName: 'longOffset', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const zone = parts.find(part => part.type === 'timeZoneName')?.value ?? '';
  if (zone === 'GMT' || zone === 'UTC') return 0;
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(zone);
  if (!match) throw new Error(`cannot resolve timezone ${timeZone}`);
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60_000;
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day);
  let candidate = naive;
  for (let index = 0; index < 3; index++) {
    candidate = naive - offsetMs(new Date(candidate), timeZone);
  }
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new Error(`cannot resolve local midnight in ${timeZone}`);
  return date;
}

export function resolveRefreshWindow(policy: Extract<RefreshTablePolicy, { policy: 'time_window' }>): {
  startUtc: string;
  cutoffUtc: string;
  mode: 'rolling' | 'calendar_days';
  timeZone: string;
} {
  const cutoff = new Date(policy.cutoffUtc);
  let start: Date;
  if (policy.mode === 'rolling') {
    const milliseconds = policy.unit === 'hours' ? 3_600_000 : 86_400_000;
    start = new Date(cutoff.getTime() - policy.amount * milliseconds);
  } else {
    if (policy.unit !== 'days') throw new Error('calendar_days mode requires unit=days');
    const local = zonedDate(cutoff, policy.timeZone);
    const previous = new Date(Date.UTC(local.year, local.month - 1, local.day - policy.amount));
    start = zonedMidnightUtc(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate(), policy.timeZone);
  }
  return {
    startUtc: start.toISOString(),
    cutoffUtc: cutoff.toISOString(),
    mode: policy.mode,
    timeZone: policy.timeZone,
  };
}

export type RefreshTimeColumn = 'date' | 'datetime' | 'timestamp';

function offsetLiteral(milliseconds: number): string {
  const sign = milliseconds < 0 ? '-' : '+';
  const absolute = Math.abs(milliseconds);
  const hours = Math.floor(absolute / 3_600_000).toString().padStart(2, '0');
  const minutes = Math.floor(absolute % 3_600_000 / 60_000).toString().padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function localDate(date: Date, timeZone: string): string {
  const parts = zonedDate(date, timeZone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

export function refreshTimePredicate(
  policy: Extract<RefreshTablePolicy, { policy: 'time_window' }>,
  columnType: RefreshTimeColumn = 'datetime',
): { sql: string; startUtc: string; cutoffUtc: string; note: string } {
  const window = resolveRefreshWindow(policy);
  const start = new Date(window.startUtc);
  const cutoff = new Date(window.cutoffUtc);
  let sql: string;
  let note: string;
  if (columnType === 'date') {
    const startDate = localDate(start, policy.timeZone);
    const cutoffDate = localDate(cutoff, policy.timeZone);
    sql = `BETWEEN ${sqlLiteral(startDate)} AND ${sqlLiteral(cutoffDate)}`;
    note = `DATE values use policy-zone calendar dates ${startDate} through ${cutoffDate}; session/server timezone does not change them`;
  } else {
    const startOffset = offsetLiteral(offsetMs(start, policy.timeZone));
    const cutoffOffset = offsetLiteral(offsetMs(cutoff, policy.timeZone));
    sql = `BETWEEN CONVERT_TZ(${sqlLiteral(window.startUtc)}, '+00:00', ${sqlLiteral(startOffset)}) AND CONVERT_TZ(${sqlLiteral(window.cutoffUtc)}, '+00:00', ${sqlLiteral(cutoffOffset)})`;
    note = `DATETIME/TIMESTAMP values use ${policy.timeZone}; boundary offsets ${startOffset}/${cutoffOffset} are frozen independently of session/server timezone`;
  }
  return { sql, startUtc: window.startUtc, cutoffUtc: window.cutoffUtc, note };
}

function readSql(
  spec: RefreshSpec,
  table: RefreshTablePolicy,
  sourceSchema: string,
  timeColumnType: RefreshTimeColumn = 'datetime',
  projection?: string[],
): string {
  const relation = qualified(sourceSchema, table.table.split('.').pop()!);
  const selected = projection?.length ? columns(projection) : '*';
  if (table.policy === 'full') return `SELECT ${selected} FROM ${relation}`;
  if (table.policy === 'predicate') return `SELECT ${selected} FROM ${relation} WHERE ${table.where}`;
  if (table.policy === 'time_window') {
    const predicate = refreshTimePredicate(table, timeColumnType);
    const column = quoteIdent(table.column, 'mysql');
    const nullRule = table.nullPolicy === 'exclude' ? ` AND ${column} IS NOT NULL` : '';
    return `SELECT ${selected} FROM ${relation} WHERE ${column} ${predicate.sql}${nullRule}`;
  }
  if (table.policy === 'row_limit') {
    return `SELECT ${selected} FROM ${relation} ORDER BY ${order([...table.orderBy, ...table.tieBreaker], table.direction)} LIMIT ${table.rows}`;
  }
  if (table.policy === 'sample') {
    const parts = [sqlLiteral(spec.seed), sqlLiteral(String(table.sampleSeed)), ...table.tieBreaker.map(column => quoteIdent(column, 'mysql'))];
    return `SELECT ${selected} FROM ${relation} ORDER BY MD5(CONCAT(${parts.join(`, ':', `)})), ${columns(table.tieBreaker)} LIMIT ${table.rows}`;
  }
  throw new Error(`${table.table} does not have a source query`);
}

export function buildRefreshPolicySql(
  spec: RefreshSpec,
  table: RefreshTablePolicy,
  sourceSchema: string,
  timeColumnType: RefreshTimeColumn = 'datetime',
  projection?: string[],
): string {
  return readSql(spec, table, sourceSchema, timeColumnType, projection);
}

export function buildRefreshPlan(
  input: RefreshSpec,
  timeColumns: ReadonlyMap<string, RefreshTimeColumn> = new Map(),
): RefreshPlan {
  const spec = parseRefreshSpec(input);
  const blockers: string[] = [];
  const seenTargets = new Set<string>();
  const tables = spec.tables.map((table): RefreshTablePlan => {
    const resolved = resolveRefreshTable(spec, table.table);
    const timeColumnType = timeColumns.get(table.table);
    const base: RefreshTablePlan = {
      table: table.table,
      policy: table.policy,
      action: 'read',
      sourceSchema: typeof resolved === 'string' ? null : resolved.sourceSchema,
      targetSchema: typeof resolved === 'string' ? null : resolved.targetSchema,
      sourceSql: null,
      estimatedRows: null,
      notes: [
        'No catalog row estimate has been collected',
        ...(table.policy === 'time_window' ? [refreshTimePredicate(table, timeColumnType).note] : []),
      ],
    };
    if (typeof resolved === 'string') {
      blockers.push(resolved);
      return { ...base, policy: 'blocked', action: 'blocked', notes: [resolved] };
    }
    const targetKey = `${resolved.targetSchema.toLowerCase()}.${table.table.split('.').pop()!.toLowerCase()}`;
    if (seenTargets.has(targetKey)) {
      const blocker = `${table.table} maps to duplicate target ${targetKey}`;
      blockers.push(blocker);
      return { ...base, policy: 'blocked', action: 'blocked', notes: [blocker] };
    }
    seenTargets.add(targetKey);
    if (table.policy === 'exclude') return { ...base, action: 'exclude' };
    if (table.policy === 'generate') {
      return {
        ...base,
        action: 'generate',
        notes: [`Generate ${table.rows} rows with seed offset ${table.seedOffset}; no source query or row estimate`],
      };
    }
    return { ...base, sourceSql: readSql(spec, table, resolved.sourceSchema, timeColumnType) };
  });
  return {
    version: 1,
    engine: 'mysql',
    specSha256: sha256Hex(Array.from(new TextEncoder().encode(serializeRefreshSpec(spec)))),
    sourceSessionId: spec.source.sessionId,
    targetSessionId: spec.target.sessionId,
    readOnly: true,
    tables,
    blockers,
  };
}

export function refreshPlanSignature(plan: RefreshPlan): string {
  return JSON.stringify(plan);
}

export function mappedSchemaNames(mappings: RefreshSchemaMapping[]): string {
  return mappings.map(mapping => `${mapping.source} → ${mapping.target}`).join(', ');
}
