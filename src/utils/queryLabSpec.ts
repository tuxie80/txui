import { blank } from './sqlAlias.ts';
import { sha256Hex } from './datagenStandards.ts';
import { findVariables, substituteVariables } from './sqlVars.ts';
import { isWriteStatement } from './sqlGuard.ts';
import { splitStatements } from './sqlSplit.ts';
import type { SafeOperationEngine } from './operationHandoff.ts';

export const QUERY_LAB_SPEC_VERSION = 1;
export const MAX_QUERY_LAB_SQL_BYTES = 2 * 1024 * 1024;

export type QueryLabParameterKind = 'text' | 'number' | 'boolean' | 'null';
export interface QueryLabParameter { kind: QueryLabParameterKind; value: string }

export type QueryLabCandidate =
  | { id: string; kind: 'index'; name: string; table: string; columns: string[]; unique: boolean; where: string | null }
  | { id: string; kind: 'rewrite'; name: string; sql: string }
  | { id: string; kind: 'setting'; name: string; value: string };

export interface QueryLabEvidenceRequirements {
  plan: boolean;
  cost: boolean;
  timing: boolean;
  buffers: boolean;
  resultEquality: boolean;
}

export interface QueryLabScratchTarget {
  sessionId: string;
  connectionId: string;
  database: string;
  environment: string | null;
  readOnly: boolean;
}

export type QueryLabExecutionMode = 'estimate' | 'measured';
export type QueryLabIndexEvidenceMode = 'none' | 'hypothetical' | 'real';

export function queryLabIndexEvidenceMode(
  executionMode: QueryLabExecutionMode,
  candidates: readonly QueryLabCandidate[],
): QueryLabIndexEvidenceMode {
  if (!candidates.some(candidate => candidate.kind === 'index')) {
    return 'none';
  }
  return executionMode === 'estimate' ? 'hypothetical' : 'real';
}

export function validateQueryLabIndexEvidenceContract(
  executionMode: QueryLabExecutionMode,
  indexEvidenceMode: QueryLabIndexEvidenceMode,
): string[] {
  if (executionMode === 'estimate' && indexEvidenceMode === 'real') {
    return ['real-index measured evidence is incompatible with estimate mode'];
  }
  if (executionMode === 'measured' && indexEvidenceMode === 'hypothetical') {
    return ['hypothetical index evidence cannot produce measured runtime plans'];
  }
  return [];
}

export interface QueryLabExperiment {
  version: typeof QUERY_LAB_SPEC_VERSION;
  engine: SafeOperationEngine;
  database: string;
  originalSql: string;
  parameters: Record<string, QueryLabParameter>;
  candidates: QueryLabCandidate[];
  executionMode: QueryLabExecutionMode;
  warmupRuns: number;
  repetitions: number;
  timeoutMs: number;
  improvementThresholdPct: number;
  evidence: QueryLabEvidenceRequirements;
  scratch: QueryLabScratchTarget | null;
}

export interface NormalizedQueryLabExperiment extends QueryLabExperiment {
  resolvedSql: string;
  resolvedCandidates: QueryLabCandidate[];
}

export type QueryLabParseResult =
  | { ok: true; experiment: NormalizedQueryLabExperiment }
  | { ok: false; errors: string[] };

function object(value: unknown, label: string, errors: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${label} has unexpected field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) errors.push(`${label} is missing ${key}`);
  }
}

function text(value: unknown, label: string, errors: string[], max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    errors.push(`${label} must be a non-empty string of at most ${max} characters`);
    return '';
  }
  return value;
}

function boolean(value: unknown, label: string, errors: string[]): boolean {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be boolean`);
    return false;
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number, errors: string[]): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${label} must be an integer between ${min} and ${max}`);
    return min;
  }
  return value;
}

function identifier(value: unknown, label: string, errors: string[]): string {
  const parsed = text(value, label, errors, 128);
  if (parsed && !/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(parsed)) {
    errors.push(`${label} must be an unquoted table or schema.table identifier`);
    return '';
  }
  return parsed;
}

function sqlBytes(sql: string): number {
  return new TextEncoder().encode(sql).byteLength;
}

function positionalParameters(sql: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1] ?? '';
    if ((character === '-' && next === '-') || character === '#') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index++;
      while (index < sql.length) {
        if (sql[index] === '\\') { index += 2; continue; }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { index += 2; continue; }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (character === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index, index + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], index + tag[0].length);
        index = end === -1 ? sql.length : end + tag[0].length;
        continue;
      }
      const positional = /^\$[1-9][0-9]*/.exec(sql.slice(index, index + 12));
      if (positional) {
        found.push(positional[0]);
        index += positional[0].length;
        continue;
      }
    }
    if (character === '?') found.push('?');
    index++;
  }
  return found;
}

