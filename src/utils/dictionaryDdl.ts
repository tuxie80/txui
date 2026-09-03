/**
 * ClickHouse dictionaries — the DDL that creates, replaces and drops them, and
 * a best-effort parse of an existing one back into a form.
 *
 * A dictionary was the last ClickHouse object with only a read-only DDL box:
 * you could look at a `CREATE DICTIONARY …` under "View DDL" and then hand-edit
 * it in the SQL editor. This is the pure half of the editor that closes that
 * gap — `DictionaryPanel` is the screen.
 *
 * Same two rules as the view and type editors. **Show exactly what will run
 * before it runs** — the statement is on screen, never behind a silent Save —
 * and the generated SQL is **review-only**: it is inserted / copied / applied
 * through the same reviewed path, and every identifier is quoted through
 * `utils/sqlIdent` (engine `clickhouse`, so backticks), every string value
 * escaped through `sqlLiteral`.
 *
 * The shape built is:
 *
 *   CREATE [OR REPLACE] DICTIONARY [db.]name
 *   ( col Type [DEFAULT expr], … )
 *   PRIMARY KEY <key>
 *   SOURCE(<src>(…))
 *   LAYOUT(<layout>(…))
 *   LIFETIME(MIN n MAX m)
 *
 * A dictionary's SOURCE and LAYOUT have many forms; the common ones are modelled
 * as fields and everything else is reachable through a free-text SOURCE and a
 * whole-statement `raw` override, so an exotic dictionary is never blocked.
 *
 * Pure and dependency-free apart from the quoter, so `node --test` covers it.
 */
import { quoteIdent, sqlLiteral } from './sqlIdent.ts';

/** ClickHouse only — the one engine with standalone dictionaries. */
const q = (s: string) => quoteIdent(s, 'clickhouse');
const lit = (s: string) => sqlLiteral(s, 'clickhouse');

/** One attribute (column) of a dictionary. */
export interface DictAttr {
  name: string;
  type: string;
  /** A `DEFAULT` expression, when the source omits the column. */
  default?: string;
}

/** The source kinds the form models directly; `CUSTOM` is free text. */
export type DictSourceKind = 'CLICKHOUSE' | 'HTTP' | 'FILE' | 'CUSTOM';

export interface DictSource {
  kind: DictSourceKind;
  // CLICKHOUSE(...)
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  db?: string;
  table?: string;
  // HTTP(...) / FILE(...)
  url?: string;
  path?: string;
  format?: string;
  /** CUSTOM: the whole inside of `SOURCE(…)`, e.g. `MYSQL(host 'h' …)`. */
  raw?: string;
}

/** The layout kinds the form models directly. */
export type DictLayoutKind = 'FLAT' | 'HASHED' | 'COMPLEX_KEY_HASHED' | 'CACHE';

export interface DictLayout {
  kind: DictLayoutKind;
  /** CACHE only: `size_in_cells`. */
  size?: string;
}

export interface DictLifetime {
  /** Seconds. When `min` and `max` differ, ClickHouse re-reads at a random
      point in the range; when equal it uses the single-value form. */
  min: string;
  max: string;
}

export interface DictDef {
  schema: string;
  name: string;
  attrs: DictAttr[];
  primaryKey: string;
  source: DictSource;
  layout: DictLayout;
  lifetime: DictLifetime;
  /**
   * A whole-statement override. When set (non-empty), the builder emits this
   * verbatim rather than assembling from the fields — the escape hatch for a
   * dictionary the form cannot represent.
   */
  raw?: string;
}

export type Risk = 'safe' | 'lossy' | 'destructive';

export interface DictChange {
  kind: 'create' | 'replace' | 'drop';
  subject: string;
  risk: Risk;
  sql: string;
  warning?: string;
}

// ── quoting ──────────────────────────────────────────────────────────────────

/** `schema.name`, each part quoted, the schema dropped when absent. */
function qualified(d: Pick<DictDef, 'schema' | 'name'>): string {
  const name = q(d.name);
  return d.schema.trim() ? `${q(d.schema)}.${name}` : name;
}

