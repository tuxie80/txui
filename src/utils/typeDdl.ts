/**
 * User-defined types — reading them, and writing the DDL that changes them.
 *
 * PostgreSQL's three editable type kinds had no editor: a composite type, an
 * enum, and a domain were all "read the DDL box, then hand-write the CREATE /
 * ALTER in the SQL editor" jobs, exactly the gap the routine and sequence
 * editors were built to close. This module is the pure half — the SQL — with
 * `TypePanel` as the screen.
 *
 * Same two rules as the routine and sequence editors. **Show exactly what will
 * run before it runs**, and **quote every identifier and literal that the
 * editor inserts**, through `utils/sqlIdent` — a composite attribute called
 * `order`, or an enum value with an apostrophe, is otherwise broken SQL.
 *
 * ## What each kind can and cannot be altered into
 *
 * - **Composite** — attributes can be added, dropped, and retyped in place.
 * - **Enum** — values can be added and renamed, but **PostgreSQL cannot drop
 *   an enum value**. There is no `ALTER TYPE … DROP VALUE`; removing one means
 *   recreating the type and every column that uses it. The panel surfaces that
 *   rather than pretending a removed row took effect.
 * - **Domain** — its default, its NOT NULL, and its CHECK constraints all
 *   alter in place; the base type does not (that needs a recreate).
 *
 * Postgres-only: MySQL has none of these as standalone objects. Pure and
 * dependency-free apart from the quoter, so `node --test` covers it.
 */
import { quoteIdent, safePath, sqlLiteral } from './sqlIdent.ts';

/** The three PostgreSQL type kinds this editor builds. */
export type TypeKind = 'composite' | 'enum' | 'domain';

/** One attribute of a composite type: `name type`. */
export interface CompositeAttr {
  name: string;
  /** A type expression, kept verbatim — `varchar(20)`, `numeric(10,2)`, `int[]`. */
  type: string;
}

/** A named CHECK on a domain. The name is optional on create (Postgres
    invents one); it is required to drop, so a read fills it in. */
export interface DomainCheck {
  name?: string;
  /** The bare expression, without the surrounding `CHECK (...)`. */
  expr: string;
}

export interface TypeDef {
  schema: string;
  name: string;
  kind: TypeKind;
  /** composite only. */
  attrs?: CompositeAttr[];
  /** enum only, in sort order. */
  values?: string[];
  /** domain only: the base type expression, e.g. `text` or `numeric(10,2)`. */
  baseType?: string;
  /** domain only: a DEFAULT expression, kept verbatim. Empty means none. */
  default?: string;
  /** domain only. */
  notNull?: boolean;
  /** domain only. */
  checks?: DomainCheck[];
}

export type Risk = 'safe' | 'lossy' | 'destructive';

export interface TypeChange {
  kind: 'create' | 'alter' | 'drop';
  subject: string;
  risk: Risk;
  sql: string;
  /** Why this is not `safe`, when it is not. */
  warning?: string;
}

// Everything here is PostgreSQL, so the quoting engine is fixed. Identifiers
// the editor inserts are quoted unconditionally — the same choice sequenceDdl
// makes — so a folded-case or reserved-word name always resolves.
const q = (s: string) => quoteIdent(s, 'postgres');
const lit = (s: string) => sqlLiteral(s, 'postgres');

const qualified = (d: Pick<TypeDef, 'schema' | 'name'>) => `${q(d.schema)}.${q(d.name)}`;

// ── reading ──────────────────────────────────────────────────────────────────

/**
 * Every editable user type in a schema, as `(name, kind)`.
 *
 * `typtype` distinguishes the kinds: `c` composite, `e` enum, `d` domain. A
 * table's row type is also `c`, so composites are narrowed to standalone ones
 * (`relkind = 'c'`) — otherwise every table would appear here as a type.
 */
