import { DEFAULT_PARAMS, suggestGenerator } from './datagen.ts';
import type { ColumnSpec } from './datagen.ts';
import { sha256Hex } from './datagenStandards.ts';
import { parseGenerateSpec } from './generateSpec.ts';
import type { GenerateSpec } from './generateSpec.ts';
import { buildRefreshPlan, resolveRefreshTable } from './refreshPlan.ts';
import type { RefreshCatalogAnalysis, RefreshGraphTable } from './refreshCatalog.ts';
import type { RefreshMaskPlan } from './refreshMask.ts';
import type { RefreshSpec, RefreshTablePolicy } from './refreshSpec.ts';

export const GENERATE_INSTEAD_VERSION = 1;
export const OPEN_GENERATE_INSTEAD_EVENT = 'dbgui:generate-instead';

export interface GenerateInsteadHandoff {
  version: typeof GENERATE_INSTEAD_VERSION;
  origin: 'environment-refresh';
  targetSessionId: string;
  targetConnectionId: string;
  specSha256: string;
  generate: GenerateSpec;
}

export type GenerateInsteadResult =
  | { ok: true; handoff: GenerateInsteadHandoff }
  | { ok: false; errors: string[] };

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length) throw new Error(`${label} has unexpected fields: ${unexpected.join(', ')}`);
  const missing = allowed.filter(key => !(key in value));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`${label} must be a non-empty string of at most 128 characters`);
  return value;
}

export function parseGenerateInsteadHandoff(value: unknown): GenerateInsteadHandoff {
  const input = object(value, 'generate-instead handoff');
  exactKeys(input, ['version', 'origin', 'targetSessionId', 'targetConnectionId', 'specSha256', 'generate'], 'generate-instead handoff');
  if (input.version !== GENERATE_INSTEAD_VERSION) throw new Error(`generate-instead handoff has unsupported version ${String(input.version)}`);
  if (input.origin !== 'environment-refresh') throw new Error('generate-instead handoff origin must be environment-refresh');
  if (typeof input.specSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.specSha256)) {
    throw new Error('generate-instead handoff specSha256 must be a lowercase SHA-256 digest');
  }
  const generate = object(input.generate, 'generate-instead specification');
  exactKeys(generate, ['table', 'rowCount', 'seed', 'locale', 'useCopy', 'createDdl', 'specs'], 'generate-instead specification');
  const parsed = parseGenerateSpec(JSON.stringify(generate));
  if (!parsed.ok) throw new Error(`generate-instead specification is invalid: ${parsed.errors.join('; ')}`);
  return {
    version: GENERATE_INSTEAD_VERSION,
    origin: 'environment-refresh',
    targetSessionId: text(input.targetSessionId, 'generate-instead targetSessionId'),
    targetConnectionId: text(input.targetConnectionId, 'generate-instead targetConnectionId'),
    specSha256: input.specSha256,
    generate: parsed.spec,
  };
}

function seed(spec: RefreshSpec, offset: number): number {
  const digest = sha256Hex(Array.from(new TextEncoder().encode(`environment-refresh\0${spec.seed}`)));
  const base = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
  return (base + (offset % 0x1_0000_0000)) % 0x1_0000_0000;
}

function generated(table: RefreshGraphTable, name: string): boolean {
  return table.generatedColumns.includes(name);
}

function foreignKeyColumns(catalog: RefreshCatalogAnalysis, table: RefreshGraphTable): Set<string> {
  return new Set(catalog.graph.foreignKeys.filter(edge => edge.schema === table.schema && edge.table === table.name)
    .flatMap(edge => edge.parts.map(part => part.column)));
}

