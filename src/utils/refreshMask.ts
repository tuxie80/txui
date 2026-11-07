import { DEFAULT_PARAMS, GENERATOR_MAP, makeRng } from './datagen.ts';
import { sha256Hex } from './datagenStandards.ts';
import { DEFAULT_LOCALE } from '../data/dictionaries.ts';
import { resolveRefreshTable, buildRefreshPlan } from './refreshPlan.ts';
import { refreshCatalogSha256 } from './refreshExecution.ts';
import type { RefreshCatalogAnalysis, RefreshForeignKeyEdge } from './refreshCatalog.ts';
import type { RefreshMaskRule, RefreshSpec } from './refreshSpec.ts';

export type RefreshMaskValue = string | number | boolean | null;

export interface RefreshMaskPlanRule {
  table: string;
  column: string;
  rule: RefreshMaskRule['rule'];
  generator: string | null;
  relation: string | null;
  notes: string[];
}

export interface RefreshMaskPlan {
  specSha256: string;
  catalogSha256: string;
  complete: boolean;
  rules: RefreshMaskPlanRule[];
  blockers: string[];
}

interface ResolvedRule extends RefreshMaskPlanRule {
  scope: string;
  source: RefreshMaskRule;
}

const GENERATOR_ALIASES: Record<string, string> = {
  'person.full_name': 'fullName',
  'person.first_name': 'firstName',
  'person.last_name': 'lastName',
  'internet.email': 'email',
  'internet.username': 'username',
  'company.name': 'company',
  'address.city': 'city',
  'address.country': 'country',
  'phone.number': 'phone',
  'uuid.v4': 'uuid',
};
const FORMAT_GENERATORS = new Set(['format', 'format_preserving', 'format-preserving']);
const TEXT_TYPES = /char|text|json|enum|set/i;

function bytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function canonical(value: RefreshMaskValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numbers cannot be masked deterministically');
    return `number:${String(value)}`;
  }
  if (typeof value === 'boolean') return `boolean:${value ? 1 : 0}`;
  if (typeof value === 'string') return `string:${bytes(value).length}:${value}`;
  throw new Error('only scalar text, numeric, boolean and NULL values can be masked');
}

function generatorName(rule: RefreshMaskRule): string | null {
  if (rule.rule !== 'fake') return null;
  return GENERATOR_ALIASES[rule.generator] ?? rule.generator;
}

function signature(rule: RefreshMaskRule): string {
  if (rule.rule === 'constant') return JSON.stringify([rule.rule, rule.value]);
  if (rule.rule === 'fake') return JSON.stringify([rule.rule, generatorName(rule)]);
  return JSON.stringify([rule.rule]);
}

function relationColumns(edge: RefreshForeignKeyEdge): { table: string; column: string; relation: string }[] {
  return edge.parts.flatMap(part => [
    { table: `${edge.schema}.${edge.table}`, column: part.column, relation: `${edge.key}:${part.ordinal}` },
    { table: `${edge.refSchema}.${edge.refTable}`, column: part.refColumn, relation: `${edge.key}:${part.ordinal}` },
  ]);
}

function defaultRule(table: string, column: string): RefreshMaskRule {
  return { table, column, rule: 'preserve' };
}

export function buildRefreshMaskPlan(input: {
  spec: RefreshSpec;
  catalog: RefreshCatalogAnalysis;
}): RefreshMaskPlan {
  const { spec, catalog } = input;
  const blockers = new Set<string>();
  const rules: ResolvedRule[] = [];
  const relations = new Map<string, string>();
  for (const edge of catalog.graph.foreignKeys) {
    for (const item of relationColumns(edge)) relations.set(`${item.table}.${item.column}`, item.relation);
  }
  const byRelation = new Map<string, { rule: RefreshMaskRule; table: string }[]>();
  for (const edge of catalog.graph.foreignKeys) {
    for (const item of relationColumns(edge)) {
      const related = byRelation.get(item.relation) ?? [];
      related.push({ rule: defaultRule(item.table, item.column), table: item.table });
      byRelation.set(item.relation, related);
    }
  }
  for (const mask of spec.masks) {
    const resolved = resolveRefreshTable(spec, mask.table);
    if (typeof resolved === 'string') {
      blockers.add(resolved);
      continue;
    }
    const sourceName = `${resolved.sourceSchema}.${resolved.tableName}`;
    const source = catalog.graph.tables.find(table => table.key === sourceName);
    const column = source?.columns.find(candidate => candidate.name === mask.column);
    if (!source || !column) {
      blockers.add(`${sourceName}.${mask.column} has no source catalog column`);
      continue;
    }
    const relation = relations.get(`${sourceName}.${mask.column}`) ?? null;
    if (relation) {
      const related = byRelation.get(relation) ?? [];
      const existing = related.findIndex(item => item.table === sourceName);
      if (existing >= 0) related[existing] = { rule: mask, table: sourceName };
      else related.push({ rule: mask, table: sourceName });
      byRelation.set(relation, related);
    }
    const generator = generatorName(mask);
    if (mask.rule === 'fake' && !FORMAT_GENERATORS.has(generator!) && !GENERATOR_MAP.has(generator!)) {
      blockers.add(`${sourceName}.${mask.column} uses unknown seeded generator ${mask.generator}`);
    }
    if (mask.rule === 'constant') {
      if (mask.value === null && !column.nullable) blockers.add(`${sourceName}.${mask.column} is NOT NULL and cannot use a NULL constant`);
      if (typeof mask.value === 'number' && !/int|decimal|numeric|float|double|year/i.test(column.dataType)) {
        blockers.add(`${sourceName}.${mask.column} is ${column.dataType}, not a numeric column`);
      }
      if (typeof mask.value === 'boolean' && !/bool|bit|tinyint/i.test(column.dataType)) {
        blockers.add(`${sourceName}.${mask.column} is ${column.dataType}, not a boolean-compatible column`);
      }
      if (typeof mask.value === 'string' && !TEXT_TYPES.test(column.dataType)) {
        blockers.add(`${sourceName}.${mask.column} is ${column.dataType}, not a text column`);
      }
    }
    if (mask.rule === 'hash') {
      if (!TEXT_TYPES.test(column.dataType)) blockers.add(`${sourceName}.${mask.column} cannot store a SHA-256 text mask in ${column.dataType}`);
      if (column.charMaxLen != null && column.charMaxLen < 64) blockers.add(`${sourceName}.${mask.column} is limited to ${column.charMaxLen} characters; SHA-256 needs 64`);
    }
    if (mask.rule === 'fake' && !TEXT_TYPES.test(column.dataType)) {
      blockers.add(`${sourceName}.${mask.column} fake text masks require a text column, not ${column.dataType}`);
    }
    rules.push({
      table: sourceName, column: mask.column, rule: mask.rule, generator, relation,
      scope: relation && !spec.allowFkBreaking ? `relation:${relation}` : `column:${sourceName}.${mask.column}`,
      source: mask,
      notes: relation
        ? [spec.allowFkBreaking ? 'Explicit FK-breaking mask enabled; relational equality is not preserved' : 'Relational seed shared with the corresponding FK column']
        : [],
    });
  }
  for (const [relation, related] of byRelation) {
    if (spec.allowFkBreaking) continue;
    const first = related[0];
    if (related.some(item => signature(item.rule) !== signature(first.rule))) {
      blockers.add(`foreign-key relation ${relation} has different mask rules; relational equality would break. Use the same rule or explicitly allow FK breaking`);
    }
  }
  rules.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
  return {
    specSha256: buildRefreshPlan(spec).specSha256,
    catalogSha256: refreshCatalogSha256(catalog),
    complete: blockers.size === 0,
    rules: rules.map(({ table, column, rule, generator, relation, notes }) => ({ table, column, rule, generator, relation, notes })),
    blockers: [...blockers].sort(),
  };
}

