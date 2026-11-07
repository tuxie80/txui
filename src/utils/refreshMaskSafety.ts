import { resolveRefreshTable } from './refreshPlan.ts';
import { buildRefreshMaskPlan } from './refreshMask.ts';
import type { RefreshMaskPlan, RefreshMaskValue } from './refreshMask.ts';
import type { RefreshCatalogAnalysis, RefreshGraphTable } from './refreshCatalog.ts';
import type { RefreshRowSetPlan } from './refreshRowSets.ts';
import type { RefreshSpec } from './refreshSpec.ts';
import type { CatalogColumn } from './schemaRules.ts';

export interface RefreshUniqueCheck {
  table: string;
  index: string;
  columns: string[];
  guaranteedCollision: boolean;
  note: string;
}

export interface RefreshMaskSafety {
  complete: boolean;
  maskPlan: RefreshMaskPlan;
  uniqueChecks: RefreshUniqueCheck[];
  sensitiveUnmasked: string[];
  sensitiveMasked: string[];
  generatedColumns: string[];
  notes: string[];
  blockers: string[];
}

export interface RefreshCommittedScope {
  committedRows: number;
  inFlightRows: number;
}

export class RefreshMaskSafetyError extends Error {
  public readonly code: 'collision' | 'planning_cap' | 'generated_insert';
  public readonly table: string;
  public readonly index: string;
  public readonly columns: string[];
  public readonly committedScope: RefreshCommittedScope;

  constructor(
    code: 'collision' | 'planning_cap' | 'generated_insert',
    table: string,
    index: string,
    columns: string[],
    committedScope: RefreshCommittedScope,
  ) {
    super(code === 'collision'
      ? `${table}: masked values collide on unique index ${index} (${columns.join(', ')}); abort the affected batch`
      : code === 'planning_cap'
        ? `${table}: unique collision tracking exceeds its key cap; abort the affected batch`
        : `${table}: generated columns must not be inserted (${columns.join(', ')})`);
    this.name = 'RefreshMaskSafetyError';
    this.code = code;
    this.table = table;
    this.index = index;
    this.columns = columns;
    this.committedScope = committedScope;
  }
}

const UNSUPPORTED = /binary|blob|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geography|^bit$/i;
const NUMERIC = /int|decimal|numeric|float|double|year/i;
const SENSITIVE = /email|password|passwd|secret|token|api[_-]?key|ssn|social[_-]?security|credit[_-]?card|card[_-]?number|iban|bic|phone|mobile|address|full[_-]?name|first[_-]?name|last[_-]?name|dob|birth|passport|national[_-]?id|license|private[_-]?key|auth/i;

function generated(column: CatalogColumn): boolean {
  return column.generationExpression != null || /\bgenerated\b/i.test(column.extra);
}

function masksByColumn(safety: RefreshMaskPlan): Map<string, RefreshMaskPlan['rules'][number]> {
  return new Map(safety.rules.map(rule => [`${rule.table}.${rule.column}`, rule]));
}

export function refreshInsertColumns(table: RefreshGraphTable): string[] {
  return table.columns.filter(column => !generated(column)).map(column => column.name);
}