function resolveStatement(
  sql: string,
  engine: SafeOperationEngine,
  parameters: Record<string, QueryLabParameter>,
  label: string,
  errors: string[],
): string {
  const source = text(sql, `${label}.sql`, errors, MAX_QUERY_LAB_SQL_BYTES);
  if (!source) return '';
  if (sqlBytes(source) > MAX_QUERY_LAB_SQL_BYTES) {
    errors.push(`${label}.sql exceeds the 2 MiB limit`);
    return '';
  }
  if (/^\s*delimiter\s/i.test(source)) errors.push(`${label} must not contain client DELIMITER commands`);
  const statements = splitStatements(source);
  if (statements.length !== 1) {
    errors.push(`${label} must contain exactly one statement; found ${statements.length}`);
    return '';
  }
  const statement = statements[0]?.text ?? '';
  if (!/^(?:select|with)\b/i.test(blank(statement, engine).trimStart())) {
    errors.push(`${label} must be one SELECT or read-only WITH statement`);
  }
  if (isWriteStatement(statement, engine)) errors.push(`${label} is not read-only`);
  const positional = positionalParameters(statement);
  if (positional.length) errors.push(`${label} has unresolved positional parameters: ${[...new Set(positional)].join(', ')}; use named :parameters`);
  const required = findVariables(statement);
  for (const name of required) {
    if (!parameters[name]) errors.push(`${label} has unresolved parameter :${name}`);
  }
  for (const name of Object.keys(parameters)) {
    if (!required.includes(name)) errors.push(`${label} has unexpected concrete parameter :${name}`);
  }
  const values: Parameters<typeof substituteVariables>[1] = {};
  for (const name of required) {
    const parameter = parameters[name];
    if (!parameter) continue;
    switch (parameter.kind) {
      case 'text': values[name] = { value: parameter.value, raw: false }; break;
      case 'number':
        if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(parameter.value.trim())
          || !Number.isFinite(Number(parameter.value))) {
          errors.push(`${label} parameter :${name} is not a finite exact number`);
        } else values[name] = { value: parameter.value.trim(), raw: true };
        break;
      case 'boolean':
        if (!/^(?:true|false)$/i.test(parameter.value.trim())) {
          errors.push(`${label} parameter :${name} must be true or false`);
        } else values[name] = { value: parameter.value.trim().toUpperCase(), raw: true };
        break;
      case 'null':
        if (parameter.value !== '') errors.push(`${label} parameter :${name} must use an empty value for NULL`);
        values[name] = { value: 'NULL', raw: true };
        break;
    }
  }
  return errors.length ? '' : substituteVariables(statement, values, engine);
}

function parameters(value: unknown, errors: string[]): Record<string, QueryLabParameter> {
  const input = object(value, 'parameters', errors);
  const output: Record<string, QueryLabParameter> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`parameters.${name} is not a valid named parameter`);
      continue;
    }
    const parameter = object(raw, `parameters.${name}`, errors);
    exactKeys(parameter, ['kind', 'value'], `parameters.${name}`, errors);
    const kind = parameter.kind;
    if (!['text', 'number', 'boolean', 'null'].includes(String(kind))) {
      errors.push(`parameters.${name}.kind is unsupported`);
      continue;
    }
    if (typeof parameter.value !== 'string' || parameter.value.length > 10_000) {
      errors.push(`parameters.${name}.value must be a string of at most 10000 characters`);
      continue;
    }
    output[name] = { kind: kind as QueryLabParameterKind, value: parameter.value };
  }
  return output;
}

function evidence(value: unknown, errors: string[]): QueryLabEvidenceRequirements {
  const input = object(value, 'evidence', errors);
  exactKeys(input, ['plan', 'cost', 'timing', 'buffers', 'resultEquality'], 'evidence', errors);
  return {
    plan: boolean(input.plan, 'evidence.plan', errors),
    cost: boolean(input.cost, 'evidence.cost', errors),
    timing: boolean(input.timing, 'evidence.timing', errors),
    buffers: boolean(input.buffers, 'evidence.buffers', errors),
    resultEquality: boolean(input.resultEquality, 'evidence.resultEquality', errors),
  };
}

