export const REFRESH_SPEC_VERSION = 1;
export const MAX_REFRESH_SPEC_BYTES = 2 * 1024 * 1024;

export interface RefreshEndpoint {
  connectionId: string;
  sessionId: string | null;
}

export interface RefreshSchemaMapping {
  source: string;
  target: string;
}

interface PolicyBase {
  table: string;
}

export type RefreshTablePolicy = PolicyBase & (
  | { policy: 'full' | 'exclude' }
  | {
      policy: 'time_window';
      column: string;
      mode: 'rolling' | 'calendar_days';
      amount: number;
      unit: 'hours' | 'days';
      timeZone: string;
      nullPolicy: 'exclude' | 'include';
      cutoffUtc: string;
    }
  | {
      policy: 'row_limit';
      rows: number;
      orderBy: string[];
      direction: 'asc' | 'desc';
      tieBreaker: string[];
      /** Absent in early v1 specs means a soft selection limit. */
      limitKind?: 'soft' | 'hard';
    }
  | { policy: 'sample'; rows: number; sampleSeed: number; tieBreaker: string[]; limitKind?: 'soft' | 'hard' }
  | { policy: 'predicate'; where: string }
  | { policy: 'generate'; rows: number; seedOffset: number }
);

export type RefreshMaskRule = {
  table: string;
  column: string;
} & (
  | { rule: 'preserve' }
  | { rule: 'constant'; value: string | number | boolean | null }
  | { rule: 'hash' }
  | { rule: 'fake'; generator: string }
);