function uniqueChecks(
  spec: RefreshSpec,
  catalog: RefreshCatalogAnalysis,
  maskPlan: RefreshMaskPlan,
  rowSets: RefreshRowSetPlan,
): { checks: RefreshUniqueCheck[]; blockers: string[] } {
  const blockers: string[] = [];
  const checks: RefreshUniqueCheck[] = [];
  const masks = masksByColumn(maskPlan);
  for (const table of catalog.graph.tables) {
    const counts = rowSets.tables.find(item => item.table === table.key);
    const finalRows = counts?.final ?? 0;
    for (const index of table.indexes) {
      if (!index.unique && index.name !== 'PRIMARY') continue;
      const columns = [...index.columns].sort((a, b) => a.seq - b.seq).map(column => column.name);
      const masked = columns.filter(column => {
        const rule = masks.get(`${table.key}.${column}`);
        return rule && rule.rule !== 'preserve';
      });
      if (masked.length === 0) continue;
      const constantParts = columns.every(column => {
        const rule = masks.get(`${table.key}.${column}`);
        return rule?.rule === 'constant' && rule !== undefined
          && spec.masks.some(mask => mask.rule === 'constant' && mask.value !== null
            && (() => {
              try {
                const resolved = resolveRefreshTable(spec, mask.table);
                return typeof resolved !== 'string' && `${resolved.sourceSchema}.${resolved.tableName}` === table.key && mask.column === column;
              } catch {
                return false;
              }
            })());
      });
      const guaranteedCollision = finalRows > 1 && constantParts;
      if (guaranteedCollision) {
        blockers.push(`${table.key}: constant masks guarantee a collision on unique index ${index.name} (${columns.join(', ')}) across ${finalRows} selected rows`);
      }
      checks.push({
        table: table.key, index: index.name, columns, guaranteedCollision,
        note: guaranteedCollision
          ? 'Collision is guaranteed before execution'
          : 'Runtime composite-unique collision detection is required before each target batch',
      });
    }
  }
  return { checks, blockers };
}

export function analyzeRefreshMaskSafety(input: {
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
  rowSets: RefreshRowSetPlan;
}): RefreshMaskSafety {
  const { spec, catalog, rowSets } = input;
  const maskPlan = buildRefreshMaskPlan({ spec, catalog });
  const blockers = new Set<string>(maskPlan.blockers);
  const masks = masksByColumn(maskPlan);
  const sensitiveUnmasked: string[] = [];
  const sensitiveMasked: string[] = [];
  const generatedColumns: string[] = [];
  for (const table of catalog.graph.tables) {
    for (const column of table.columns) {
      const name = `${table.key}.${column.name}`;
      const rule = masks.get(name);
      if (generated(column)) {
        generatedColumns.push(name);
        if (rule && rule.rule !== 'preserve') blockers.add(`${name} is generated and must be recomputed by the target, not masked or inserted`);
      }
      if (UNSUPPORTED.test(column.dataType) && rule && rule.rule !== 'preserve') {
        blockers.add(`${name} has unsupported ${column.dataType} type for a ${rule.rule} mask`);
      }
      if (SENSITIVE.test(column.name)) {
        if (!rule || rule.rule === 'preserve') sensitiveUnmasked.push(name);
        else sensitiveMasked.push(name);
      }
    }
  }
  sensitiveUnmasked.sort();
  sensitiveMasked.sort();
  generatedColumns.sort();
  if (sensitiveUnmasked.length > 0 && !spec.acknowledgeUnmaskedSensitive) {
    blockers.add(`${sensitiveUnmasked.length} sensitive-looking columns remain unmasked; review and explicitly acknowledge them: ${sensitiveUnmasked.join(', ')}`);
  }
  const unique = uniqueChecks(spec, catalog, maskPlan, rowSets);
  for (const blocker of unique.blockers) blockers.add(blocker);
  const notes = [
    `${unique.checks.length} unique indexes require runtime collision detection before target batches`,
    `${generatedColumns.length} generated columns are omitted from inserts and recomputed by the target`,
    `${sensitiveUnmasked.length} unmasked sensitive-looking columns listed for acknowledgment; ${sensitiveMasked.length} have mask rules`,
  ];
  if (spec.acknowledgeUnmaskedSensitive && sensitiveUnmasked.length > 0) notes.push('Unmasked sensitive columns are explicitly acknowledged; this is not execution proof');
  return {
    complete: blockers.size === 0,
    maskPlan, uniqueChecks: unique.checks, sensitiveUnmasked, sensitiveMasked, generatedColumns,
    notes, blockers: [...blockers].sort(),
  };
}