export function buildGenerateInsteadHandoff(input: {
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
  maskPlan: RefreshMaskPlan;
  policy: Extract<RefreshTablePolicy, { policy: 'generate' }>;
}): GenerateInsteadResult {
  const { spec, catalog, maskPlan, policy } = input;
  const errors: string[] = [];
  if (!spec.target.sessionId) errors.push('choose and reconfirm the target session before opening datagen');
  if (!spec.target.connectionId) errors.push('target connection identity is missing');
  if (!catalog.complete) errors.push('catalog compatibility must be complete before a generate handoff');
  if (!maskPlan.complete) errors.push('mask safety must be complete before a generate handoff');
  const plan = buildRefreshPlan(spec);
  if (maskPlan.specSha256 !== plan.specSha256 || catalog.plan.specSha256 !== plan.specSha256) {
    errors.push('catalog or mask evidence belongs to a different Refresh specification');
  }
  const resolved = resolveRefreshTable(spec, policy.table);
  if (typeof resolved === 'string') errors.push(resolved);
  const sourceKey = typeof resolved === 'string' ? policy.table : `${resolved.sourceSchema}.${resolved.tableName}`;
  const table = catalog.graph.tables.find(candidate => candidate.key === sourceKey);
  if (!table) errors.push(`${sourceKey} has no source catalog metadata for datagen`);
  if (!table || typeof resolved === 'string') return { ok: false, errors };

  const fkColumns = foreignKeyColumns(catalog, table);
  const masks = new Map<string, RefreshSpec['masks'][number]>();
  for (const mask of spec.masks) {
    const maskTable = resolveRefreshTable(spec, mask.table);
    if (typeof maskTable !== 'string' && `${maskTable.sourceSchema}.${maskTable.tableName}` === sourceKey) {
      masks.set(mask.column, mask);
    }
  }
  const specs: ColumnSpec[] = [];
  for (const column of table.columns) {
    if (generated(table, column.name)) continue;
    const mask = masks.get(column.name);
    const rule = maskPlan.rules.find(candidate => candidate.table === sourceKey && candidate.column === column.name);
    const primary = table.primaryKey?.columns.includes(column.name) ?? false;
    let spec: ColumnSpec;
    if (fkColumns.has(column.name) && mask && mask.rule !== 'preserve' && !input.spec.allowFkBreaking) {
      errors.push(`${sourceKey}.${column.name} uses a non-preserve FK mask; datagen cannot prove relational equality for this handoff`);
      continue;
    }
    if (mask?.rule === 'hash' || (rule && ['format', 'format_preserving', 'format-preserving'].includes(rule.generator ?? ''))) {
      errors.push(`${sourceKey}.${column.name} uses a source-value-dependent ${mask?.rule ?? 'format'} mask; generate instead cannot reproduce it without production rows`);
      continue;
    }
    if (mask?.rule === 'constant') {
      spec = {
        name: column.name, typeName: column.columnType, generator: 'constant',
        params: {
          ...DEFAULT_PARAMS,
          prefix: mask.value === null ? '' : String(mask.value),
          suffix: '', nullPct: mask.value === null ? 100 : 0,
        },
      };
    } else if (mask?.rule === 'fake') {
      if (!rule?.generator) {
        errors.push(`${sourceKey}.${column.name} has no resolved fake generator`);
        continue;
      }
      spec = { name: column.name, typeName: column.columnType, generator: rule.generator, params: { ...DEFAULT_PARAMS } };
    } else {
      spec = {
        name: column.name, typeName: column.columnType,
        generator: fkColumns.has(column.name) ? 'fk' : suggestGenerator(column.name, column.columnType, primary),
        params: { ...DEFAULT_PARAMS },
      };
    }
    const unique = table.uniqueKeys.filter(key => key.columns.includes(column.name));
    if (unique.length) {
      spec.unique = true;
      const composite = unique.find(key => key.columns.length > 1);
      if (composite) spec.params.uniqueGroup = composite.name;
    }
    specs.push(spec);
  }
  if (specs.length === 0) errors.push(`${sourceKey} has no non-generated columns available for datagen`);
  if (errors.length) return { ok: false, errors };
  const handoff: GenerateInsteadHandoff = {
    version: GENERATE_INSTEAD_VERSION,
    origin: 'environment-refresh',
    targetSessionId: spec.target.sessionId!,
    targetConnectionId: spec.target.connectionId,
    specSha256: plan.specSha256,
    generate: {
      table: `${resolved.targetSchema}.${resolved.tableName}`,
      rowCount: policy.rows,
      seed: seed(spec, policy.seedOffset),
      locale: 'default',
      useCopy: false,
      createDdl: null,
      specs,
    },
  };
  try {
    return { ok: true, handoff: parseGenerateInsteadHandoff(handoff) };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