export interface RefreshSpec {
  version: typeof REFRESH_SPEC_VERSION;
  engine: 'mysql';
  source: RefreshEndpoint;
  target: RefreshEndpoint;
  schemaMappings: RefreshSchemaMapping[];
  seed: string;
  allowFkBreaking: boolean;
  /** Optional in early v1 specs; false means unmasked sensitive columns block. */
  acknowledgeUnmaskedSensitive?: boolean;
  tables: RefreshTablePolicy[];
  masks: RefreshMaskRule[];
  limits: {
    maxRowsPerChunk: number;
    maxBytesPerChunk: number;
    planningKeyBatch: number;
    maxPlanningKeys: number;
  };
  verification: {
    exactCounts: boolean;
    foreignKeyOrphans: boolean;
    contentSha256: boolean;
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length) throw new Error(`${label} has unexpected fields: ${unexpected.join(', ')}`);
  const missing = allowed.filter(key => !(key in value));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function nullableSession(value: unknown, label: string): string | null {
  if (value === null) return null;
  return text(value, label, 128);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function strings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 128) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array with at most 128 entries`);
  }
  const out = value.map((entry, index) => text(entry, `${label}[${index}]`, 128));
  if (new Set(out.map(entry => entry.toLowerCase())).size !== out.length) {
    throw new Error(`${label} contains duplicate columns`);
  }
  return out;
}

function endpoint(value: unknown, label: string): RefreshEndpoint {
  const input = object(value, label);
  keys(input, ['connectionId', 'sessionId'], label);
  return {
    connectionId: text(input.connectionId, `${label}.connectionId`, 128),
    sessionId: nullableSession(input.sessionId, `${label}.sessionId`),
  };
}

function cutoff(value: unknown): string {
  const input = text(value, 'time_window.cutoffUtc', 64);
  const parsed = new Date(input);
  if (!input.endsWith('Z') || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) {
    throw new Error('time_window.cutoffUtc must be an exact UTC ISO instant with milliseconds');
  }
  return input;
}

function policy(value: unknown, index: number): RefreshTablePolicy {
  const label = `tables[${index}]`;
  const input = object(value, label);
  const kind = input.policy;
  const common = ['table', 'policy'] as const;
  const fields: Record<string, readonly string[]> = {
    full: common,
    exclude: common,
    time_window: [...common, 'column', 'mode', 'amount', 'unit', 'timeZone', 'nullPolicy', 'cutoffUtc'],
    row_limit: [...common, 'rows', 'orderBy', 'direction', 'tieBreaker', 'limitKind'],
    sample: [...common, 'rows', 'sampleSeed', 'tieBreaker', 'limitKind'],
    predicate: [...common, 'where'],
    generate: [...common, 'rows', 'seedOffset'],
  };
  if (typeof kind !== 'string' || !(kind in fields)) throw new Error(`${label}.policy is unsupported`);
  const limited = kind === 'row_limit' || kind === 'sample';
  const limitKind = limited ? input.limitKind ?? 'soft' : undefined;
  if (limited && limitKind !== 'soft' && limitKind !== 'hard') throw new Error(`${label}.limitKind must be soft or hard`);
  keys(limited ? { ...input, limitKind } : input, fields[kind], label);
  const table = text(input.table, `${label}.table`, 128);
  if (kind === 'full' || kind === 'exclude') return { table, policy: kind };
  if (kind === 'time_window') {
    if (input.mode !== 'rolling' && input.mode !== 'calendar_days') throw new Error(`${label}.mode must be rolling or calendar_days`);
    if (input.unit !== 'hours' && input.unit !== 'days') throw new Error(`${label}.unit must be hours or days`);
    if (input.nullPolicy !== 'exclude' && input.nullPolicy !== 'include') throw new Error(`${label}.nullPolicy must be exclude or include`);
    return {
      table, policy: kind,
      column: text(input.column, `${label}.column`, 128),
      mode: input.mode,
      amount: integer(input.amount, `${label}.amount`, 1, 3660),
      unit: input.unit,
      timeZone: text(input.timeZone, `${label}.timeZone`, 128),
      nullPolicy: input.nullPolicy,
      cutoffUtc: cutoff(input.cutoffUtc),
    };
  }
  if (kind === 'row_limit') {
    if (input.direction !== 'asc' && input.direction !== 'desc') throw new Error(`${label}.direction must be asc or desc`);
    return {
      table, policy: kind,
      rows: integer(input.rows, `${label}.rows`, 1, 1_000_000_000),
      orderBy: strings(input.orderBy, `${label}.orderBy`),
      direction: input.direction,
      tieBreaker: strings(input.tieBreaker, `${label}.tieBreaker`),
      limitKind: limitKind as 'soft' | 'hard',
    };
  }
  if (kind === 'sample') {
    return {
      table, policy: kind,
      rows: integer(input.rows, `${label}.rows`, 1, 1_000_000_000),
      sampleSeed: integer(input.sampleSeed, `${label}.sampleSeed`, 0, Number.MAX_SAFE_INTEGER),
      tieBreaker: strings(input.tieBreaker, `${label}.tieBreaker`),
      limitKind: limitKind as 'soft' | 'hard',
    };
  }
  if (kind === 'predicate') {
    const where = text(input.where, `${label}.where`, 10_000);
    if (where.includes(';') || where.includes('\0')) throw new Error(`${label}.where must be one predicate without a statement terminator`);
    return { table, policy: kind, where };
  }
  return {
    table, policy: 'generate',
    rows: integer(input.rows, `${label}.rows`, 1, 1_000_000_000),
    seedOffset: integer(input.seedOffset, `${label}.seedOffset`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function mask(value: unknown, index: number): RefreshMaskRule {
  const label = `masks[${index}]`;
  const input = object(value, label);
  const rule = input.rule;
  if (!['preserve', 'constant', 'hash', 'fake'].includes(String(rule))) throw new Error(`${label}.rule is unsupported`);
  const allowed = ['table', 'column', 'rule', ...(rule === 'constant' ? ['value'] : rule === 'fake' ? ['generator'] : [])];
  keys(input, allowed, label);
  const table = text(input.table, `${label}.table`, 128);
  const column = text(input.column, `${label}.column`, 128);
  if (rule === 'preserve') return { table, column, rule };
  if (rule === 'hash') return { table, column, rule };
  if (rule === 'fake') {
    const generator = text(input.generator, `${label}.generator`, 80);
    if (!/^[a-z][a-z0-9_.-]*$/.test(generator)) throw new Error(`${label}.generator is invalid`);
    return { table, column, rule, generator };
  }
  const constant = input.value;
  if (constant !== null && !['string', 'number', 'boolean'].includes(typeof constant)) {
    throw new Error(`${label}.value must be a string, finite number, boolean or null`);
  }
  if (typeof constant === 'number' && !Number.isFinite(constant)) throw new Error(`${label}.value must be finite`);
  if (typeof constant === 'string' && constant.length > 10_000) throw new Error(`${label}.value is too long`);
  return { table, column, rule: 'constant', value: constant as string | number | boolean | null };
}

export function parseRefreshSpec(value: unknown): RefreshSpec {
  const input = object(value, 'refresh spec');
  keys({
    ...input,
    acknowledgeUnmaskedSensitive: input.acknowledgeUnmaskedSensitive === undefined ? false : input.acknowledgeUnmaskedSensitive,
  }, [
    'version', 'engine', 'source', 'target', 'schemaMappings', 'seed', 'allowFkBreaking',
    'acknowledgeUnmaskedSensitive', 'tables', 'masks', 'limits', 'verification',
  ], 'refresh spec');
  if (input.version !== REFRESH_SPEC_VERSION) throw new Error(`refresh spec has unsupported version ${String(input.version)}`);
  if (input.engine !== 'mysql') throw new Error('refresh spec currently supports MySQL/MariaDB only');
  const source = endpoint(input.source, 'source');
  const target = endpoint(input.target, 'target');
  if (source.sessionId && target.sessionId && source.sessionId === target.sessionId) {
    throw new Error('source and target must be different sessions');
  }
  if (!Array.isArray(input.schemaMappings) || input.schemaMappings.length === 0 || input.schemaMappings.length > 128) {
    throw new Error('schemaMappings must contain 1–128 mappings');
  }
  const schemaMappings = input.schemaMappings.map((entry, index): RefreshSchemaMapping => {
    const label = `schemaMappings[${index}]`;
    const mapping = object(entry, label);
    keys(mapping, ['source', 'target'], label);
    return {
      source: text(mapping.source, `${label}.source`, 128),
      target: text(mapping.target, `${label}.target`, 128),
    };
  });
  if (new Set(schemaMappings.map(mapping => mapping.source.toLowerCase())).size !== schemaMappings.length) {
    throw new Error('schemaMappings contains duplicate source schemas');
  }
  if (new Set(schemaMappings.map(mapping => mapping.target.toLowerCase())).size !== schemaMappings.length) {
    throw new Error('schemaMappings contains duplicate target schemas');
  }
  if (!Array.isArray(input.tables) || input.tables.length > 1000) throw new Error('tables must be an array with at most 1000 entries');
  const tables = input.tables.map(policy);
  if (new Set(tables.map(table => table.table.toLowerCase())).size !== tables.length) {
    throw new Error('tables contains duplicate table policies');
  }
  if (!Array.isArray(input.masks) || input.masks.length > 10_000) throw new Error('masks must be an array with at most 10000 entries');
  const masks = input.masks.map(mask);
  if (new Set(masks.map(mask => `${mask.table.toLowerCase()}.${mask.column.toLowerCase()}`)).size !== masks.length) {
    throw new Error('masks contains duplicate table/column rules');
  }
  const limits = object(input.limits, 'limits');
  keys(limits, ['maxRowsPerChunk', 'maxBytesPerChunk', 'planningKeyBatch', 'maxPlanningKeys'], 'limits');
  const verification = object(input.verification, 'verification');
  keys(verification, ['exactCounts', 'foreignKeyOrphans', 'contentSha256'], 'verification');
  return {
    version: REFRESH_SPEC_VERSION,
    engine: 'mysql',
    source,
    target,
    schemaMappings,
    seed: text(input.seed, 'seed', 256),
    allowFkBreaking: boolean(input.allowFkBreaking, 'allowFkBreaking'),
    acknowledgeUnmaskedSensitive: input.acknowledgeUnmaskedSensitive === undefined
      ? false : boolean(input.acknowledgeUnmaskedSensitive, 'acknowledgeUnmaskedSensitive'),
    tables,
    masks,
    limits: {
      maxRowsPerChunk: integer(limits.maxRowsPerChunk, 'limits.maxRowsPerChunk', 1, 200_000),
      maxBytesPerChunk: integer(limits.maxBytesPerChunk, 'limits.maxBytesPerChunk', 1, 256 * 1024 * 1024),
      planningKeyBatch: integer(limits.planningKeyBatch, 'limits.planningKeyBatch', 1, 100_000),
      maxPlanningKeys: integer(limits.maxPlanningKeys, 'limits.maxPlanningKeys', 1, 10_000_000),
    },
    verification: {
      exactCounts: boolean(verification.exactCounts, 'verification.exactCounts'),
      foreignKeyOrphans: boolean(verification.foreignKeyOrphans, 'verification.foreignKeyOrphans'),
      contentSha256: boolean(verification.contentSha256, 'verification.contentSha256'),
    },
  };
}

export function refreshSpecBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function parseRefreshSpecText(text: string): RefreshSpec {
  if (refreshSpecBytes(text) > MAX_REFRESH_SPEC_BYTES) throw new Error('refresh spec exceeds the 2 MiB limit');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`refresh spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRefreshSpec(value);
}

