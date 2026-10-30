import { splitStatements, firstCodeOffset } from './sqlSplit.ts';
import type { Statement } from './sqlSplit.ts';
import { ddlCost, ASSUMPTIONS } from './ddlCost.ts';
import type { DdlCost } from './ddlCost.ts';
import { analyzeCascade, routeText, summarize } from './cascade.ts';
import type { FkEdge } from './cascade.ts';
import type { Finding, Severity } from './sqlLint.ts';
import type { ReportSection } from './qualityReport.ts';
import { mdTable } from './qualityReport.ts';
import type { SchemaSnapshot } from './schemaRules.ts';

export type ChangeReviewEngine = 'mysql' | 'postgres';

export interface ReviewColumn {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}

export interface ReviewIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ReviewForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
}

export interface ReviewTable {
  name: string;
  complete: boolean;
  source: 'catalog' | 'migration' | 'partial';
  columns: ReviewColumn[];
  indexes: ReviewIndex[];
  foreignKeys: ReviewForeignKey[];
  rows: number | null;
  bytes: number | null;
}

export interface ChangeStatement {
  number: number;
  line: number;
  col: number;
  kind: string;
  table: string | null;
  supported: boolean;
  summary: string;
  findings: Finding[];
  cost: DdlCost | null;
  after: ReviewTable[];
}

export interface ChangeReviewResult {
  statements: ChangeStatement[];
  tables: ReviewTable[];
  findings: Finding[];
  sections: ReportSection[];
  summary: {
    statements: number;
    supported: number;
    unsupported: number;
    destructive: number;
    rebuilds: number;
  };
}

export interface ChangeReviewOptions {
  engine: ChangeReviewEngine;
  sql: string;
  catalog?: SchemaSnapshot;
  mariaDb?: boolean;
}

interface Token {
  text: string;
  upper: string;
  from: number;
  to: number;
  kind: 'word' | 'quoted' | 'string' | 'number' | 'symbol';
}

interface Ref {
  name: string;
  display: string;
  next: number;
}

interface ColumnDef extends ReviewColumn {
  position?: { kind: 'first' } | { kind: 'after'; column: string };
  primary?: boolean;
  unique?: boolean;
  reference?: Omit<ReviewForeignKey, 'name' | 'columns'>;
}

interface ParseError {
  message: string;
  token?: Token;
}

const CONSTRAINT_WORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CONSTRAINT',
  'CHECK', 'COLLATE', 'COMMENT', 'AUTO_INCREMENT', 'GENERATED', 'ON', 'KEY',
  'FIRST', 'AFTER', 'STORAGE', 'COLUMN_FORMAT', 'SRID', 'INVISIBLE', 'VISIBLE',
]);

const norm = (name: string) => name.toLowerCase();
const cloneTable = (table: ReviewTable): ReviewTable => ({
  ...table,
  columns: table.columns.map(c => ({ ...c })),
  indexes: table.indexes.map(i => ({ ...i, columns: [...i.columns] })),
  foreignKeys: table.foreignKeys.map(f => ({ ...f, columns: [...f.columns], refColumns: [...f.refColumns] })),
});

function tokenize(sql: string, engine: ChangeReviewEngine, base: number): { tokens: Token[]; error?: string } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '#' && engine === 'mysql')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (engine === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      if (depth > 0) return { tokens, error: 'unterminated block comment' };
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '\\' && quote !== '`' && engine === 'mysql') { j += 2; continue; }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }
          j++; closed = true; break;
        }
        j++;
      }
      if (!closed) return { tokens, error: `unterminated ${quote === "'" ? 'string' : 'quoted identifier'}` };
      const text = sql.slice(i, j);
      const kind = quote === "'" ? 'string' : 'quoted';
      const value = kind === 'quoted'
        ? text.slice(1, -1).replace(new RegExp(`\\${quote}\\${quote}`, 'g'), quote)
        : text;
      tokens.push({ text: value, upper: value.toUpperCase(), from: base + i, to: base + j, kind });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[\w$]/.test(sql[j])) j++;
      const text = sql.slice(i, j);
      tokens.push({ text, upper: text.toUpperCase(), from: base + i, to: base + j, kind: 'word' });
      i = j;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[\d.]/.test(sql[j])) j++;
      tokens.push({ text: sql.slice(i, j), upper: sql.slice(i, j), from: base + i, to: base + j, kind: 'number' });
      i = j;
      continue;
    }
    tokens.push({ text: ch, upper: ch, from: base + i, to: base + i + 1, kind: 'symbol' });
    i++;
  }
  return { tokens };
}

const isWord = (token: Token | undefined, word: string) => token?.kind === 'word' && token.upper === word;
const isSymbol = (token: Token | undefined, symbol: string) => token?.kind === 'symbol' && token.text === symbol;

function parseIdent(tokens: Token[], at: number, engine: ChangeReviewEngine): { name: string; next: number } | null {
  const token = tokens[at];
  if (!token || (token.kind !== 'word' && token.kind !== 'quoted')) return null;
  return { name: engine === 'postgres' && token.kind === 'word' ? token.text.toLowerCase() : token.text, next: at + 1 };
}

function parseRef(tokens: Token[], at: number, engine: ChangeReviewEngine): Ref | null {
  const first = parseIdent(tokens, at, engine);
  if (!first) return null;
  let name = first.name;
  let display = first.name;
  let next = first.next;
  while (isSymbol(tokens[next], '.')) {
    const part = parseIdent(tokens, next + 1, engine);
    if (!part) return null;
    name = part.name;
    display += `.${part.name}`;
    next = part.next;
  }
  return { name, display, next };
}