function seedParts(seed: string, scope: string, value: RefreshMaskValue): { seed: number; rowIndex: number } {
  const digest = sha256Hex(bytes(`${seed}\u0000${scope}\u0000${canonical(value)}`));
  return {
    seed: Number.parseInt(digest.slice(0, 8), 16) >>> 0,
    rowIndex: Number.parseInt(digest.slice(8, 16), 16) >>> 0,
  };
}

function formatPreserve(value: string, seed: string, scope: string): string {
  return Array.from(value).map((character, index) => {
    const digest = sha256Hex(bytes(`${seed}\u0000${scope}\u0000format\u0000${index}\u0000${canonical(value)}`));
    const number = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
    if (/\p{L}/u.test(character)) {
      const alphabet = character === character.toUpperCase() ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'abcdefghijklmnopqrstuvwxyz';
      return alphabet[number % alphabet.length];
    }
    if (/\p{N}/u.test(character)) return String(number % 10);
    return character;
  }).join('');
}

function assertScalar(value: unknown): RefreshMaskValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error('seeded generator returned an unsupported non-scalar mask value');
}

export function createRefreshMaskRuntime(plan: RefreshMaskPlan, spec: RefreshSpec): {
  rules: ResolvedRule[];
  apply: (table: string, column: string, value: RefreshMaskValue) => RefreshMaskValue;
} {
  if (!plan.complete) throw new Error('mask plan has blockers; no values may be transformed');
  if (plan.specSha256 !== buildRefreshPlan(spec).specSha256) throw new Error('mask plan belongs to a different specification');
  const rules: ResolvedRule[] = plan.rules.map(rule => {
    const source = spec.masks.find(mask => {
      const resolved = resolveRefreshTable(spec, mask.table);
      return typeof resolved !== 'string' && `${resolved.sourceSchema}.${resolved.tableName}` === rule.table && mask.column === rule.column;
    });
    if (!source) throw new Error(`${rule.table}.${rule.column} mask rule is missing from the specification`);
    return {
      ...rule,
      scope: rule.relation && !spec.allowFkBreaking ? `relation:${rule.relation}` : `column:${rule.table}.${rule.column}`,
      source,
    };
  });
  const runtime = {
    rules,
    apply: (table: string, column: string, value: RefreshMaskValue): RefreshMaskValue => {
      const rule = rules.find(candidate => candidate.table === table && candidate.column === column);
      if (!rule) return value;
      if (value === null) return null;
      if (rule.rule === 'preserve') return value;
      if (rule.rule === 'constant' && rule.source.rule === 'constant') return rule.source.value;
      const { seed, rowIndex } = seedParts(spec.seed, rule.scope, value);
      if (rule.rule === 'hash') return sha256Hex(bytes(`${spec.seed}\u0000${rule.scope}\u0000${canonical(value)}`));
      if (FORMAT_GENERATORS.has(rule.generator!)) return formatPreserve(String(value), spec.seed, rule.scope);
      const generator = GENERATOR_MAP.get(rule.generator!);
      if (!generator) throw new Error(`${table}.${column} uses unknown seeded generator ${rule.generator}`);
      return assertScalar(generator.gen(makeRng(seed), rowIndex, DEFAULT_PARAMS, 1, DEFAULT_LOCALE));
    },
  };
  return runtime;
}