export function serializeRefreshSpec(spec: RefreshSpec): string {
  return `${JSON.stringify(parseRefreshSpec(spec), null, 2)}\n`;
}

export function refreshSpecHints(spec: RefreshSpec): RefreshSpec {
  return parseRefreshSpec({
    ...spec,
    source: { ...spec.source, sessionId: null },
    target: { ...spec.target, sessionId: null },
  });
}

export function createDefaultRefreshSpec(input: {
  source: RefreshEndpoint;
  schema: string;
  cutoffUtc: string;
}): RefreshSpec {
  return {
    version: REFRESH_SPEC_VERSION,
    engine: 'mysql',
    source: input.source,
    target: { connectionId: '', sessionId: null },
    schemaMappings: [{ source: input.schema, target: input.schema }],
    seed: 'refresh-v1',
    allowFkBreaking: false,
    acknowledgeUnmaskedSensitive: false,
    tables: [
      { table: 'countries', policy: 'full' },
      {
        table: 'orders', policy: 'time_window', column: 'created_at', mode: 'rolling',
        amount: 7, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: input.cutoffUtc,
      },
      {
        table: 'events', policy: 'time_window', column: 'created_at', mode: 'rolling',
        amount: 1, unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: input.cutoffUtc,
      },
    ],
    masks: [{ table: 'customers', column: 'email', rule: 'hash' }],
    limits: {
      maxRowsPerChunk: 50_000,
      maxBytesPerChunk: 64 * 1024 * 1024,
      planningKeyBatch: 10_000,
      maxPlanningKeys: 1_000_000,
    },
    verification: { exactCounts: true, foreignKeyOrphans: true, contentSha256: true },
  };
}