function matchingParen(tokens: Token[], open: number, end = tokens.length): number | null {
  if (!isSymbol(tokens[open], '(')) return null;
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (isSymbol(tokens[i], '(')) depth++;
    else if (isSymbol(tokens[i], ')')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function splitTokenRanges(tokens: Token[], start: number, end: number): [number, number][] {
  const ranges: [number, number][] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    if (isSymbol(tokens[i], '(')) depth++;
    else if (isSymbol(tokens[i], ')')) depth--;
    else if (isSymbol(tokens[i], ',') && depth === 0) {
      if (i > from) ranges.push([from, i]);
      from = i + 1;
    }
  }
  if (end > from) ranges.push([from, end]);
  return ranges;
}

function parseColumnList(tokens: Token[], open: number, engine: ChangeReviewEngine): { columns: string[]; next: number } | null {
  const close = matchingParen(tokens, open);
  if (close === null) return null;
  const columns: string[] = [];
  for (const [a, b] of splitTokenRanges(tokens, open + 1, close)) {
    const ident = parseIdent(tokens, a, engine);
    if (!ident) return null;
    columns.push(ident.name);
    // MySQL prefix lengths and ASC/DESC do not change the indexed column.
    for (let i = ident.next; i < b; i++) {
      if (!isWord(tokens[i], 'ASC') && !isWord(tokens[i], 'DESC') && !isSymbol(tokens[i], '(')
        && !isSymbol(tokens[i], ')') && tokens[i]?.kind !== 'number') return null;
    }
  }
  return columns.length ? { columns, next: close + 1 } : null;
}

function skipExpression(tokens: Token[], at: number, end: number): number {
  let depth = 0;
  let i = at;
  for (; i < end; i++) {
    if (isSymbol(tokens[i], '(')) depth++;
    else if (isSymbol(tokens[i], ')')) depth--;
    if (depth === 0 && i > at && tokens[i]?.kind === 'word' && CONSTRAINT_WORDS.has(tokens[i].upper)) break;
  }
  return i;
}

function parseColumnDef(tokens: Token[], start: number, end: number, sql: string, engine: ChangeReviewEngine): { def?: ColumnDef; error?: ParseError } {
  const ident = parseIdent(tokens, start, engine);
  if (!ident) return { error: { message: 'expected a column name', token: tokens[start] } };
  const typeStart = ident.next;
  if (typeStart >= end) return { error: { message: `column ${ident.name} has no type`, token: tokens[start] } };
  let depth = 0;
  let typeEnd = typeStart;
  while (typeEnd < end) {
    const token = tokens[typeEnd];
    if (isSymbol(token, '(')) depth++;
    else if (isSymbol(token, ')')) depth--;
    if (depth === 0 && token.kind === 'word' && CONSTRAINT_WORDS.has(token.upper)) break;
    typeEnd++;
  }
  if (typeEnd === typeStart) return { error: { message: `column ${ident.name} has no type`, token: tokens[typeStart] } };
  const first = tokens[typeStart];
  const last = tokens[typeEnd - 1];
  const def: ColumnDef = {
    name: ident.name,
    type: sql.slice(first.from, last.to).trim().replace(/\s+/g, ' '),
    nullable: true,
    hasDefault: false,
  };
  let i = typeEnd;
  while (i < end) {
    const token = tokens[i];
    if (isWord(token, 'NOT') && isWord(tokens[i + 1], 'NULL')) { def.nullable = false; i += 2; continue; }
    if (isWord(token, 'NULL')) { def.nullable = true; i++; continue; }
    if (isWord(token, 'DEFAULT')) {
      def.hasDefault = true;
      const next = skipExpression(tokens, i + 1, end);
      if (next === i + 1) return { error: { message: `DEFAULT on ${ident.name} has no expression`, token } };
      i = next;
      continue;
    }
    if (isWord(token, 'PRIMARY') && isWord(tokens[i + 1], 'KEY')) { def.primary = true; i += 2; continue; }
    if (isWord(token, 'UNIQUE')) { def.unique = true; i++; if (isWord(tokens[i], 'KEY')) i++; continue; }
    if (isWord(token, 'AUTO_INCREMENT')) { i++; continue; }
    if (isWord(token, 'GENERATED') || isWord(token, 'SRID')) {
      return { error: { message: `generated/spatial column ${ident.name} is outside the supported model`, token } };
    }
    if (isWord(token, 'COMMENT')) {
      if (tokens[i + 1]?.kind !== 'string') return { error: { message: `COMMENT on ${ident.name} needs a string`, token } };
      i += 2; continue;
    }
    if (isWord(token, 'COLLATE') || isWord(token, 'STORAGE') || isWord(token, 'COLUMN_FORMAT')) {
      if (!tokens[i + 1]) return { error: { message: `${token.text} on ${ident.name} needs a value`, token } };
      i += 2; continue;
    }
    if (isWord(token, 'VISIBLE') || isWord(token, 'INVISIBLE')) { i++; continue; }
    if (isWord(token, 'ON') && isWord(tokens[i + 1], 'UPDATE')) { i = skipExpression(tokens, i + 2, end); continue; }
    if (isWord(token, 'CHECK')) {
      const close = matchingParen(tokens, i + 1, end);
      if (close === null) return { error: { message: `malformed CHECK on ${ident.name}`, token } };
      i = close + 1; continue;
    }
    if (isWord(token, 'CONSTRAINT')) {
      const name = parseIdent(tokens, i + 1, engine);
      i = name ? name.next : i + 1;
      continue;
    }
    if (isWord(token, 'REFERENCES')) {
      const ref = parseRef(tokens, i + 1, engine);
      const list = ref ? parseColumnList(tokens, ref.next, engine) : null;
      if (!ref || !list) return { error: { message: `malformed REFERENCES on ${ident.name}`, token } };
      let onDelete = 'NO ACTION';
      i = list.next;
      while (i < end) {
        if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'DELETE')) {
          if (isWord(tokens[i + 2], 'CASCADE') || isWord(tokens[i + 2], 'RESTRICT')) { onDelete = tokens[i + 2].upper; i += 3; }
          else if ((isWord(tokens[i + 2], 'SET') || isWord(tokens[i + 2], 'NO'))
            && (isWord(tokens[i + 3], 'NULL') || isWord(tokens[i + 3], 'DEFAULT') || isWord(tokens[i + 3], 'ACTION'))) {
            onDelete = `${tokens[i + 2].upper} ${tokens[i + 3].upper}`; i += 4;
          } else return { error: { message: `unsupported DELETE action on ${ident.name}`, token: tokens[i + 2] } };
        } else if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'UPDATE')) {
          i += 2;
          if (isWord(tokens[i], 'CASCADE') || isWord(tokens[i], 'RESTRICT')) i++;
          else if (isWord(tokens[i], 'SET') || isWord(tokens[i], 'NO')) i += 2;
          else return { error: { message: `unsupported UPDATE action on ${ident.name}`, token: tokens[i] } };
        } else if (isWord(tokens[i], 'NOT') && isWord(tokens[i + 1], 'VALID')) i += 2;
        else break;
      }
      def.reference = { refTable: ref.name, refColumns: list.columns, onDelete };
      continue;
    }
    if (isWord(token, 'FIRST')) { def.position = { kind: 'first' }; i++; continue; }
    if (isWord(token, 'AFTER')) {
      const after = parseIdent(tokens, i + 1, engine);
      if (!after) return { error: { message: `AFTER on ${ident.name} needs a column`, token } };
      def.position = { kind: 'after', column: after.name }; i = after.next; continue;
    }
    return { error: { message: `unsupported column clause ${token.text} on ${ident.name}`, token } };
  }
  return { def };
}

function generatedName(prefix: string, columns: string[]) {
  return `${prefix}_${columns.join('_')}`;
}

function parseTableConstraint(tokens: Token[], start: number, end: number, engine: ChangeReviewEngine): {
  index?: ReviewIndex; fk?: ReviewForeignKey; ignoredCheck?: boolean; error?: ParseError;
} {
  let i = start;
  let constraintName = '';
  if (isWord(tokens[i], 'CONSTRAINT')) {
    const name = parseIdent(tokens, i + 1, engine);
    if (!name) return { error: { message: 'CONSTRAINT needs a name', token: tokens[i] } };
    constraintName = name.name;
    i = name.next;
  }
  if (isWord(tokens[i], 'CHECK')) {
    const close = matchingParen(tokens, i + 1, end);
    return close === null
      ? { error: { message: 'malformed CHECK constraint', token: tokens[i] } }
      : { ignoredCheck: true };
  }
  if (isWord(tokens[i], 'PRIMARY') && isWord(tokens[i + 1], 'KEY')) {
    i += 2;
    while (i < end && !isSymbol(tokens[i], '(')) i++;
    const list = parseColumnList(tokens, i, engine);
    return list ? { index: { name: 'PRIMARY', columns: list.columns, unique: true } }
      : { error: { message: 'malformed PRIMARY KEY', token: tokens[start] } };
  }
  let unique = false;
  if (isWord(tokens[i], 'UNIQUE')) { unique = true; i++; }
  if (unique || isWord(tokens[i], 'INDEX') || isWord(tokens[i], 'KEY')
    || isWord(tokens[i], 'FULLTEXT') || isWord(tokens[i], 'SPATIAL')) {
    if (isWord(tokens[i], 'INDEX') || isWord(tokens[i], 'KEY') || isWord(tokens[i], 'FULLTEXT') || isWord(tokens[i], 'SPATIAL')) i++;
    if (isWord(tokens[i], 'INDEX') || isWord(tokens[i], 'KEY')) i++;
    let name = '';
    if (!isSymbol(tokens[i], '(')) {
      const ident = parseIdent(tokens, i, engine);
      if (!ident) return { error: { message: 'index needs a name or column list', token: tokens[i] } };
      name = ident.name; i = ident.next;
    }
    while (i < end && !isSymbol(tokens[i], '(')) i++;
    const list = parseColumnList(tokens, i, engine);
    if (!list) return { error: { message: 'malformed index column list', token: tokens[start] } };
    return { index: { name: name || generatedName(unique ? 'unique' : 'idx', list.columns), columns: list.columns, unique } };
  }
  if (isWord(tokens[i], 'FOREIGN') && isWord(tokens[i + 1], 'KEY')) {
    i += 2;
    if (!isSymbol(tokens[i], '(')) {
      const ident = parseIdent(tokens, i, engine);
      if (!ident) return { error: { message: 'malformed FOREIGN KEY name', token: tokens[i] } };
      if (!constraintName) constraintName = ident.name;
      i = ident.next;
    }
    const local = parseColumnList(tokens, i, engine);
    if (!local || !isWord(tokens[local.next], 'REFERENCES')) {
      return { error: { message: 'FOREIGN KEY needs local columns and REFERENCES', token: tokens[start] } };
    }
    const ref = parseRef(tokens, local.next + 1, engine);
    const remote = ref ? parseColumnList(tokens, ref.next, engine) : null;
    if (!ref || !remote) return { error: { message: 'FOREIGN KEY needs referenced columns', token: tokens[start] } };
    let onDelete = 'NO ACTION';
    i = remote.next;
    while (i < end) {
      if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'DELETE')) {
        if (isWord(tokens[i + 2], 'CASCADE') || isWord(tokens[i + 2], 'RESTRICT')) { onDelete = tokens[i + 2].upper; i += 3; }
        else if ((isWord(tokens[i + 2], 'SET') || isWord(tokens[i + 2], 'NO'))
          && (isWord(tokens[i + 3], 'NULL') || isWord(tokens[i + 3], 'DEFAULT') || isWord(tokens[i + 3], 'ACTION'))) {
          onDelete = `${tokens[i + 2].upper} ${tokens[i + 3].upper}`; i += 4;
        } else return { error: { message: 'unsupported FOREIGN KEY delete action', token: tokens[i + 2] } };
      } else if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'UPDATE')) {
        i += 2;
        if (isWord(tokens[i], 'CASCADE') || isWord(tokens[i], 'RESTRICT')) i++;
        else if (isWord(tokens[i], 'SET') || isWord(tokens[i], 'NO')) i += 2;
        else return { error: { message: 'unsupported FOREIGN KEY update action', token: tokens[i] } };
      } else if (isWord(tokens[i], 'NOT') && isWord(tokens[i + 1], 'VALID')) i += 2;
      else if (isWord(tokens[i], 'DEFERRABLE') || isWord(tokens[i], 'INITIALLY')) i += isWord(tokens[i], 'INITIALLY') ? 2 : 1;
      else return { error: { message: `unsupported FOREIGN KEY clause ${tokens[i].text}`, token: tokens[i] } };
    }
    return { fk: {
      name: constraintName || generatedName('fk', local.columns), columns: local.columns,
      refTable: ref.name, refColumns: remote.columns, onDelete,
    } };
  }
  return { error: { message: `unsupported table constraint ${tokens[start]?.text ?? ''}`, token: tokens[start] } };
}

