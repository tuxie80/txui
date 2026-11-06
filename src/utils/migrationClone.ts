import type { ChangeReviewResult } from './changeReview.ts';
import type { CatalogFk, SchemaSnapshot } from './schemaRules.ts';

export interface MigrationCloneTable {
  name: string;
  serial_columns: string[];
}

export interface MigrationCloneForeignKey {
  name: string;
  table: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete: string;
  on_update: string;
  validated?: boolean;
  match_type?: 'full' | 'partial' | 'simple';
  deferrable?: boolean;
  deferred?: boolean;
}

export interface MigrationCloneResult {
  run_key: string;
  tables_cloned: number;
  statements_executed: number;
  total_statements: number;
  serial_sequences: number;
  foreign_keys_added: number;
}

export interface MigrationCloneInput {
  affected: string[];
  tables: MigrationCloneTable[];
  foreignKeys: MigrationCloneForeignKey[];
}

export function buildMigrationCloneInput(snapshot: SchemaSnapshot, review: ChangeReviewResult): MigrationCloneInput {
  const existing = new Set(snapshot.tables.map(table => table.name));
  const affected = [...new Set(review.statements.map(statement => statement.table)
    .filter((table): table is string => table !== null && existing.has(table)))];
  const serialByTable = new Map<string, string[]>();
  for (const column of snapshot.columns) {
    if (!/\bserial\b/i.test(column.extra)) continue;
    const columns = serialByTable.get(column.table) ?? [];
    columns.push(column.name);
    serialByTable.set(column.table, columns);
  }
  const tables = snapshot.tables.map(table => ({
    name: table.name,
    serial_columns: serialByTable.get(table.name) ?? [],
  }));
  const grouped = new Map<string, {
    value: MigrationCloneForeignKey;
    parts: { column: string; ref: string; ordinal: number }[];
  }>();
  for (const fk of snapshot.foreignKeys) {
    const key = [fk.name, fk.table, fk.refTable, fk.onDelete, fk.onUpdate,
      fk.matchType ?? '', String(fk.deferrable), String(fk.deferred)].join('\u0000');
    const part = { column: fk.column, ref: fk.refColumn, ordinal: fk.ordinal };
    const existing = grouped.get(key);
    if (existing) {
      existing.parts.push(part);
      continue;
    }
    grouped.set(key, {
      value: {
        name: fk.name,
        table: fk.table,
        columns: [],
        ref_table: fk.refTable,
        ref_columns: [],
        on_delete: fk.onDelete,
        on_update: fk.onUpdate,
        validated: fk.validated,
        match_type: fk.matchType,
        deferrable: fk.deferrable,
        deferred: fk.deferred,
      },
      parts: [part],
    });
  }
  const foreignKeys = [...grouped.values()].map(group => {
    group.parts.sort((a, b) => a.ordinal - b.ordinal);
    group.value.columns = group.parts.map(part => part.column);
    group.value.ref_columns = group.parts.map(part => part.ref);
    return group.value;
  });
  return { affected, tables, foreignKeys };
}

export function foreignKeyColumns(fk: CatalogFk[]): { columns: string[]; refColumns: string[] } {
  const ordered = [...fk].sort((a, b) => a.ordinal - b.ordinal);
  return {
    columns: ordered.map(item => item.column),
    refColumns: ordered.map(item => item.refColumn),
  };
}