export function listSql(schema: string): string {
  return "SELECT t.typname, CASE t.typtype "
    + "WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' WHEN 'c' THEN 'composite' END "
    + 'FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace '
    + `WHERE n.nspname = ${lit(schema)} AND (`
    + "t.typtype IN ('e','d') OR (t.typtype = 'c' AND EXISTS ("
    + "SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))) "
    + 'ORDER BY t.typname';
}

/** One composite type's attributes, as `(name, type)` in column order. */
export function readCompositeSql(schema: string, name: string): string {
  return 'SELECT a.attname, format_type(a.atttypid, a.atttypmod) '
    + 'FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace '
    + 'JOIN pg_class c ON c.oid = t.typrelid '
    + 'JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped '
    + `WHERE n.nspname = ${lit(schema)} AND t.typname = ${lit(name)} ORDER BY a.attnum`;
}

/** One enum type's labels, in sort order. */
export function readEnumSql(schema: string, name: string): string {
  return 'SELECT e.enumlabel FROM pg_enum e '
    + 'JOIN pg_type t ON t.oid = e.enumtypid '
    + 'JOIN pg_namespace n ON n.oid = t.typnamespace '
    + `WHERE n.nspname = ${lit(schema)} AND t.typname = ${lit(name)} ORDER BY e.enumsortorder`;
}

/**
 * One domain's definition as a single row: base type, NOT NULL, DEFAULT.
 *
 * The CHECK constraints are read separately — a domain can have several, so
 * they are their own list.
 */
export function readDomainSql(schema: string, name: string): string {
  return 'SELECT format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault '
    + 'FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace '
    + `WHERE n.nspname = ${lit(schema)} AND t.typname = ${lit(name)} AND t.typtype = 'd'`;
}

/** A domain's CHECK constraints, as `(name, expr)` — expr is the raw text of
    the definition, e.g. `CHECK ((VALUE > 0))`. */
export function readDomainChecksSql(schema: string, name: string): string {
  return 'SELECT c.conname, pg_get_constraintdef(c.oid) '
    + 'FROM pg_constraint c JOIN pg_type t ON t.oid = c.contypid '
    + 'JOIN pg_namespace n ON n.oid = t.typnamespace '
    + `WHERE n.nspname = ${lit(schema)} AND t.typname = ${lit(name)} AND c.contype = 'c'`;
}

/** Pull the bare expression out of `CHECK (expr)` / `CHECK ((expr))`, so the
    form shows what a user would type rather than the catalog's rendering. */
export function stripCheck(def: string): string {
  const m = /^\s*CHECK\s*\(([\s\S]*)\)\s*$/i.exec(def.trim());
  return m ? m[1].trim() : def.trim();
}

// ── writing ──────────────────────────────────────────────────────────────────

/** `CREATE TYPE` / `CREATE DOMAIN`, dispatched on the kind. */
export function createSql(def: TypeDef): string {
  switch (def.kind) {
    case 'composite': return createCompositeSql(def);
    case 'enum': return createEnumSql(def);
    case 'domain': return createDomainSql(def);
  }
}

function createCompositeSql(def: TypeDef): string {
  const attrs = (def.attrs ?? []).filter(a => a.name.trim() && a.type.trim());
  const body = attrs.map(a => `  ${q(a.name)} ${a.type.trim()}`).join(',\n');
  return `CREATE TYPE ${qualified(def)} AS (\n${body}\n)`;
}

function createEnumSql(def: TypeDef): string {
  const values = (def.values ?? []).filter(v => v !== '');
  const list = values.map(v => lit(v)).join(', ');
  return `CREATE TYPE ${qualified(def)} AS ENUM (${list})`;
}

function createDomainSql(def: TypeDef): string {
  const parts = [`CREATE DOMAIN ${qualified(def)} AS ${(def.baseType ?? '').trim() || 'text'}`];
  if (def.default && def.default.trim()) parts.push(`  DEFAULT ${def.default.trim()}`);
  if (def.notNull) parts.push('  NOT NULL');
  for (const c of def.checks ?? []) {
    if (!c.expr.trim()) continue;
    const named = c.name?.trim() ? `CONSTRAINT ${q(c.name.trim())} ` : '';
    parts.push(`  ${named}CHECK (${c.expr.trim()})`);
  }
  return parts.join('\n');
}

