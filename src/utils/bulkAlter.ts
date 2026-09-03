/**
 * Changing many tables at once.
 *
 * HeidiSQL's bulk table editor, and the reason it is on the list: setting a
 * collation across forty tables by hand is forty chances to miss one, and a
 * schema where thirty-nine tables are `utf8mb4_0900_ai_ci` and one is
 * `utf8mb4_general_ci` produces join failures that look like data problems.
 *
 * It is also the most dangerous thing in this application. `ALTER TABLE …
 * ENGINE=` or `… CONVERT TO CHARACTER SET` **rewrites every row**. Across forty
 * tables that is not a slow operation, it is an outage — and unlike a bad
 * `DELETE` there is no transaction to roll back, because MySQL commits DDL
 * implicitly.
 *
 * So this module's job is not to build SQL. It is to know, for each change,
 * exactly how expensive it is and to say so before anything runs.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

export type BulkField = 'engine' | 'collation' | 'charset' | 'comment' | 'rowFormat';

/** How much work the server does for a change. */
export type AlterCost = 'metadata' | 'rebuild';

export interface FieldSpec {
  id: BulkField;
  label: string;
  cost: AlterCost;
  /** What actually happens on the server. */
  effect: string;
  engines: string[];
}

export const FIELDS: FieldSpec[] = [
  {
    id: 'comment',
    label: 'Comment',
    cost: 'metadata',
    effect: 'Changes the table comment only. Instant, no data touched.',
    engines: ['mysql'],
  },
  {
    id: 'engine',
    label: 'Storage engine',
    cost: 'rebuild',
    effect: 'REBUILDS the table — every row is rewritten and the table is locked '
      + 'for the whole operation.',
    engines: ['mysql'],
  },
  {
    id: 'charset',
    label: 'Character set',
    cost: 'rebuild',
    effect: 'CONVERT TO CHARACTER SET rewrites every row and can CHANGE STORED '
      + 'VALUES where a character has no equivalent in the target set.',
    engines: ['mysql'],
  },
  {
    id: 'collation',
    label: 'Collation',
    cost: 'rebuild',
    effect: 'Rewrites the table and rebuilds every index on a text column, since '
      + 'collation decides their sort order.',
    engines: ['mysql'],
  },
  {
    id: 'rowFormat',
    label: 'Row format',
    cost: 'rebuild',
    effect: 'REBUILDS the table — every row is rewritten. COMPRESSED in particular '
      + 'changes the on-disk size and the CPU cost of every read.',
    engines: ['mysql'],
  },
];

export function fieldsFor(engine: string): FieldSpec[] {
  return FIELDS.filter(f => f.engines.includes(engine));
}

export function findField(id: string): FieldSpec | undefined {
  return FIELDS.find(f => f.id === id);
}

export interface BulkChange {
  field: BulkField;
  /** The new value. */
  value: string;
}

export interface BulkTable {
  schema: string;
  name: string;
  /** Current values, so a no-op can be skipped. */
  engine?: string;
  collation?: string;
  charset?: string;
  comment?: string;
  rowFormat?: string;
  /** Approximate rows — drives the cost warning. */
  rows?: number;
}

export interface PlannedAlter {
  schema: string;
  name: string;
  sql: string;
  cost: AlterCost;
  /** Estimated rows this rewrites, when a rebuild. */
  rows?: number;
}

export interface BulkPlan {
  alters: PlannedAlter[];
  /** Tables already at the target value. */
  skipped: Array<{ name: string; reason: string }>;
  /** True when any statement rewrites data. */
  rebuilds: boolean;
  /** Total rows that will be rewritten, as far as the catalog knows. */
  rowsAffected: number;
}

const q = (name: string) => quoteIdent(name, 'mysql');
const lit = (value: string) => sqlLiteral(value, 'mysql');

/** The current value of a field on a table. */
export function currentValue(table: BulkTable, field: BulkField): string | undefined {
  switch (field) {
    case 'engine':    return table.engine;
    case 'collation': return table.collation;
    case 'charset':   return table.charset;
    case 'comment':   return table.comment;
    case 'rowFormat': return table.rowFormat;
  }
}