function scratch(value: unknown, errors: string[]): QueryLabScratchTarget | null {
  if (value === null) return null;
  const input = object(value, 'scratch', errors);
  exactKeys(input, ['sessionId', 'connectionId', 'database', 'environment', 'readOnly'], 'scratch', errors);
  return {
    sessionId: text(input.sessionId, 'scratch.sessionId', errors, 128),
    connectionId: text(input.connectionId, 'scratch.connectionId', errors, 128),
    database: text(input.database, 'scratch.database', errors, 128),
    environment: input.environment === null ? null : text(input.environment, 'scratch.environment', errors, 64),
    readOnly: boolean(input.readOnly, 'scratch.readOnly', errors),
  };
}

function candidates(value: unknown, engine: SafeOperationEngine, parameters: Record<string, QueryLabParameter>, errors: string[]): QueryLabCandidate[] {
  if (!Array.isArray(value) || value.length > 16) {
    errors.push('candidates must be an array with at most 16 entries');
    return [];
  }
  const ids = new Set<string>();
  const output: QueryLabCandidate[] = [];
  for (const [index, raw] of value.entries()) {
    const label = `candidates[${index}]`;
    const candidate = object(raw, label, errors);
    const id = text(candidate.id, `${label}.id`, errors, 80);
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) errors.push(`${label}.id must use lowercase letters, digits, _ or -`);
    if (ids.has(id)) errors.push(`${label}.id duplicates ${id}`);
    ids.add(id);
    const kind = candidate.kind;
    const name = text(candidate.name, `${label}.name`, errors, 160);
    if (kind === 'index') {
      exactKeys(candidate, ['id', 'kind', 'name', 'table', 'columns', 'unique', 'where'], label, errors);
      const table = identifier(candidate.table, `${label}.table`, errors);
      if (!Array.isArray(candidate.columns) || candidate.columns.length === 0 || candidate.columns.length > 32) {
        errors.push(`${label}.columns must contain 1–32 columns`);
      }
      const columns = Array.isArray(candidate.columns)
        ? candidate.columns.map((column, at) => identifier(column, `${label}.columns[${at}]`, errors)).filter(Boolean)
        : [];
      if (new Set(columns).size !== columns.length) errors.push(`${label}.columns contains duplicates`);
      const where = candidate.where === null ? null : text(candidate.where, `${label}.where`, errors, 10_000);
      output.push({ id, kind, name, table, columns, unique: boolean(candidate.unique, `${label}.unique`, errors), where });
    } else if (kind === 'rewrite') {
      exactKeys(candidate, ['id', 'kind', 'name', 'sql'], label, errors);
      const sql = resolveStatement(candidate.sql as string, engine, parameters, label, errors);
      output.push({ id, kind, name, sql: sql || (typeof candidate.sql === 'string' ? candidate.sql : '') });
    } else if (kind === 'setting') {
      exactKeys(candidate, ['id', 'kind', 'name', 'value'], label, errors);
      output.push({ id, kind, name, value: text(candidate.value, `${label}.value`, errors, 512) });
    } else {
      errors.push(`${label}.kind must be index, rewrite or setting`);
    }
  }
  return output;
}