/** `DROP TYPE` / `DROP DOMAIN`. */
export function dropSql(def: TypeDef, cascade = false): string {
  const kw = def.kind === 'domain' ? 'DROP DOMAIN' : 'DROP TYPE';
  return `${kw} ${qualified(def)}${cascade ? ' CASCADE' : ''}`;
}

// ── altering ─────────────────────────────────────────────────────────────────

/** Everything needed to turn `current` into `next`, only what changed. */
export function alterSql(current: TypeDef, next: TypeDef): TypeChange[] {
  switch (next.kind) {
    case 'composite': return alterCompositeSql(current, next);
    case 'enum': return alterEnumSql(current, next);
    case 'domain': return alterDomainSql(current, next);
  }
}

function alterCompositeSql(current: TypeDef, next: TypeDef): TypeChange[] {
  const out: TypeChange[] = [];
  const target = qualified(next);
  const add = (clause: string, risk: Risk = 'safe', warning?: string) =>
    out.push({ kind: 'alter', subject: next.name, risk, sql: `ALTER TYPE ${target} ${clause}`, warning });

  const before = (current.attrs ?? []).filter(a => a.name.trim());
  const after = (next.attrs ?? []).filter(a => a.name.trim());
  const beforeByName = new Map(before.map(a => [a.name, a]));
  const afterNames = new Set(after.map(a => a.name));

  // Dropped attributes — destructive, they take their column's data with them.
  for (const a of before) {
    if (!afterNames.has(a.name)) {
      add(`DROP ATTRIBUTE ${q(a.name)}`, 'destructive',
        `Dropping attribute ${a.name} discards it from every value of this type.`);
    }
  }
  // Added and retyped attributes.
  for (const a of after) {
    if (!a.type.trim()) continue;
    const prev = beforeByName.get(a.name);
    if (!prev) {
      add(`ADD ATTRIBUTE ${q(a.name)} ${a.type.trim()}`);
    } else if (prev.type.trim() !== a.type.trim()) {
      add(`ALTER ATTRIBUTE ${q(a.name)} TYPE ${a.type.trim()}`, 'lossy',
        `Retyping ${a.name} to ${a.type.trim()} rewrites existing values and fails if any `
        + 'does not convert.');
    }
  }
  return out;
}

/**
 * Enum changes: new values are added, in-place edits become renames, and a
 * removed value is refused with an explanation rather than silently dropped.
 *
 * Values are matched by position: value `i` present in both but different is a
 * rename; a value past the end of the old list is an addition. That mirrors
 * how the form edits the list — a text box per row — and keeps a rename from
 * looking like "drop the old, add the new", which Postgres cannot do.
 */
export function alterEnumSql(current: TypeDef, next: TypeDef): TypeChange[] {
  const out: TypeChange[] = [];
  const target = qualified(next);
  const before = current.values ?? [];
  const after = (next.values ?? []).filter(Boolean);
  const beforeSet = new Set(before);
  // Old labels consumed by a positional rename — so they do not also read as
  // "removed" below.
  const renamedFrom = new Set<string>();

  for (let i = 0; i < after.length; i++) {
    const v = after[i];
    const old = before[i];
    if (old !== undefined && old !== v && !beforeSet.has(v)) {
      // Position i now holds a label that did not exist before → a rename of
      // whatever was there. (A label that *did* exist before is instead the
      // list having shifted under a removal, handled as an impossible drop.)
      out.push({
        kind: 'alter', subject: next.name, risk: 'safe',
        sql: `ALTER TYPE ${target} RENAME VALUE ${lit(old)} TO ${lit(v)}`,
      });
      renamedFrom.add(old);
    } else if (!beforeSet.has(v)) {
      out.push({
        kind: 'alter', subject: next.name, risk: 'safe',
        sql: `ALTER TYPE ${target} ADD VALUE ${lit(v)}`,
        warning: 'Adding an enum value cannot run inside a transaction block before '
          + 'PostgreSQL 12 — run it on its own if the server is older.',
      });
    }
  }
  // A value the new list no longer has, and that was not renamed away, cannot
  // be removed — Postgres has no DROP VALUE.
  const afterSet = new Set(after);
  const trulyGone = before.filter(v => !afterSet.has(v) && !renamedFrom.has(v));
  if (trulyGone.length) {
    out.push({
      kind: 'alter', subject: next.name, risk: 'destructive',
      sql: `-- PostgreSQL cannot drop enum value(s): ${trulyGone.join(', ')}`,
      warning: `PostgreSQL has no ALTER TYPE … DROP VALUE. Removing ${trulyGone.join(', ')} `
        + 'requires recreating the type and every column that uses it. The line above is a '
        + 'comment, not an executable statement.',
    });
  }
  return out;
}

