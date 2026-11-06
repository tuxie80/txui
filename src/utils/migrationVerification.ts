import { reviewTypesEqual } from './changeReview.ts';
import type {
  ChangeReviewEngine, ChangeReviewResult, ReviewForeignKey, ReviewIndex, ReviewTable,
} from './changeReview.ts';
import type { SchemaSnapshot } from './schemaRules.ts';

export interface MigrationFinalComparison {
  differences: string[];
  unverified: string[];
  notes: string[];
  expectedTables: ReviewTable[];
  actualTables: ReviewTable[];
  outOfScopeTables: string[];
}

export interface CompareMigrationFinalModelOptions {
  engine: ChangeReviewEngine;
  snapshot: SchemaSnapshot;
  review: ChangeReviewResult;
  actualTables: ReviewTable[];
  catalogComplete: boolean;
}

const norm = (name: string) => name.toLowerCase();
const columnsKey = (columns: string[]) => columns.map(norm).join(',');
const indexShape = (index: ReviewIndex) => `${index.unique ? 'unique' : 'nonunique'}:${columnsKey(index.columns)}`;
const fkAction = (action: string) => action.toUpperCase() === 'RESTRICT' ? 'NO ACTION' : action.toUpperCase();
const fkShape = (fk: ReviewForeignKey) => [
  columnsKey(fk.columns), norm(fk.refTable), columnsKey(fk.refColumns), fkAction(fk.onDelete),
].join(':');

function tableMap(tables: ReviewTable[], label: string, unverified: string[]): Map<string, ReviewTable> {
  const out = new Map<string, ReviewTable>();
  for (const table of tables) {
    const key = norm(table.name);
    if (out.has(key)) unverified.push(`${label} contains duplicate table name ${table.name}`);
    else out.set(key, table);
  }
  return out;
}

function scopedExpectedTables(snapshot: SchemaSnapshot, review: ChangeReviewResult): ReviewTable[] {
  const affected = new Set<string>();
  for (const statement of review.statements) {
    if (statement.table) {
      for (const name of statement.table.split(', ')) affected.add(norm(name));
    }
    for (const table of statement.after) affected.add(norm(table.name));
  }
  for (const table of review.tables) {
    if (table.source === 'migration') affected.add(norm(table.name));
  }
  for (;;) {
    const before = affected.size;
    for (const fk of snapshot.foreignKeys) {
      if (affected.has(norm(fk.table)) || affected.has(norm(fk.refTable))) {
        affected.add(norm(fk.table));
        affected.add(norm(fk.refTable));
      }
    }
    for (const table of review.tables) {
      for (const fk of table.foreignKeys) {
        if (affected.has(norm(table.name)) || affected.has(norm(fk.refTable))) {
          affected.add(norm(table.name));
          affected.add(norm(fk.refTable));
        }
      }
    }
    if (affected.size === before) break;
  }
  return review.tables.filter(table => affected.has(norm(table.name)));
}

function compareColumns(expected: ReviewTable, actual: ReviewTable, engine: ChangeReviewEngine): string[] {
  const differences: string[] = [];
  const actualByName = new Map(actual.columns.map(column => [norm(column.name), column]));
  const expectedByName = new Map(expected.columns.map(column => [norm(column.name), column]));
  for (const column of expected.columns) {
    const other = actualByName.get(norm(column.name));
    if (!other) {
      differences.push(`${expected.name}: missing column ${column.name}`);
      continue;
    }
    if (!reviewTypesEqual(column.type, other.type, engine)) {
      differences.push(`${expected.name}.${column.name}: type ${column.type} became ${other.type}`);
    }
    if (column.nullable !== other.nullable) {
      differences.push(`${expected.name}.${column.name}: nullability expected ${column.nullable ? 'NULL' : 'NOT NULL'}, actual ${other.nullable ? 'NULL' : 'NOT NULL'}`);
    }
    const implicitSerialDefault = engine === 'postgres'
      && /^(?:smallserial|serial|bigserial)\b/i.test(column.type) && other.hasDefault;
    if (column.hasDefault !== other.hasDefault && !implicitSerialDefault) {
      differences.push(`${expected.name}.${column.name}: default presence expected ${column.hasDefault}, actual ${other.hasDefault}`);
    }
  }
  for (const column of actual.columns) {
    if (!expectedByName.has(norm(column.name))) differences.push(`${expected.name}: unexpected column ${column.name}`);
  }
  if (expected.columns.length === actual.columns.length
      && expected.columns.every(column => actualByName.has(norm(column.name)))) {
    const expectedOrder = expected.columns.map(column => norm(column.name));
    const actualOrder = actual.columns.map(column => norm(column.name));
    if (expectedOrder.some((name, index) => name !== actualOrder[index])) {
      differences.push(`${expected.name}: column order expected ${expectedOrder.join(', ')}, actual ${actualOrder.join(', ')}`);
    }
  }
  return differences;
}