export function validateQueryLabExperiment(value: unknown): string[] {
  const errors: string[] = [];
  const input = object(value, 'query lab experiment', errors);
  exactKeys(input, [
    'version', 'engine', 'database', 'originalSql', 'parameters', 'candidates', 'executionMode',
    'warmupRuns', 'repetitions', 'timeoutMs', 'improvementThresholdPct', 'evidence', 'scratch',
  ], 'query lab experiment', errors);
  if (input.version !== QUERY_LAB_SPEC_VERSION) errors.push(`query lab experiment has unsupported version ${String(input.version)}`);
  if (input.engine !== 'mysql' && input.engine !== 'postgres') errors.push(`query lab experiment has unsupported engine ${String(input.engine)}`);
  const engine = input.engine === 'postgres' ? 'postgres' : 'mysql';
  text(input.database, 'database', errors, 128);
  const parameterMap = parameters(input.parameters, errors);
  resolveStatement(input.originalSql as string, engine, parameterMap, 'originalSql', errors);
  const candidateList = candidates(input.candidates, engine, parameterMap, errors);
  const mode = input.executionMode as QueryLabExecutionMode;
  if (mode !== 'estimate' && mode !== 'measured') errors.push(`executionMode ${String(mode)} is unsupported`);
  errors.push(...validateQueryLabIndexEvidenceContract(mode, queryLabIndexEvidenceMode(mode, candidateList)));
  integer(input.warmupRuns, 'warmupRuns', 0, 10, errors);
  integer(input.repetitions, 'repetitions', 1, 30, errors);
  integer(input.timeoutMs, 'timeoutMs', 100, 60_000, errors);
  if (typeof input.improvementThresholdPct !== 'number' || !Number.isFinite(input.improvementThresholdPct)
    || input.improvementThresholdPct < 0 || input.improvementThresholdPct > 100) {
    errors.push('improvementThresholdPct must be between 0 and 100');
  }
  const requirements = evidence(input.evidence, errors);
  if (!requirements.plan) errors.push('evidence.plan is required for every experiment');
  const target = scratch(input.scratch, errors);
  if (mode === 'estimate') {
    if (requirements.timing || requirements.buffers || requirements.resultEquality) {
      errors.push('estimate mode accepts plan/cost evidence only; timing, buffers and result equality must be disabled');
    }
    for (const candidate of candidateList) {
      if (candidate.kind === 'index' && engine !== 'postgres') {
        errors.push(`${candidate.id}: hypothetical index estimates are PostgreSQL-only; MySQL indexes require measured scratch execution`);
      }
      if (candidate.kind === 'setting') errors.push(`${candidate.id}: setting candidates require measured scratch execution`);
    }
  }
  if (mode === 'measured') {
    if (!requirements.timing) errors.push('measured mode requires timing evidence');
    if (!target) errors.push('measured mode requires an explicit scratch target');
    if (target) {
      if (target.environment?.toLowerCase() === 'prod') errors.push('measured mode requires a non-production scratch target');
      if (target.readOnly) errors.push('measured scratch target must be writable');
      if (target.database !== input.database) errors.push('scratch database must exactly match the experiment database');
    }
    if (candidateList.some(candidate => candidate.kind === 'rewrite') && !requirements.resultEquality) {
      errors.push('rewrite candidates in measured mode require result-equality evidence');
    }
  }
  return [...new Set(errors)];
}

export function parseQueryLabExperiment(value: unknown): QueryLabParseResult {
  const errors = validateQueryLabExperiment(value);
  if (errors.length) return { ok: false, errors };
  const input = value as QueryLabExperiment;
  const parameters = Object.fromEntries(Object.entries(input.parameters).map(([name, parameter]) => [name, { ...parameter }]));
  return {
    ok: true,
    experiment: {
      ...input,
      parameters,
      candidates: candidates(input.candidates, input.engine, parameters, []),
      evidence: { ...input.evidence },
      scratch: input.scratch ? { ...input.scratch } : null,
      resolvedSql: resolveStatement(input.originalSql, input.engine, parameters, 'originalSql', []),
      resolvedCandidates: candidates(input.candidates, input.engine, parameters, []),
    },
  };
}

export function queryLabSpecSha256(experiment: QueryLabExperiment): string {
  return sha256Hex(Array.from(new TextEncoder().encode(JSON.stringify(experiment))));
}

export function createDefaultQueryLabExperiment(input: {
  engine: SafeOperationEngine;
  database: string;
  sessionId: string;
  connectionId: string;
  environment?: string | null;
  readOnly?: boolean;
}): QueryLabExperiment {
  const parameters = { customer_id: { kind: 'number' as const, value: '1' } };
  const originalSql = 'SELECT id, customer_id, created_at FROM orders WHERE customer_id = :customer_id ORDER BY id LIMIT 1000';
  return {
    version: QUERY_LAB_SPEC_VERSION,
    engine: input.engine,
    database: input.database,
    originalSql,
    parameters,
    candidates: input.engine === 'postgres'
      ? [{ id: 'customer-index', kind: 'index', name: 'Orders by customer', table: 'orders', columns: ['customer_id'], unique: false, where: null }]
      : [{ id: 'equivalent-rewrite', kind: 'rewrite', name: 'Equivalent redundant predicate', sql: 'SELECT id, customer_id, created_at FROM orders WHERE customer_id = :customer_id AND id > 0 ORDER BY id LIMIT 1000' }],
    executionMode: 'estimate',
    warmupRuns: 1,
    repetitions: 7,
    timeoutMs: 5000,
    improvementThresholdPct: 5,
    evidence: { plan: true, cost: true, timing: false, buffers: false, resultEquality: false },
    scratch: {
      sessionId: input.sessionId,
      connectionId: input.connectionId,
      database: input.database,
      environment: input.environment ?? null,
      readOnly: input.readOnly ?? false,
    },
  };
}