function alterDomainSql(current: TypeDef, next: TypeDef): TypeChange[] {
  const out: TypeChange[] = [];
  const target = qualified(next);
  const add = (clause: string, risk: Risk = 'safe', warning?: string) =>
    out.push({ kind: 'alter', subject: next.name, risk, sql: `ALTER DOMAIN ${target} ${clause}`, warning });

  const curDefault = (current.default ?? '').trim();
  const nextDefault = (next.default ?? '').trim();
  if (curDefault !== nextDefault) {
    add(nextDefault ? `SET DEFAULT ${nextDefault}` : 'DROP DEFAULT');
  }
  if (!!current.notNull !== !!next.notNull) {
    if (next.notNull) {
      add('SET NOT NULL', 'lossy',
        'SET NOT NULL fails if any existing column of this domain already holds a NULL.');
    } else {
      add('DROP NOT NULL');
    }
  }

  const before = current.checks ?? [];
  const after = next.checks ?? [];
  const key = (c: DomainCheck) => c.expr.trim();
  const beforeExprs = new Set(before.map(key));
  const afterExprs = new Set(after.map(key));
  // Dropped constraints need their name, which a read supplies.
  for (const c of before) {
    if (!afterExprs.has(key(c)) && c.name?.trim()) {
      add(`DROP CONSTRAINT ${q(c.name.trim())}`, 'safe');
    }
  }
  // Added constraints — auto-named if the form left the name blank.
  for (const c of after) {
    if (!c.expr.trim() || beforeExprs.has(key(c))) continue;
    const name = c.name?.trim() || `${next.name}_check`;
    add(`ADD CONSTRAINT ${q(name)} CHECK (${c.expr.trim()})`, 'lossy',
      'A new CHECK is validated against every existing column of this domain and fails if '
      + 'any row does not satisfy it.');
  }
  return out;
}

// ── shared with the other editors ─────────────────────────────────────────────

/** The strongest risk present, for the confirm dialog. */
export function worstRisk(changes: TypeChange[]): Risk {
  if (changes.some(c => c.risk === 'destructive')) return 'destructive';
  if (changes.some(c => c.risk === 'lossy')) return 'lossy';
  return 'safe';
}

/** Statements joined for display and for running. */
export function toScript(changes: TypeChange[]): string {
  return changes.map(c => (c.sql.trim().startsWith('--') ? c.sql : `${c.sql};`)).join('\n');
}

/** A one-line signature for lists and headers. */
export function typeSignature(def: TypeDef): string {
  switch (def.kind) {
    case 'composite':
      return `${def.name} (${(def.attrs ?? []).map(a => a.name).filter(Boolean).join(', ')})`;
    case 'enum':
      return `${def.name} {${(def.values ?? []).filter(Boolean).join(', ')}}`;
    case 'domain':
      return `${def.name} AS ${def.baseType ?? ''}`.trim();
  }
}

/** Re-exported so a caller quoting a qualified reference uses the same path
    logic the DDL builders do. */
export { safePath };