function compareIndexes(
  expected: ReviewTable,
  actual: ReviewTable,
  engine: ChangeReviewEngine,
  notes: string[],
): string[] {
  const differences: string[] = [];
  const used = new Set<ReviewIndex>();
  for (const index of expected.indexes) {
    const sameName = actual.indexes.find(candidate => norm(candidate.name) === norm(index.name));
    if (sameName) {
      used.add(sameName);
      if (indexShape(index) !== indexShape(sameName)) {
        differences.push(`${expected.name}: index ${index.name} expected ${indexShape(index)}, actual ${indexShape(sameName)}`);
      }
      continue;
    }
    const generated = /^(?:unique|idx)_/.test(index.name);
    const alias = generated ? actual.indexes.find(candidate =>
      !used.has(candidate) && indexShape(candidate) === indexShape(index)) : undefined;
    if (alias) {
      used.add(alias);
      notes.push(`${expected.name}: server named generated index ${alias.name} instead of modeled ${index.name}`);
    } else {
      differences.push(`${expected.name}: missing index ${index.name} (${indexShape(index)})`);
    }
  }
  for (const index of actual.indexes) {
    if (used.has(index)) continue;
    const supportingFk = engine === 'mysql' && !index.unique && expected.foreignKeys.some(fk =>
      columnsKey(fk.columns) === columnsKey(index.columns));
    if (supportingFk) notes.push(`${expected.name}: accepted MySQL foreign-key support index ${index.name}`);
    else differences.push(`${expected.name}: unexpected index ${index.name} (${indexShape(index)})`);
  }
  return differences;
}

function compareForeignKeys(expected: ReviewTable, actual: ReviewTable, notes: string[]): string[] {
  const differences: string[] = [];
  const used = new Set<ReviewForeignKey>();
  for (const fk of expected.foreignKeys) {
    const sameName = actual.foreignKeys.find(candidate => norm(candidate.name) === norm(fk.name));
    if (sameName) {
      used.add(sameName);
      if (fkShape(fk) !== fkShape(sameName)) {
        differences.push(`${expected.name}: foreign key ${fk.name} expected ${fkShape(fk)}, actual ${fkShape(sameName)}`);
      }
      continue;
    }
    const alias = fk.name.startsWith('fk_') ? actual.foreignKeys.find(candidate =>
      !used.has(candidate) && fkShape(candidate) === fkShape(fk)) : undefined;
    if (alias) {
      used.add(alias);
      notes.push(`${expected.name}: server named generated foreign key ${alias.name} instead of modeled ${fk.name}`);
    } else {
      differences.push(`${expected.name}: missing foreign key ${fk.name} (${fkShape(fk)})`);
    }
  }
  for (const fk of actual.foreignKeys) {
    if (!used.has(fk)) differences.push(`${expected.name}: unexpected foreign key ${fk.name} (${fkShape(fk)})`);
  }
  return differences;
}

function compareMigrationModel(
  options: CompareMigrationFinalModelOptions,
  targetScope: boolean,
): MigrationFinalComparison {
  const expectedTables = scopedExpectedTables(options.snapshot, options.review);
  const expectedNames = new Set(expectedTables.map(table => norm(table.name)));
  const actualNames = new Set(expectedNames);
  if (targetScope) {
    for (;;) {
      const before = actualNames.size;
      for (const table of options.actualTables) {
        for (const fk of table.foreignKeys) {
          if (actualNames.has(norm(table.name)) || actualNames.has(norm(fk.refTable))) {
            actualNames.add(norm(table.name));
            actualNames.add(norm(fk.refTable));
          }
        }
      }
      if (actualNames.size === before) break;
    }
  }
  const actualTables = targetScope
    ? options.actualTables.filter(table => actualNames.has(norm(table.name)))
    : options.actualTables;
  const outOfScopeTables = targetScope
    ? options.actualTables.filter(table => !actualNames.has(norm(table.name))).map(table => table.name).sort()
    : [];
  const label = targetScope ? 'target' : 'scratch';
  if (!options.catalogComplete) {
    return {
      differences: [], unverified: [`${label} catalog could not be read completely`], notes: [],
      expectedTables, actualTables, outOfScopeTables,
    };
  }
  const differences: string[] = [];
  const unverified: string[] = [];
  const notes: string[] = outOfScopeTables.length
    ? [`Excluded ${outOfScopeTables.length} unrelated target table(s) outside the affected/FK scope`]
    : [];
  const expectedByName = tableMap(expectedTables, 'expected model', unverified);
  const actualByName = tableMap(actualTables, `${label} catalog`, unverified);
  for (const expected of expectedTables) {
    if (!expected.complete) unverified.push(`expected table ${expected.name} has an incomplete model`);
    const actual = actualByName.get(norm(expected.name));
    if (!actual) {
      differences.push(`missing table ${expected.name}`);
      continue;
    }
    if (!actual.complete) unverified.push(`${label} table ${actual.name} has an incomplete catalog model`);
    differences.push(...compareColumns(expected, actual, options.engine));
    differences.push(...compareIndexes(expected, actual, options.engine, notes));
    differences.push(...compareForeignKeys(expected, actual, notes));
  }
  for (const actual of actualTables) {
    if (!expectedByName.has(norm(actual.name))) differences.push(`unexpected table ${actual.name}`);
  }
  return {
    differences: [...new Set(differences)].sort(),
    unverified: [...new Set(unverified)].sort(),
    notes: [...new Set(notes)].sort(),
    expectedTables,
    actualTables,
    outOfScopeTables,
  };
}

export function compareMigrationFinalModel(options: CompareMigrationFinalModelOptions): MigrationFinalComparison {
  return compareMigrationModel(options, false);
}

export function compareMigrationTargetModel(options: CompareMigrationFinalModelOptions): MigrationFinalComparison {
  return compareMigrationModel(options, true);
}