function normalizeNumeric(value: RefreshMaskValue): string {
  const text = String(value).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new Error(`non-numeric value in a numeric unique column`);
  const integer = match[2] ?? '';
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100_000) throw new Error('numeric exponent is too large');
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  let normalized: string;
  if (point <= 0) normalized = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) normalized = digits + '0'.repeat(point - digits.length);
  else normalized = `${digits.slice(0, point)}.${digits.slice(point)}`;
  let [whole, decimal] = normalized.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  decimal = (decimal ?? '').replace(/0+$/, '');
  if (/^0+$/.test(whole) && decimal === '') return '0';
  return `${match[1] === '-' ? '-' : ''}${whole}${decimal ? `.${decimal}` : ''}`;
}

function canonical(column: CatalogColumn, value: RefreshMaskValue): string {
  if (value === null) return 'null';
  if (NUMERIC.test(column.dataType)) return `n:${normalizeNumeric(value)}`;
  if (typeof value === 'boolean') return `b:${value ? 1 : 0}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite value in a unique column');
    return `n:${normalizeNumeric(value)}`;
  }
  if (typeof value !== 'string') throw new Error(`${column.name} has an unsupported unique-key value type`);
  let text = value;
  const collation = column.collation?.toLowerCase() ?? '';
  if (!collation.endsWith('_bin')) text = text.replace(/\s+$/u, '');
  if (collation.includes('_ai')) text = text.normalize('NFD').replace(/\p{M}/gu, '');
  if (collation.includes('_ci')) text = text.toLocaleLowerCase('und');
  return `s:${text}`;
}

export function createRefreshMaskCollisionTracker(input: {
  spec: RefreshSpec;
  safety: RefreshMaskSafety;
  catalog: RefreshCatalogAnalysis;
}): {
  check: (table: string, row: Record<string, RefreshMaskValue>, committedScope: RefreshCommittedScope) => void;
  acceptedRows: () => number;
} {
  if (!input.safety.complete) throw new Error('mask safety has blockers; collision tracking cannot start');
  const seen = new Map<string, Set<string>>();
  let seenKeys = 0;
  let accepted = 0;
  return {
    check: (tableName, row, committedScope) => {
      const table = input.catalog.graph.tables.find(candidate => candidate.key === tableName);
      if (!table) throw new Error(`${tableName} has no catalog table for collision tracking`);
      const generatedNames = table.columns.filter(generated).map(column => column.name);
      const presentGenerated = generatedNames.filter(name => name in row);
      if (presentGenerated.length) {
        throw new RefreshMaskSafetyError('generated_insert', tableName, 'generated', presentGenerated, committedScope);
      }
      const checks = input.safety.uniqueChecks.filter(check => check.table === tableName);
      for (const check of checks) {
        const values = check.columns.map(column => {
          if (!(column in row)) throw new Error(`${tableName}.${column} is missing from the outbound masked row`);
          return row[column];
        });
        if (values.some(value => value === null)) continue;
        const canonicalValues = check.columns.map((column, at) => {
          const metadata = table.columns.find(candidate => candidate.name === column);
          if (!metadata) throw new Error(`${tableName}.${column} has no catalog metadata`);
          return canonical(metadata, values[at]);
        });
        const identity = JSON.stringify(canonicalValues);
        const key = `${check.index}\u0000${identity}`;
        const tableSeen = seen.get(tableName) ?? new Set<string>();
        if (tableSeen.has(key)) {
          throw new RefreshMaskSafetyError('collision', tableName, check.index, check.columns, committedScope);
        }
        if (seenKeys >= input.spec.limits.maxPlanningKeys) {
          throw new RefreshMaskSafetyError('planning_cap', tableName, check.index, check.columns, committedScope);
        }
        tableSeen.add(key);
        seen.set(tableName, tableSeen);
        seenKeys += 1;
      }
      accepted += 1;
    },
    acceptedRows: () => accepted,
  };
}