interface TypeInfo {
  base: string;
  args: number[];
  unsigned: boolean;
  array: boolean;
}

function typeInfo(raw: string, engine: ChangeReviewEngine): TypeInfo {
  const normalized = raw.toLowerCase().replace(/[`"]/g, '').replace(/\s+/g, ' ').trim();
  const array = /\[\]\s*$/.test(normalized);
  const unsigned = engine === 'mysql' && /\bunsigned\b/.test(normalized);
  const args = [...normalized.matchAll(/\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/g)]
    .flatMap(m => [Number(m[1]), ...(m[2] === undefined ? [] : [Number(m[2])])]);
  let base = normalized.replace(/\([^)]*\)/g, '').replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\[\]/g, '').replace(/\s+/g, ' ').trim();
  const aliases: Record<string, string> = engine === 'postgres' ? {
    int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint',
    'character varying': 'varchar', 'double precision': 'double',
    'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time', 'time with time zone': 'timetz',
  } : { integer: 'int', dec: 'decimal', numeric: 'decimal', 'double precision': 'double' };
  base = aliases[base] ?? base;
  return { base, args, unsigned, array };
}

function compareTypes(before: string, after: string, engine: ChangeReviewEngine): {
  narrowing: boolean; changed: boolean; reason: string;
} {
  const a = typeInfo(before, engine);
  const b = typeInfo(after, engine);
  const changed = a.base !== b.base || a.unsigned !== b.unsigned || a.array !== b.array
    || a.args.join(',') !== b.args.join(',');
  if (!changed) return { narrowing: false, changed: false, reason: '' };
  const integerBits: Record<string, number> = engine === 'postgres'
    ? { smallint: 16, integer: 32, bigint: 64 }
    : { tinyint: 8, smallint: 16, mediumint: 24, int: 32, bigint: 64 };
  if (integerBits[a.base] && integerBits[b.base]) {
    return (integerBits[b.base] < integerBits[a.base]) || (a.unsigned && !b.unsigned && integerBits[a.base] === integerBits[b.base])
      ? { narrowing: true, changed, reason: `${before} has a wider range than ${after}` }
      : { narrowing: false, changed, reason: `integer conversion from ${before} to ${after} still validates every value` };
  }
  if ((a.base === 'varchar' || a.base === 'char') && a.base === b.base && a.args[0] != null && b.args[0] != null) {
    return b.args[0] < a.args[0]
      ? { narrowing: true, changed, reason: `maximum length falls from ${a.args[0]} to ${b.args[0]}` }
      : { narrowing: false, changed, reason: 'string length increases' };
  }
  if ((a.base === 'decimal' || a.base === 'numeric') && a.base === b.base && a.args.length && b.args.length) {
    const ap = a.args[0], as = a.args[1] ?? 0, bp = b.args[0], bs = b.args[1] ?? 0;
    return bp < ap || bs < as || bp - bs < ap - as
      ? { narrowing: true, changed, reason: `decimal precision/scale falls from (${ap},${as}) to (${bp},${bs})` }
      : { narrowing: false, changed, reason: 'decimal precision increases' };
  }
  if (a.base === b.base && a.unsigned !== b.unsigned) {
    return a.unsigned
      ? { narrowing: true, changed, reason: 'the signed target cannot represent the upper half of the unsigned range' }
      : { narrowing: false, changed, reason: 'negative existing values cannot convert to unsigned' };
  }
  if (a.base === b.base && a.array === b.array) {
    return { narrowing: false, changed, reason: `type modifiers change from ${before} to ${after}` };
  }
  return { narrowing: true, changed, reason: `${before} → ${after} is a cross-type conversion that may reject or lose values` };
}

function catalogTables(catalog: SchemaSnapshot | undefined): Map<string, ReviewTable> {
  const states = new Map<string, ReviewTable>();
  if (!catalog) return states;
  for (const item of catalog.tables) {
    states.set(norm(item.name), {
      name: item.name, complete: true, source: 'catalog', columns: [], indexes: [], foreignKeys: [],
      rows: item.rows, bytes: item.dataBytes == null ? null : item.dataBytes + (item.indexBytes ?? 0),
    });
  }
  for (const col of catalog.columns) {
    states.get(norm(col.table))?.columns.push({
      name: col.name, type: col.columnType || col.dataType, nullable: col.nullable,
      hasDefault: col.defaultValue != null,
    });
  }
  for (const idx of catalog.indexes) {
    states.get(norm(idx.table))?.indexes.push({
      name: idx.name, columns: idx.columns.sort((a, b) => a.seq - b.seq).map(c => c.name), unique: idx.unique,
    });
  }
  const grouped = new Map<string, ReviewForeignKey>();
  for (const fk of catalog.foreignKeys) {
    const key = `${norm(fk.table)}\u0000${norm(fk.name)}`;
    let value = grouped.get(key);
    if (!value) {
      value = { name: fk.name, columns: [], refTable: fk.refTable, refColumns: [], onDelete: fk.onDelete || 'NO ACTION' };
      grouped.set(key, value);
    }
    value.columns[fk.ordinal - 1] = fk.column;
    value.refColumns[fk.ordinal - 1] = fk.refColumn;
  }
  for (const [key, fk] of grouped) states.get(key.split('\u0000')[0])?.foreignKeys.push(fk);
  return states;
}

class Reviewer {
  readonly states: Map<string, ReviewTable>;
  readonly statements: ChangeStatement[] = [];
  readonly findings: Finding[] = [];
  readonly dropped = new Set<string>();
  readonly recreated = new Set<string>();
  readonly rebuilds = new Map<string, number>();
  private findingNumber = 0;
  private readonly lineStarts: number[] = [0];
  readonly options: ChangeReviewOptions;

  constructor(options: ChangeReviewOptions) {
    this.options = options;
    this.states = catalogTables(options.catalog);
    for (let i = 0; i < options.sql.length; i++) if (options.sql[i] === '\n') this.lineStarts.push(i + 1);
  }

  at(offset: number) {
    let lo = 0, hi = this.lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo] + 1 };
  }

  finding(stmt: ChangeStatement, severity: Severity, title: string, detail: string, token?: Token, extra: Partial<Finding> = {}) {
    const at = this.at(token?.from ?? this.statementOffsets[stmt.number - 1] ?? 0);
    const finding: Finding = {
      id: `CR${++this.findingNumber}`, severity, title, detail, at,
      snippet: this.sourceStatements[stmt.number - 1]?.text.trim().replace(/;?\s*$/, '').slice(0, 500),
      confidence: 'inferred', ...extra,
    };
    stmt.findings.push(finding);
    this.findings.push(finding);
    return finding;
  }

  private statementOffsets: number[] = [];
  private sourceStatements: Statement[] = [];

  run(): ChangeReviewResult {
    this.sourceStatements = splitStatements(this.options.sql);
    this.statementOffsets = this.sourceStatements.map(s => firstCodeOffset(s));
    for (let index = 0; index < this.sourceStatements.length; index++) {
      const source = this.sourceStatements[index];
      const offset = this.statementOffsets[index];
      const at = this.at(offset);
      const stmt: ChangeStatement = {
        number: index + 1, line: at.line, col: at.col, kind: 'unsupported', table: null,
        supported: false, summary: 'Not analyzed', findings: [], cost: null, after: [],
      };
      this.statements.push(stmt);
      this.parseStatement(source, stmt);
    }
    this.crossTableRules();
    const tables = [...this.states.values()].map(cloneTable).sort((a, b) => a.name.localeCompare(b.name));
    return {
      statements: this.statements, tables, findings: this.findings,
      sections: this.sections(tables),
      summary: {
        statements: this.statements.length,
        supported: this.statements.filter(s => s.supported).length,
        unsupported: this.statements.filter(s => !s.supported).length,
        destructive: this.findings.filter(f => /DROP|TRUNCATE|destroy/i.test(f.title) && f.severity === 'red').length,
        rebuilds: this.statements.filter(s => s.cost?.rebuild).length,
      },
    };
  }

  private parseStatement(source: Statement, stmt: ChangeStatement) {
    const localOffset = firstCodeOffset(source) - source.from;
    const body = source.text.slice(localOffset).replace(/;\s*$/, '');
    const base = firstCodeOffset(source);
    const { tokens, error } = tokenize(body, this.options.engine, base);
    if (error || tokens.length === 0) {
      this.finding(stmt, 'orange', 'Parser uncertainty — review is incomplete',
        `${error ?? 'Empty statement'}; this statement was not applied to the post-migration model.`);
      return;
    }
    const start = tokens[0];
    if (isWord(start, 'CREATE') && tokens.some(t => isWord(t, 'TABLE'))) this.parseCreateTable(tokens, stmt);
    else if (isWord(start, 'ALTER') && isWord(tokens[1], 'TABLE')) this.parseAlterTable(body, tokens, stmt);
    else if (isWord(start, 'DROP') && (isWord(tokens[1], 'TABLE') || (isWord(tokens[1], 'TEMPORARY') && isWord(tokens[2], 'TABLE')))) this.parseDropTable(tokens, stmt);
    else if (isWord(start, 'TRUNCATE')) this.parseTruncate(tokens, stmt);
    else if (isWord(start, 'CREATE') && tokens.some(t => isWord(t, 'INDEX'))) this.parseCreateIndex(tokens, stmt);
    else if (isWord(start, 'DROP') && isWord(tokens[1], 'INDEX')) this.parseDropIndex(tokens, stmt);
    else {
      this.finding(stmt, 'orange', 'Unsupported statement — review is incomplete',
        `${start.text} is outside the table-migration parser. It was not applied to the post-migration model; review it manually.`, start);
    }
  }

  private unknownTable(stmt: ChangeStatement, name: string, token?: Token) {
    this.finding(stmt, 'orange', `Before-state of ${name} is unknown`,
      'Choose a database to seed the live catalog, or include the CREATE TABLE earlier in the migration. '
      + 'Only statement-level checks were possible; the final shape of this table remains partial.', token);
  }

  private ensureTable(name: string): ReviewTable {
    const key = norm(name);
    let table = this.states.get(key);
    if (!table) {
      table = { name, complete: false, source: 'partial', columns: [], indexes: [], foreignKeys: [], rows: null, bytes: null };
      this.states.set(key, table);
    }
    return table;
  }

  private addCost(stmt: ChangeStatement, sql: string, table: ReviewTable | undefined, volatileDefault = false) {
    let cost = ddlCost(sql, this.options.engine, table?.bytes ?? null);
    if (cost && volatileDefault && this.options.engine === 'postgres') {
      const bytes = table?.bytes ?? null;
      const seconds = bytes == null ? null : Math.max(ASSUMPTIONS.instantFloorSeconds, bytes / 1024 / 1024 / ASSUMPTIONS.rebuildMbPerSec);
      cost = {
        ...cost, operation: 'ADD COLUMN with a volatile default', algorithm: 'REWRITE', rebuild: true,
        why: 'a volatile default is evaluated for every existing row and rewrites the table',
        seconds, blockedSeconds: seconds, diskBytes: bytes, replicaLagSeconds: seconds,
      };
    }
    if (cost && !cost.rebuild && this.options.engine === 'mysql'
      && /\b(?:drop\s+column|drop\s+primary\s+key|modify\s+(?:column\s+)?|change\s+(?:column\s+)?)/i.test(sql)) {
      const bytes = table?.bytes ?? null;
      const seconds = bytes == null ? null : Math.max(ASSUMPTIONS.instantFloorSeconds, bytes / 1024 / 1024 / ASSUMPTIONS.rebuildMbPerSec);
      cost = {
        ...cost, operation: 'Multi-action ALTER TABLE', algorithm: 'COPY', lock: 'SHARED', rebuild: true,
        why: 'at least one action in this ALTER changes the row format or clustered key',
        seconds, blockedSeconds: seconds, diskBytes: bytes, replicaLagSeconds: seconds,
      };
    }
    stmt.cost = cost;
    if (!cost) return;
    if (this.options.mariaDb) {
      this.finding(stmt, 'yellow', 'MariaDB online-DDL behavior is version-dependent',
        'The algorithm/lock fields reuse the MySQL 8 cost model as an estimate. Confirm the MariaDB version’s ALTER support; do not treat INSTANT/INPLACE as a server guarantee.');
    }
    const evidence = cost.seconds == null ? undefined : [{
      source: 'DDL cost model', value: `${cost.seconds.toFixed(2)} s at ${ASSUMPTIONS.rebuildMbPerSec} MB/s`, modelled: true,
    }];
    if (cost.rebuild) {
      const key = stmt.table ? norm(stmt.table) : '';
      this.rebuilds.set(key, (this.rebuilds.get(key) ?? 0) + 1);
      this.finding(stmt, 'orange', `${cost.operation} rewrites ${stmt.table ?? 'the table'}`,
        `${cost.why}. Algorithm ${cost.algorithm}, lock ${cost.lock}; the duration is a model estimate, not a measurement.`,
        undefined, {
          why: 'A rewrite holds its lock while every row and dependent index is written again, and can add replica lag and a second table copy of disk usage.',
          evidence, cost: {
            ...(cost.seconds == null ? {} : { seconds: cost.seconds }),
            ...(cost.blockedSeconds == null ? {} : { blockedSeconds: cost.blockedSeconds }),
            ...(cost.diskBytes == null ? {} : { bytes: cost.diskBytes }),
          },
        });
    } else if (cost.algorithm === 'UNKNOWN' || cost.lock === 'UNKNOWN') {
      this.finding(stmt, 'yellow', `DDL algorithm for ${stmt.table ?? 'statement'} is not modeled`,
        cost.why);
    } else if (this.options.engine === 'postgres' && cost.lock === 'EXCLUSIVE') {
      this.finding(stmt, 'yellow', `${cost.operation} takes an ACCESS EXCLUSIVE lock`,
        `${cost.why}. Even a catalog-only change can queue behind existing transactions and block all new readers and writers.`);
    }
  }

  private parseCreateTable(tokens: Token[], stmt: ChangeStatement) {
    stmt.kind = 'create-table';
    let i = 1;
    if (isWord(tokens[i], 'TEMPORARY')) i++;
    if (!isWord(tokens[i], 'TABLE')) { this.unsupported(stmt, tokens[i], 'only CREATE TABLE is supported here'); return; }
    i++;
    let ifNotExists = false;
    if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'NOT') && isWord(tokens[i + 2], 'EXISTS')) { ifNotExists = true; i += 3; }
    const ref = parseRef(tokens, i, this.options.engine);
    if (!ref) { this.unsupported(stmt, tokens[i], 'malformed CREATE TABLE name'); return; }
    stmt.table = ref.name;
    if (!isSymbol(tokens[ref.next], '(')) {
      this.unsupported(stmt, tokens[ref.next], 'CREATE TABLE AS/LIKE and table definitions without a column list are not modeled'); return;
    }
    const close = matchingParen(tokens, ref.next);
    if (close === null) { this.unsupported(stmt, tokens[ref.next], 'unclosed CREATE TABLE column list'); return; }
    if (close === ref.next + 1 || isSymbol(tokens[close - 1], ',')) {
      this.unsupported(stmt, tokens[close - 1], 'empty or trailing-comma table definitions are not valid supported DDL'); return;
    }
    const unsupportedTail = tokens.slice(close + 1).find(t => isWord(t, 'PARTITION') || isWord(t, 'INHERITS')
      || isWord(t, 'AS') || isWord(t, 'SELECT') || isWord(t, 'LIKE'));
    if (unsupportedTail) {
      this.unsupported(stmt, unsupportedTail, `CREATE TABLE ${unsupportedTail.text} clauses are outside the table model`); return;
    }
    const table: ReviewTable = {
      name: ref.name, complete: true, source: 'migration', columns: [], indexes: [], foreignKeys: [], rows: 0, bytes: 0,
    };
    for (const [a, b] of splitTokenRanges(tokens, ref.next + 1, close)) {
      const first = tokens[a];
      const constraintStart = isWord(first, 'CONSTRAINT') || isWord(first, 'PRIMARY') || isWord(first, 'UNIQUE')
        || isWord(first, 'FOREIGN') || isWord(first, 'INDEX') || isWord(first, 'KEY')
        || isWord(first, 'FULLTEXT') || isWord(first, 'SPATIAL') || isWord(first, 'CHECK');
      if (constraintStart) {
        const constraint = parseTableConstraint(tokens, a, b, this.options.engine);
        if (constraint.error) { this.unsupported(stmt, constraint.error.token, constraint.error.message); return; }
        if (constraint.index) table.indexes.push(constraint.index);
        if (constraint.fk) table.foreignKeys.push(constraint.fk);
        continue;
      }
      const parsedColumn = parseColumnDef(tokens, a, b, this.options.sql, this.options.engine);
      if (parsedColumn.error) {
        this.unsupported(stmt, parsedColumn.error.token, parsedColumn.error.message); return;
      }
      const def = parsedColumn.def!;
      const { position: _position, primary, unique, reference, ...column } = def;
      table.columns.push(column);
      if (primary) table.indexes.push({ name: 'PRIMARY', columns: [def.name], unique: true });
      if (unique) table.indexes.push({ name: generatedName('unique', [def.name]), columns: [def.name], unique: true });
      if (reference) table.foreignKeys.push({ name: generatedName('fk', [def.name]), columns: [def.name], ...reference });
    }
    const primary = table.indexes.find(index => index.name === 'PRIMARY');
    if (primary) for (const column of table.columns) {
      if (primary.columns.some(name => norm(name) === norm(column.name))) column.nullable = false;
    }
    stmt.supported = true;
    stmt.summary = `Create ${ref.name} with ${table.columns.length} columns, ${table.indexes.length} indexes and ${table.foreignKeys.length} foreign keys`;
    const previous = this.states.get(norm(ref.name));
    if (previous && !ifNotExists) {
      this.finding(stmt, 'orange', `CREATE TABLE ${ref.name} targets an existing table`,
        'The live/pre-change model already contains this table; without IF NOT EXISTS the statement fails rather than producing the declared post-state.', tokens[ref.next - 1]);
    }
    if (previous && ifNotExists) {
      stmt.summary += '; IF NOT EXISTS can make it a no-op';
      this.finding(stmt, 'info', `CREATE TABLE IF NOT EXISTS ${ref.name} may be a no-op`,
        'The table already exists in the before-state. Its existing definition, not this CREATE definition, is retained in the model.');
      stmt.after = [cloneTable(previous)];
      return;
    }
    if (this.dropped.has(norm(ref.name))) this.recreated.add(norm(ref.name));
    this.states.set(norm(ref.name), table);
    stmt.after = [cloneTable(table)];
  }

  private unsupported(stmt: ChangeStatement, token: Token | undefined, message: string) {
    const discarded = new Set(stmt.findings);
    this.findings.splice(0, this.findings.length, ...this.findings.filter(f => !discarded.has(f)));
    stmt.findings = [];
    stmt.supported = false;
    stmt.summary = 'Not analyzed';
    stmt.cost = null;
    stmt.after = [];
    this.finding(stmt, 'orange', 'Unsupported or uncertain DDL — review is incomplete',
      `${message}. No part of this statement was applied to the post-migration model.`, token);
  }

  private parseAlterTable(body: string, tokens: Token[], stmt: ChangeStatement) {
    stmt.kind = 'alter-table';
    let i = 2;
    if (isWord(tokens[i], 'ONLY')) i++;
    if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'EXISTS')) i += 2;
    const ref = parseRef(tokens, i, this.options.engine);
    if (!ref) { this.unsupported(stmt, tokens[i], 'malformed ALTER TABLE target'); return; }
    stmt.table = ref.name;
    const existing = this.states.get(norm(ref.name));
    const table = existing ? cloneTable(existing) : this.emptyPartial(ref.name);
    const before = existing ? cloneTable(existing) : null;
    if (!existing) this.unknownTable(stmt, ref.name, tokens[i]);
    const clauses = splitTokenRanges(tokens, ref.next, tokens.length);
    if (!clauses.length) { this.unsupported(stmt, tokens[ref.next], 'ALTER TABLE has no actions'); return; }
    const changes: string[] = [];
    let volatileDefault = false;
    for (const [a, b] of clauses) {
      if (a >= b) continue;
      if (this.alterOptions(tokens, a, b)) continue;
      const result = this.applyAlter(table, before, body, tokens, a, b, stmt);
      if (result.error) { this.unsupported(stmt, result.error.token, result.error.message); return; }
      if (result.change) changes.push(result.change);
      if (result.volatileDefault) volatileDefault = true;
    }
    stmt.supported = true;
    stmt.summary = changes.length ? changes.join('; ') : 'Table options only';
    this.states.set(norm(ref.name), table);
    this.addCost(stmt, body, existing ?? table, volatileDefault);
    stmt.after = [cloneTable(table)];
  }

  private emptyPartial(name: string): ReviewTable {
    return { name, complete: false, source: 'partial', columns: [], indexes: [], foreignKeys: [], rows: null, bytes: null };
  }

  private alterOptions(tokens: Token[], a: number, b: number) {
    return (isWord(tokens[a], 'ALGORITHM') || isWord(tokens[a], 'LOCK'))
      && (isSymbol(tokens[a + 1], '=') ? b === a + 3 : b === a + 2);
  }

  private applyAlter(table: ReviewTable, before: ReviewTable | null, body: string, tokens: Token[], a: number, b: number, stmt: ChangeStatement): {
    change?: string; volatileDefault?: boolean; error?: ParseError;
  } {
    let i = a;
    if (isWord(tokens[i], 'ADD')) {
      i++;
      const constraint = parseTableConstraint(tokens, i, b, this.options.engine);
      if (!constraint.error && (constraint.index || constraint.fk || constraint.ignoredCheck)) {
        if (constraint.index) {
          this.upsertIndex(table, constraint.index);
          if (constraint.index.unique) this.finding(stmt, 'yellow', `Adding unique index ${constraint.index.name} validates existing rows`,
            'The statement fails if existing data contains duplicates; the index build can also block writes depending on dialect and options.', tokens[a]);
          return { change: `Add index ${constraint.index.name}(${constraint.index.columns.join(', ')})` };
        }
        if (constraint.fk) {
          table.foreignKeys.push(constraint.fk);
          this.finding(stmt, 'yellow', `Adding foreign key ${constraint.fk.name} validates existing rows`,
            this.options.engine === 'postgres' && /\bNOT\s+VALID\b/i.test(body)
              ? 'NOT VALID skips the existing-row scan; existing violations remain until VALIDATE CONSTRAINT.'
              : 'Existing orphan rows make the statement fail, and validation scans the child table.', tokens[a]);
          return { change: `Add foreign key ${constraint.fk.name}` };
        }
        return { change: 'Add CHECK constraint' };
      }
      const isColumn = isWord(tokens[i], 'COLUMN');
      if (isColumn) i++;
      if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'NOT') && isWord(tokens[i + 2], 'EXISTS')) i += 3;
      const parsed = parseColumnDef(tokens, i, b, this.options.sql, this.options.engine);
      if (parsed.error) {
        if (!isColumn && constraint.error) return { error: constraint.error };
        return { error: parsed.error };
      }
      const def = parsed.def!;
      const duplicate = table.columns.find(c => norm(c.name) === norm(def.name));
      if (duplicate) this.finding(stmt, 'orange', `ADD COLUMN ${table.name}.${def.name} duplicates an existing column`,
        'The before-state already contains this column. Without a supported IF NOT EXISTS no-op, the statement fails.', tokens[i]);
      const { position, primary, unique, reference, ...column } = def;
      const insertAt = position?.kind === 'first' ? 0
        : position?.kind === 'after' ? table.columns.findIndex(c => norm(c.name) === norm(position.column)) + 1
          : table.columns.length;
      table.columns.splice(insertAt < 0 ? table.columns.length : insertAt, 0, column);
      if (primary) this.upsertIndex(table, { name: 'PRIMARY', columns: [def.name], unique: true });
      if (unique) this.upsertIndex(table, { name: generatedName('unique', [def.name]), columns: [def.name], unique: true });
      if (reference) table.foreignKeys.push({ name: generatedName('fk', [def.name]), columns: [def.name], ...reference });
      if (!column.nullable && !column.hasDefault) {
        this.finding(stmt, 'orange', `ADD COLUMN ${table.name}.${def.name} is NOT NULL without a default`,
          (table.rows ?? 0) > 0 || table.rows == null
            ? 'On a non-empty table there is no value for existing rows; add/backfill a default or add it nullable before enforcing NOT NULL.'
            : 'The current table estimate is empty, but any rows present when this runs make the change fail.', tokens[i]);
      }
      const defaultText = this.defaultText(tokens, i, b);
      return { change: `Add column ${def.name} ${def.type}${def.nullable ? '' : ' NOT NULL'}`, volatileDefault: this.volatileDefault(defaultText) };
    }
    if (isWord(tokens[i], 'DROP')) {
      i++;
      if (isWord(tokens[i], 'PRIMARY') && isWord(tokens[i + 1], 'KEY')) {
        table.indexes = table.indexes.filter(idx => idx.name !== 'PRIMARY');
        this.finding(stmt, 'orange', `DROP PRIMARY KEY on ${table.name}`,
          'Removing the primary key also removes the table’s identity/uniqueness guarantee and can force a table rebuild.', tokens[a]);
        return { change: 'Drop primary key' };
      }
      if (isWord(tokens[i], 'INDEX') || isWord(tokens[i], 'KEY')) {
        const name = parseIdent(tokens, i + 1, this.options.engine);
        if (!name) return { error: { message: 'DROP INDEX needs a name', token: tokens[i] } };
        table.indexes = table.indexes.filter(idx => norm(idx.name) !== norm(name.name));
        this.finding(stmt, 'yellow', `DROP INDEX ${name.name} removes a query access path`,
          'Queries that depended on this index may scan the table after migration.', tokens[a]);
        return { change: `Drop index ${name.name}` };
      }
      if (isWord(tokens[i], 'CONSTRAINT') || isWord(tokens[i], 'FOREIGN')) {
        const foreign = isWord(tokens[i], 'FOREIGN');
        const name = parseIdent(tokens, i + (foreign ? 2 : 1), this.options.engine);
        if (!name || (foreign && !isWord(tokens[i + 1], 'KEY'))) return { error: { message: 'DROP CONSTRAINT/FOREIGN KEY needs a name', token: tokens[i] } };
        table.foreignKeys = table.foreignKeys.filter(fk => norm(fk.name) !== norm(name.name));
        table.indexes = table.indexes.filter(idx => norm(idx.name) !== norm(name.name));
        this.finding(stmt, 'yellow', `DROP CONSTRAINT ${name.name} removes an integrity guarantee`,
          'Existing and future rows are no longer checked by this constraint.', tokens[a]);
        return { change: `Drop constraint ${name.name}` };
      }
      if (isWord(tokens[i], 'COLUMN')) i++;
      if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'EXISTS')) i += 2;
      const name = parseIdent(tokens, i, this.options.engine);
      if (!name) return { error: { message: 'unsupported DROP action', token: tokens[a] } };
      const found = table.columns.some(c => norm(c.name) === norm(name.name));
      if (before && !found) this.finding(stmt, 'orange', `DROP COLUMN ${table.name}.${name.name} targets a missing column`,
        'The before-state has no such column; without IF EXISTS the statement fails.', tokens[i]);
      table.columns = table.columns.filter(c => norm(c.name) !== norm(name.name));
      table.indexes = table.indexes.filter(idx => !idx.columns.some(c => norm(c) === norm(name.name)));
      table.foreignKeys = table.foreignKeys.filter(fk => !fk.columns.some(c => norm(c) === norm(name.name)));
      this.finding(stmt, 'red', `DROP COLUMN ${table.name}.${name.name} destroys data`,
        'Every value in the column is discarded. Any index or foreign key that depends only on it is removed from the post-change model; application and view dependencies are not simulated.', tokens[i]);
      return { change: `Drop column ${name.name}` };
    }
    if (isWord(tokens[i], 'MODIFY') || isWord(tokens[i], 'CHANGE')) {
      if (this.options.engine !== 'mysql') return { error: { message: `${tokens[i].text} COLUMN is MySQL/MariaDB syntax, not PostgreSQL`, token: tokens[i] } };
      const change = isWord(tokens[i], 'CHANGE');
      i++;
      if (isWord(tokens[i], 'COLUMN')) i++;
      const oldName = parseIdent(tokens, i, this.options.engine);
      if (!oldName) return { error: { message: 'MODIFY/CHANGE needs a column name', token: tokens[i] } };
      const parsed = parseColumnDef(tokens, change ? oldName.next : i, b, this.options.sql, this.options.engine);
      if (parsed.error) return { error: parsed.error };
      const def = parsed.def!;
      const previous = table.columns.find(c => norm(c.name) === norm(oldName.name));
      if (before && !previous) this.finding(stmt, 'orange', `${tokens[a].text} COLUMN ${oldName.name} targets a missing column`,
        'The before-state has no such column, so the statement fails.', tokens[i]);
      this.typeAndNullFindings(stmt, table.name, previous, def, tokens[i]);
      const { position: _position, primary, unique, reference, ...next } = def;
      if (change) {
        table.indexes.forEach(idx => { idx.columns = idx.columns.map(c => norm(c) === norm(oldName.name) ? def.name : c); });
        table.foreignKeys.forEach(fk => { fk.columns = fk.columns.map(c => norm(c) === norm(oldName.name) ? def.name : c); });
      }
      if (previous) Object.assign(previous, next);
      else table.columns.push(next);
      if (primary) this.upsertIndex(table, { name: 'PRIMARY', columns: [def.name], unique: true });
      if (unique) this.upsertIndex(table, { name: generatedName('unique', [def.name]), columns: [def.name], unique: true });
      if (reference) table.foreignKeys.push({ name: generatedName('fk', [def.name]), columns: [def.name], ...reference });
      return { change: `${change ? 'Change' : 'Modify'} column ${oldName.name}${change ? ` → ${def.name}` : ''} ${def.type}` };
    }
    if (isWord(tokens[i], 'ALTER')) {
      if (this.options.engine !== 'postgres') return { error: { message: 'ALTER COLUMN action form is PostgreSQL syntax in this parser', token: tokens[i] } };
      i++;
      if (isWord(tokens[i], 'COLUMN')) i++;
      const name = parseIdent(tokens, i, this.options.engine);
      if (!name) return { error: { message: 'ALTER COLUMN needs a name', token: tokens[i] } };
      i = name.next;
      const previous = table.columns.find(c => norm(c.name) === norm(name.name));
      if (isWord(tokens[i], 'TYPE')) {
        const typeStart = ++i;
        while (i < b && !isWord(tokens[i], 'USING')) i++;
        if (i === typeStart) return { error: { message: 'ALTER COLUMN TYPE needs a type', token: tokens[i] } };
        const first = tokens[typeStart], last = tokens[i - 1];
        const type = this.options.sql.slice(first.from, last.to).trim().replace(/\s+/g, ' ');
        const next: ReviewColumn = { name: name.name, type, nullable: previous?.nullable ?? true, hasDefault: previous?.hasDefault ?? false };
        this.typeAndNullFindings(stmt, table.name, previous, next, tokens[typeStart]);
        if (previous) previous.type = type; else table.columns.push(next);
        return { change: `Alter column ${name.name} type to ${type}` };
      }
      if ((isWord(tokens[i], 'SET') || isWord(tokens[i], 'DROP')) && isWord(tokens[i + 1], 'NOT') && isWord(tokens[i + 2], 'NULL')) {
        const nullable = isWord(tokens[i], 'DROP');
        if (previous) previous.nullable = nullable;
        if (!nullable) this.typeAndNullFindings(stmt, table.name, previous ? { ...previous, nullable: true } : null,
          { name: name.name, type: previous?.type ?? 'unknown', nullable: false, hasDefault: previous?.hasDefault ?? false }, tokens[i]);
        return { change: `${nullable ? 'Drop' : 'Set'} NOT NULL on ${name.name}` };
      }
      if ((isWord(tokens[i], 'SET') || isWord(tokens[i], 'DROP')) && isWord(tokens[i + 1], 'DEFAULT')) {
        if (previous) previous.hasDefault = isWord(tokens[i], 'SET');
        return { change: `${isWord(tokens[i], 'SET') ? 'Set' : 'Drop'} default on ${name.name}` };
      }
      return { error: { message: `unsupported ALTER COLUMN action ${tokens[i]?.text ?? ''}`, token: tokens[i] } };
    }
    if (isWord(tokens[i], 'RENAME')) {
      if (isWord(tokens[i + 1], 'TO') || isWord(tokens[i + 1], 'AS')) {
        return { error: { message: 'table RENAME must be the only ALTER action', token: tokens[i] } };
      }
      if (isWord(tokens[i + 1], 'COLUMN')) i++;
      const oldName = parseIdent(tokens, i + 1, this.options.engine);
      const to = oldName && isWord(tokens[oldName.next], 'TO') ? parseIdent(tokens, oldName.next + 1, this.options.engine) : null;
      if (!oldName || !to) return { error: { message: 'unsupported RENAME action', token: tokens[i] } };
      const col = table.columns.find(c => norm(c.name) === norm(oldName.name));
      if (col) col.name = to.name;
      table.indexes.forEach(idx => { idx.columns = idx.columns.map(c => norm(c) === norm(oldName.name) ? to.name : c); });
      table.foreignKeys.forEach(fk => { fk.columns = fk.columns.map(c => norm(c) === norm(oldName.name) ? to.name : c); });
      return { change: `Rename column ${oldName.name} → ${to.name}` };
    }
    if (isWord(tokens[i], 'ENGINE') || isWord(tokens[i], 'CONVERT') || isWord(tokens[i], 'DEFAULT')
      || isWord(tokens[i], 'CHARACTER') || isWord(tokens[i], 'COLLATE') || isWord(tokens[i], 'ROW_FORMAT')) {
      return { change: `Change table option ${tokens[i].text}` };
    }
    return { error: { message: `unsupported ALTER TABLE action ${tokens[i]?.text ?? ''}`, token: tokens[a] } };
  }

  private defaultText(tokens: Token[], start: number, end: number) {
    for (let i = start; i < end; i++) if (isWord(tokens[i], 'DEFAULT')) {
      const next = skipExpression(tokens, i + 1, end);
      return tokens.slice(i + 1, next).map(t => t.text).join(' ');
    }
    return '';
  }

  private volatileDefault(text: string) {
    return this.options.engine === 'postgres' && /\b(random|gen_random_uuid|uuid_generate_v\d|clock_timestamp)\s*\(/i.test(text);
  }

  private typeAndNullFindings(stmt: ChangeStatement, table: string, before: ReviewColumn | null | undefined, after: ReviewColumn, token?: Token) {
    if (before) {
      const compared = compareTypes(before.type, after.type, this.options.engine);
      if (compared.changed) {
        this.finding(stmt, compared.narrowing ? 'red' : 'orange',
          `${table}.${after.name} ${compared.narrowing ? 'narrows' : 'changes'} type ${before.type} → ${after.type}`,
          `${compared.reason}. Existing values are converted or rejected; check data before running and plan for dependent indexes/views.`,
          token, { evidence: [{ source: before.type === 'unknown' ? 'migration parser' : 'before-state model', value: `${before.type} → ${after.type}` }] });
      }
      if (before.nullable && !after.nullable) {
        this.finding(stmt, 'orange', `${table}.${after.name} changes NULL → NOT NULL`,
          'The statement fails if any existing row contains NULL. Backfill first; on PostgreSQL the validation scan and ACCESS EXCLUSIVE lock also need a maintenance plan.', token);
      }
    } else if (!after.nullable && before === null) {
      this.finding(stmt, 'orange', `NOT NULL on ${table}.${after.name} cannot be checked against the before-state`,
        'The old column/nullability is unknown, so this may be a new constraint that existing NULL rows violate.', token);
    }
  }

  private upsertIndex(table: ReviewTable, index: ReviewIndex) {
    const at = table.indexes.findIndex(i => norm(i.name) === norm(index.name));
    if (at < 0) table.indexes.push(index); else table.indexes[at] = index;
    if (index.name === 'PRIMARY') for (const column of table.columns) {
      if (index.columns.some(name => norm(name) === norm(column.name))) column.nullable = false;
    }
  }

  private parseDropTable(tokens: Token[], stmt: ChangeStatement) {
    stmt.kind = 'drop-table';
    let i = isWord(tokens[1], 'TEMPORARY') ? 3 : 2;
    let ifExists = false;
    if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'EXISTS')) { ifExists = true; i += 2; }
    const refs: Ref[] = [];
    while (i < tokens.length) {
      const ref = parseRef(tokens, i, this.options.engine);
      if (!ref) break;
      refs.push(ref); i = ref.next;
      if (!isSymbol(tokens[i], ',')) break;
      i++;
    }
    if (!refs.length || (i < tokens.length && !isWord(tokens[i], 'CASCADE') && !isWord(tokens[i], 'RESTRICT') && !isSymbol(tokens[i], ';'))) {
      this.unsupported(stmt, tokens[i], 'malformed DROP TABLE list'); return;
    }
    stmt.supported = true;
    stmt.table = refs.map(r => r.name).join(', ');
    stmt.summary = `Drop ${refs.map(r => r.name).join(', ')}`;
    for (const ref of refs) {
      const table = this.states.get(norm(ref.name));
      if (!table && !ifExists) this.finding(stmt, 'orange', `DROP TABLE ${ref.name} targets an unknown/missing table`,
        'Without IF EXISTS this fails if the table is absent. If it exists outside the selected catalog, its dependencies were not available to this review.');
      this.dropped.add(norm(ref.name));
      this.finding(stmt, 'red', `DROP TABLE ${ref.name} destroys the table and its data`,
        'The table, every row, index and constraint is removed. This is not equivalent to a reversible schema-only change.');
      if (table) {
        const edges = this.allEdges();
        const rows = new Map([...this.states.values()].map(t => [t.name, t.rows] as [string, number | null]));
        const cascade = analyzeCascade(table.name, edges, rows, 'drop');
        const summary = summarize(cascade);
        if (summary) this.finding(stmt, 'red', `DROP TABLE ${ref.name} has dependent-table consequences`, summary, undefined, {
          why: cascade.cascades.map(routeText).join('\n') || undefined,
        });
      }
      this.states.delete(norm(ref.name));
    }
    stmt.after = [];
  }

  private parseTruncate(tokens: Token[], stmt: ChangeStatement) {
    stmt.kind = 'truncate';
    let i = 1;
    if (isWord(tokens[i], 'TABLE')) i++;
    if (isWord(tokens[i], 'ONLY')) i++;
    const ref = parseRef(tokens, i, this.options.engine);
    if (!ref) { this.unsupported(stmt, tokens[i], 'malformed TRUNCATE target'); return; }
    stmt.supported = true; stmt.table = ref.name; stmt.summary = `Truncate ${ref.name}`;
    this.finding(stmt, 'red', `TRUNCATE ${ref.name} destroys every row`,
      'The table definition remains but all data is removed. Foreign-key dependencies and trigger/identity side effects need separate operational review.', tokens[i]);
    const table = this.states.get(norm(ref.name));
    if (table) {
      const cascade = analyzeCascade(table.name, this.allEdges(), new Map(), 'truncate');
      const summary = summarize(cascade);
      if (summary) this.finding(stmt, 'red', `TRUNCATE ${ref.name} has dependent-table consequences`, summary);
      table.rows = 0;
      stmt.after = [cloneTable(table)];
    } else this.unknownTable(stmt, ref.name, tokens[i]);
  }

  private parseCreateIndex(tokens: Token[], stmt: ChangeStatement) {
    stmt.kind = 'create-index';
    let i = 1;
    let unique = false;
    if (isWord(tokens[i], 'UNIQUE')) { unique = true; i++; }
    if (!isWord(tokens[i], 'INDEX')) { this.unsupported(stmt, tokens[i], 'only CREATE INDEX is supported here'); return; }
    i++;
    if (isWord(tokens[i], 'CONCURRENTLY')) {
      if (this.options.engine !== 'postgres') { this.unsupported(stmt, tokens[i], 'CREATE INDEX CONCURRENTLY is PostgreSQL syntax'); return; }
      i++;
    }
    if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'NOT') && isWord(tokens[i + 2], 'EXISTS')) i += 3;
    const name = parseIdent(tokens, i, this.options.engine);
    if (!name || !isWord(tokens[name.next], 'ON')) { this.unsupported(stmt, tokens[i], 'CREATE INDEX needs a name and ON table'); return; }
    i = name.next + 1;
    if (isWord(tokens[i], 'ONLY')) i++;
    const ref = parseRef(tokens, i, this.options.engine);
    if (!ref) { this.unsupported(stmt, tokens[i], 'CREATE INDEX needs a target table'); return; }
    i = ref.next;
    if (isWord(tokens[i], 'USING')) i += 2;
    const list = parseColumnList(tokens, i, this.options.engine);
    if (!list) { this.unsupported(stmt, tokens[i], 'only plain column indexes are modeled; expressions/opclasses need manual review'); return; }
    stmt.supported = true; stmt.table = ref.name;
    stmt.summary = `Create ${unique ? 'unique ' : ''}index ${name.name} on ${ref.name}(${list.columns.join(', ')})`;
    const table = this.ensureTable(ref.name);
    if (!table.complete) this.unknownTable(stmt, ref.name, tokens[ref.next - 1]);
    this.upsertIndex(table, { name: name.name, columns: list.columns, unique });
    if (unique) this.finding(stmt, 'yellow', `Adding unique index ${name.name} validates existing rows`,
      'The build fails on duplicate existing values.');
    this.addCost(stmt, this.sourceStatements[stmt.number - 1].text, table);
    stmt.after = [cloneTable(table)];
  }

  private parseDropIndex(tokens: Token[], stmt: ChangeStatement) {
    stmt.kind = 'drop-index';
    let i = 2;
    if (isWord(tokens[i], 'CONCURRENTLY')) i++;
    if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'EXISTS')) i += 2;
    const name = parseIdent(tokens, i, this.options.engine);
    if (!name) { this.unsupported(stmt, tokens[i], 'DROP INDEX needs a name'); return; }
    i = name.next;
    let tableName: string | null = null;
    if (isWord(tokens[i], 'ON')) {
      const ref = parseRef(tokens, i + 1, this.options.engine);
      if (!ref) { this.unsupported(stmt, tokens[i], 'DROP INDEX ON needs a table'); return; }
      tableName = ref.name; i = ref.next;
    }
    if (this.options.engine === 'mysql' && !tableName) { this.unsupported(stmt, tokens[i], 'MySQL DROP INDEX needs ON table'); return; }
    stmt.supported = true; stmt.table = tableName; stmt.summary = `Drop index ${name.name}`;
    const candidates = tableName ? [this.ensureTable(tableName)]
      : [...this.states.values()].filter(t => t.indexes.some(idx => norm(idx.name) === norm(name.name)));
    if (!tableName && candidates.length !== 1) {
      this.finding(stmt, 'orange', `DROP INDEX ${name.name} has an ambiguous post-state`,
        'PostgreSQL drops an index without naming its table; the before-state did not identify exactly one owner, so no index was removed from the model.');
    } else {
      for (const table of candidates) table.indexes = table.indexes.filter(idx => norm(idx.name) !== norm(name.name));
    }
    this.finding(stmt, 'yellow', `DROP INDEX ${name.name} removes a query access path`,
      'Queries that depended on this index may scan after migration.');
    stmt.after = candidates.map(cloneTable);
  }

  private allEdges(): FkEdge[] {
    const out: FkEdge[] = [];
    for (const table of this.states.values()) for (const fk of table.foreignKeys) out.push({
      constraint: fk.name, child: table.name, parent: fk.refTable, onDelete: fk.onDelete as FkEdge['onDelete'], columns: fk.columns.join(', '),
    });
    return out;
  }

  private crossTableRules() {
    const anchor = this.statements[this.statements.length - 1];
    if (!anchor) return;
    for (const table of this.states.values()) {
      if (table.source === 'migration' && table.complete && !table.indexes.some(i => i.name === 'PRIMARY' || i.unique)) {
        this.finding(anchor, 'yellow', `New table ${table.name} has no primary or unique key`,
          'The post-migration model has no uniqueness constraint. Add a real key if this table stores entities rather than append-only/raw data.');
      }
      for (const fk of table.foreignKeys) {
        const parent = this.states.get(norm(fk.refTable));
        if (!parent) {
          this.finding(anchor, 'red', `Foreign key ${table.name}.${fk.name} references missing table ${fk.refTable}`,
            'The final migration model has no such referenced table. The migration fails unless that table exists outside the reviewed schema.');
          continue;
        }
        if (parent.complete && table.complete) {
          for (let i = 0; i < fk.columns.length; i++) {
            const childCol = table.columns.find(c => norm(c.name) === norm(fk.columns[i]));
            const parentCol = parent.columns.find(c => norm(c.name) === norm(fk.refColumns[i]));
            if (!childCol || !parentCol) {
              this.finding(anchor, 'red', `Foreign key ${fk.name} references a missing column`,
                `${table.name}.${fk.columns[i]} → ${fk.refTable}.${fk.refColumns[i]} cannot be resolved in the final model.`);
              continue;
            }
            const cmp = compareTypes(childCol.type, parentCol.type, this.options.engine);
            if (cmp.changed) this.finding(anchor, 'red', `Foreign key ${fk.name} has incompatible column types`,
              `${table.name}.${childCol.name} is ${childCol.type}; ${parent.name}.${parentCol.name} is ${parentCol.type}. Signedness and type must match for a reliable FK.`);
          }
        }
        if (this.options.engine === 'postgres') {
          const cols = fk.columns.map(norm);
          const indexed = table.indexes.some(idx => idx.columns.length >= cols.length
            && cols.every((c, i) => norm(idx.columns[i]) === c));
          if (!indexed) this.finding(anchor, 'yellow', `Foreign key ${table.name}.${fk.name} has no supporting index`,
            `PostgreSQL does not index the child columns automatically. Parent updates/deletes can scan ${table.name}; add an index beginning with (${fk.columns.join(', ')}).`);
        }
      }
      for (let i = 0; i < table.indexes.length; i++) for (let j = 0; j < table.indexes.length; j++) {
        if (i === j) continue;
        const a = table.indexes[i], b = table.indexes[j];
        if (a.name === 'PRIMARY' || b.name === 'PRIMARY' || a.unique) continue;
        if (a.columns.length < b.columns.length && a.columns.every((c, k) => norm(c) === norm(b.columns[k]))) {
          this.finding(anchor, 'yellow', `Index ${table.name}.${a.name} is a redundant prefix of ${b.name}`,
            `${a.name}(${a.columns.join(', ')}) is covered left-to-right by ${b.name}(${b.columns.join(', ')}); keeping both adds write and storage cost.`);
        }
      }
    }
    for (const key of this.recreated) {
      this.finding(anchor, 'red', `DROP/CREATE rewrite of ${key} destroys the original data`,
        'The migration drops and later recreates the same table. The final definition may look valid, but rows, grants, triggers and other dependent objects are not restored by CREATE TABLE.');
    }
    for (const [key, count] of this.rebuilds) if (key && count > 1) {
      this.finding(anchor, 'orange', `Migration rewrites ${key} ${count} times`,
        'Several statements each require a table rebuild. Combining compatible ALTER actions or staging a single rebuild can avoid repeated full-table work and lock windows.');
    }
  }

  private sections(tables: ReviewTable[]): ReportSection[] {
    const plan = mdTable(['#', 'Line', 'Statement', 'Target', 'Post-change / limitation'], this.statements.map(s => [
      String(s.number), String(s.line), s.kind, s.table ?? '—', s.summary + (s.cost ? ` · ${s.cost.algorithm}/${s.cost.lock}${s.cost.rebuild ? ' · rebuild' : ''}` : ''),
    ]));
    const shape = tables.length ? tables.map(table => {
      const header = `### ${table.name}${table.complete ? '' : ' — PARTIAL / before-state unknown'}`;
      const cols = mdTable(['Column', 'Type', 'NULL', 'Default'], table.columns.map(c => [c.name, c.type, c.nullable ? 'yes' : 'no', c.hasDefault ? 'yes' : 'no']));
      const indexes = table.indexes.length ? `\nIndexes: ${table.indexes.map(i => `${i.name}(${i.columns.join(', ')})${i.unique ? ' unique' : ''}`).join('; ')}` : '';
      const fks = table.foreignKeys.length ? `\nForeign keys: ${table.foreignKeys.map(f => `${f.name}: (${f.columns.join(', ')}) → ${f.refTable}(${f.refColumns.join(', ')}) ON DELETE ${f.onDelete}`).join('; ')}` : '';
      return `${header}\n\n${cols}${indexes}${fks}`;
    }).join('\n\n') : '_No tables remain in the modeled schema._';
    return [
      { title: 'Statement plan', md: plan + '\nUnsupported/uncertain statements are never treated as passed or safe.' },
      { title: 'Post-migration table model', md: shape + '\n\nThis is a table/column/index/FK model only. Views, triggers, routines, grants, partitions, data contents and server concurrency are not simulated.' },
    ];
  }
}

export function reviewChanges(options: ChangeReviewOptions): ChangeReviewResult {
  return new Reviewer(options).run();
}