/** Single-quoted literal for a schema name in a `WHERE database = …` clause. */
function litSchema(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── reading ──────────────────────────────────────────────────────────────────

/** The databases a dictionary can live in, system ones filtered out. */
export function schemaListSql(): string {
  return 'SELECT name FROM system.databases '
    + "WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name";
}

/** Every dictionary in a database, by name. */
export function listSql(schema: string): string {
  return `SELECT name FROM system.dictionaries WHERE database = ${litSchema(schema)} ORDER BY name`;
}

/**
 * Best-effort parse of a `CREATE DICTIONARY …` DDL (as returned by `get_ddl`)
 * into the form fields. Whatever cannot be parsed cleanly is left for the raw
 * editor — this favours getting the common shapes right over totality, and the
 * caller keeps the original DDL as the `raw` fallback.
 */
export function parseDictionary(ddl: string): Partial<DictDef> {
  const out: Partial<DictDef> = {};

  // Attributes: the first parenthesised list after the name.
  const attrsBlock = /DICTIONARY\s+[^(]*\(([\s\S]*?)\)\s*(?:PRIMARY\s+KEY|SOURCE|LAYOUT|LIFETIME|$)/i
    .exec(ddl);
  if (attrsBlock) {
    const attrs = splitTop(attrsBlock[1]).map(parseAttr).filter((a): a is DictAttr => a !== null);
    if (attrs.length) out.attrs = attrs;
  }

  const pk = /\bPRIMARY\s+KEY\s+([^\n]+?)(?=\s*(?:SOURCE|LAYOUT|LIFETIME)\b|$)/i.exec(ddl);
  if (pk) {
    out.primaryKey = pk[1].trim().replace(/^\(|\)$/g, '').trim()
      .split(',').map(p => p.trim().replace(/^[`"]|[`"]$/g, '')).filter(Boolean).join(', ');
  }

  const src = /\bSOURCE\s*\(([\s\S]*)\)\s*LAYOUT/i.exec(ddl)
    ?? /\bSOURCE\s*\(([\s\S]*?)\)\s*(?:LAYOUT|LIFETIME|$)/i.exec(ddl);
  if (src) out.source = parseSource(src[1].trim());

  const lay = /\bLAYOUT\s*\(\s*([A-Z_]+)\s*\(([\s\S]*?)\)\s*\)/i.exec(ddl);
  if (lay) {
    const kind = lay[1].toUpperCase();
    const size = /(?:size_in_cells\s+)?(\d+)/i.exec(lay[2]);
    out.layout = {
      kind: (['FLAT', 'HASHED', 'COMPLEX_KEY_HASHED', 'CACHE'].includes(kind)
        ? kind : 'FLAT') as DictLayoutKind,
      size: size ? size[1] : '',
    };
  }

  const life = /\bLIFETIME\s*\(([\s\S]*?)\)/i.exec(ddl);
  if (life) {
    const mm = /MIN\s+(\d+)\s+MAX\s+(\d+)/i.exec(life[1]);
    const single = /^\s*(\d+)\s*$/.exec(life[1]);
    if (mm) out.lifetime = { min: mm[1], max: mm[2] };
    else if (single) out.lifetime = { min: single[1], max: single[1] };
  }

  return out;
}

/** Split a comma-separated list, ignoring commas nested in parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(Boolean);
}

/** `col Type [DEFAULT expr]` → an attribute, or null when unrecognisable. */
function parseAttr(s: string): DictAttr | null {
  const m = /^\s*`?([A-Za-z0-9_]+)`?\s+(.+?)\s*$/.exec(s);
  if (!m) return null;
  const name = m[1];
  let type = m[2];
  let dflt = '';
  const d = /\bDEFAULT\s+(.+)$/i.exec(type);
  if (d) { dflt = d[1].trim(); type = type.slice(0, d.index).trim(); }
  return { name, type, ...(dflt ? { default: dflt } : {}) };
}

/** The inside of `SOURCE(…)` → a modelled source, or a CUSTOM free-text one. */
function parseSource(inner: string): DictSource {
  const m = /^([A-Za-z_]+)\s*\(([\s\S]*)\)\s*$/.exec(inner);
  if (!m) return { kind: 'CUSTOM', raw: inner };
  const kind = m[1].toUpperCase();
  const body = m[2];
  const val = (key: string) => {
    const r = new RegExp(`\\b${key}\\b\\s+'((?:[^'\\\\]|\\\\.)*)'`, 'i').exec(body)
      ?? new RegExp(`\\b${key}\\b\\s+([^\\s)]+)`, 'i').exec(body);
    return r ? r[1] : '';
  };
  if (kind === 'CLICKHOUSE') {
    return {
      kind: 'CLICKHOUSE',
      host: val('host'), port: val('port'), user: val('user'),
      password: val('password'), db: val('db'), table: val('table'),
    };
  }
  if (kind === 'HTTP') {
    return { kind: 'HTTP', url: val('url'), format: val('format') };
  }
  if (kind === 'FILE') {
    return { kind: 'FILE', path: val('path'), format: val('format') };
  }
  return { kind: 'CUSTOM', raw: inner };
}

// ── writing ──────────────────────────────────────────────────────────────────

/** The `SOURCE(…)` clause for a source. */
export function sourceSql(s: DictSource): string {
  const pair = (k: string, v: string | undefined) =>
    (v && v.trim() ? `${k} ${lit(v)}` : '');
  const num = (k: string, v: string | undefined) =>
    (v && v.trim() ? `${k} ${v.trim()}` : '');
  switch (s.kind) {
    case 'CLICKHOUSE': {
      const parts = [
        pair('host', s.host), num('port', s.port), pair('user', s.user),
        pair('password', s.password), pair('db', s.db), pair('table', s.table),
      ].filter(Boolean);
      return `SOURCE(CLICKHOUSE(${parts.join(' ')}))`;
    }
    case 'HTTP': {
      const parts = [pair('url', s.url), pair('format', s.format)].filter(Boolean);
      return `SOURCE(HTTP(${parts.join(' ')}))`;
    }
    case 'FILE': {
      const parts = [pair('path', s.path), pair('format', s.format)].filter(Boolean);
      return `SOURCE(FILE(${parts.join(' ')}))`;
    }
    case 'CUSTOM':
      return `SOURCE(${(s.raw ?? '').trim()})`;
  }
}

/** The `LAYOUT(…)` clause for a layout. */
export function layoutSql(l: DictLayout): string {
  if (l.kind === 'CACHE') {
    const size = (l.size ?? '').trim() || '1000';
    return `LAYOUT(CACHE(size_in_cells ${size}))`;
  }
  return `LAYOUT(${l.kind}())`;
}

/** The `LIFETIME(…)` clause — single-value when min and max match. */
export function lifetimeSql(l: DictLifetime): string {
  const min = (l.min ?? '').trim() || '0';
  const max = (l.max ?? '').trim() || min;
  return min === max ? `LIFETIME(${min})` : `LIFETIME(MIN ${min} MAX ${max})`;
}

/** The attribute list — `( col Type [DEFAULT expr], … )`, one per line. */
function attrsSql(attrs: DictAttr[]): string {
  const rows = attrs
    .filter(a => a.name.trim() && a.type.trim())
    .map(a => {
      const dflt = a.default && a.default.trim() ? ` DEFAULT ${a.default.trim()}` : '';
      return `  ${q(a.name)} ${a.type.trim()}${dflt}`;
    });
  return `(\n${rows.join(',\n')}\n)`;
}

/** The primary key, each comma-separated part quoted. */
function primaryKeySql(key: string): string {
  return key.split(',').map(p => p.trim()).filter(Boolean).map(p => q(p)).join(', ');
}

/**
 * `CREATE [OR REPLACE] DICTIONARY … PRIMARY KEY … SOURCE(…) LAYOUT(…)
 * LIFETIME(…)`.
 *
 * When `def.raw` is set it wins verbatim — the escape hatch for a dictionary
 * the form cannot represent.
 */
export function createSql(def: DictDef, orReplace = false): string {
  if (def.raw && def.raw.trim()) {
    return def.raw.trim().replace(/;\s*$/, '').trim();
  }
  return [
    `CREATE ${orReplace ? 'OR REPLACE ' : ''}DICTIONARY ${qualified(def)}`,
    attrsSql(def.attrs),
    `PRIMARY KEY ${primaryKeySql(def.primaryKey)}`,
    sourceSql(def.source),
    layoutSql(def.layout),
    lifetimeSql(def.lifetime),
  ].join('\n');
}

/** `DROP DICTIONARY [IF EXISTS] name`. */
export function dropSql(
  def: Pick<DictDef, 'schema' | 'name'>, opts: { ifExists?: boolean } = {},
): string {
  return `DROP DICTIONARY ${opts.ifExists ? 'IF EXISTS ' : ''}${qualified(def)}`;
}

/**
 * Everything needed to go from `current` to `draft`. A dictionary has
 * `CREATE OR REPLACE`, so editing is one safe statement; creating a new one is
 * a plain CREATE. Dropping is handled by the panel's own button.
 */
export function changesFor(current: DictDef | null, draft: DictDef): DictChange[] {
  if (!isBuildable(draft)) return [];
  if (!current) {
    return [{ kind: 'create', subject: draft.name, risk: 'safe', sql: createSql(draft, false) }];
  }
  return [{ kind: 'replace', subject: draft.name, risk: 'safe', sql: createSql(draft, true) }];
}

/** Enough filled in to build a statement: a name, and either raw text or at
    least one attribute plus a primary key. */
export function isBuildable(def: DictDef): boolean {
  if (!def.name.trim()) return false;
  if (def.raw && def.raw.trim()) return true;
  const hasAttr = def.attrs.some(a => a.name.trim() && a.type.trim());
  return hasAttr && !!def.primaryKey.trim();
}

// ── shared with the other editors ─────────────────────────────────────────────

/** The strongest risk present, for the confirm affordance. */
export function worstRisk(changes: DictChange[]): Risk {
  if (changes.some(c => c.risk === 'destructive')) return 'destructive';
  if (changes.some(c => c.risk === 'lossy')) return 'lossy';
  return 'safe';
}

/** Statements joined for display and for running. */
export function toScript(changes: DictChange[]): string {
  return changes.map(c => `${c.sql};`).join('\n');
}

/** A blank dictionary, ready to edit. */
export function blankDict(schema: string): DictDef {
  return {
    schema, name: '',
    attrs: [{ name: 'id', type: 'UInt64' }, { name: '', type: '' }],
    primaryKey: 'id',
    source: { kind: 'CLICKHOUSE', host: 'localhost', port: '9000', user: 'default', db: '', table: '' },
    layout: { kind: 'FLAT' },
    lifetime: { min: '0', max: '300' },
  };
}