/** The ALTER clause for one change. */
export function alterClause(change: BulkChange): string {
  const v = change.value;
  switch (change.field) {
    case 'engine':    return `ENGINE = ${v.replace(/[^\w]/g, '')}`;
    case 'rowFormat': return `ROW_FORMAT = ${v.replace(/[^\w]/g, '')}`;
    case 'comment':   return `COMMENT = ${lit(v)}`;
    // Collation implies its charset, so converting is the correct statement —
    // setting DEFAULT COLLATE alone changes new columns only and leaves the
    // existing ones on the old collation, which is the trap this avoids.
    case 'collation': return `CONVERT TO CHARACTER SET ${charsetOf(v)} COLLATE ${v.replace(/[^\w]/g, '')}`;
    case 'charset':   return `CONVERT TO CHARACTER SET ${v.replace(/[^\w]/g, '')}`;
  }
}

/**
 * The charset a collation belongs to.
 *
 * MySQL collations are named `<charset>_<rest>`, so the prefix is the charset.
 * Deriving it beats asking the user for both and letting them disagree.
 */
export function charsetOf(collation: string): string {
  const clean = collation.replace(/[^\w]/g, '');
  const i = clean.indexOf('_');
  return i > 0 ? clean.slice(0, i) : clean;
}

/**
 * Plan the change across a set of tables.
 *
 * Tables already at the target are skipped and *reported* as skipped — running
 * a no-op `CONVERT TO CHARACTER SET` still rebuilds the table, so silently
 * including them would turn a five-table change into a forty-table outage.
 */
export function planBulk(
  tables: BulkTable[], change: BulkChange,
): BulkPlan {
  const spec = findField(change.field);
  const alters: PlannedAlter[] = [];
  const skipped: BulkPlan['skipped'] = [];

  for (const t of tables) {
    const now = currentValue(t, change.field);
    if (now !== undefined && now.toLowerCase() === change.value.trim().toLowerCase()) {
      skipped.push({ name: t.name, reason: `already ${change.value}` });
      continue;
    }
    alters.push({
      schema: t.schema,
      name: t.name,
      sql: `ALTER TABLE ${q(t.schema)}.${q(t.name)} ${alterClause(change)}`,
      cost: spec?.cost ?? 'rebuild',
      rows: t.rows,
    });
  }

  const rebuilds = alters.some(a => a.cost === 'rebuild');
  return {
    alters,
    skipped,
    rebuilds,
    rowsAffected: rebuilds
      ? alters.reduce((n, a) => n + (a.rows ?? 0), 0)
      : 0,
  };
}

/**
 * The sentence shown before anything runs.
 *
 * States the row count, because "12 tables" and "12 tables, 400 million rows"
 * are different decisions and only one of them is safe during business hours.
 */
export function planWarning(plan: BulkPlan, spec: FieldSpec | undefined): string | null {
  if (plan.alters.length === 0) return null;
  if (!plan.rebuilds) return null;
  const n = plan.alters.length;
  const rows = plan.rowsAffected;
  const scale = rows > 0
    ? ` — approximately ${rows.toLocaleString()} rows will be rewritten`
    : '';
  return `${n} table${n === 1 ? '' : 's'} will be REBUILT${scale}. `
    + `${spec?.effect ?? ''} `
    + 'MySQL commits DDL implicitly, so there is no transaction to roll this back. '
    + 'Take a backup first.';
}

/** Common targets, so the value is picked rather than typed. */
export const COMMON_ENGINES = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE'];
export const COMMON_COLLATIONS = [
  'utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8mb4_bin',
  'latin1_swedish_ci',
];
export const COMMON_CHARSETS = ['utf8mb4', 'utf8mb3', 'latin1', 'ascii', 'binary'];
export const COMMON_ROW_FORMATS = ['DYNAMIC', 'COMPRESSED', 'COMPACT', 'REDUNDANT'];

export function suggestionsFor(field: BulkField): string[] {
  switch (field) {
    case 'engine':    return COMMON_ENGINES;
    case 'collation': return COMMON_COLLATIONS;
    case 'charset':   return COMMON_CHARSETS;
    case 'rowFormat': return COMMON_ROW_FORMATS;
    case 'comment':   return [];
  }
}
