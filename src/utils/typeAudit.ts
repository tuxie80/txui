/**
 * Data-type consistency audit across JOIN/WHERE column pairs.
 * Finds: signed↔unsigned int mismatches, cross-family comparisons (implicit
 * casts), collation/charset mismatches on string joins, width mismatches,
 * integer AUTO_INCREMENT ceiling proximity.
 */
import { blank, findAliases } from './sqlAlias.ts';
import type { Finding, Severity } from './sqlLint.ts';

// ── Query-side extraction ─────────────────────────────────────────────────────

export interface ColumnRef { table: string; column: string; raw: string }
export interface JoinPair { left: ColumnRef; right: ColumnRef }
export interface LiteralCmp { col: ColumnRef; literal: string; kind: 'number' | 'string' }

export interface QueryShape {
  tables: string[];          // resolved table names as written (maybe schema-qualified)
  joins: JoinPair[];
  literals: LiteralCmp[];
}

export function extractQueryShape(sql: string): QueryShape {
  const aliases = findAliases(sql);
  const b = blank(sql);
  const tables = [...new Set(aliases.values())];

  const resolve = (alias: string, column: string, raw: string): ColumnRef | null => {
    const table = aliases.get(alias.toLowerCase());
    return table ? { table, column: column.toLowerCase(), raw } : null;
  };

  const joins: JoinPair[] = [];
  const seen = new Set<string>();
  {
    const re = /([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*=\s*([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      const left = resolve(m[1], m[2], `${m[1]}.${m[2]}`);
      const right = resolve(m[3], m[4], `${m[3]}.${m[4]}`);
      if (!left || !right) continue;
      const key = [`${left.table}.${left.column}`, `${right.table}.${right.column}`].sort().join('=');
      if (seen.has(key)) continue;
      seen.add(key);
      joins.push({ left, right });
    }
  }

  // qualified column compared to a literal (implicit-cast check)
  const literals: LiteralCmp[] = [];
  {
    const re = /([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*(?:=|!=|<>|>=?|<=?|\bin\s*\()\s*('|-?\d)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b)) !== null) {
      const col = resolve(m[1], m[2], `${m[1]}.${m[2]}`);
      if (!col) continue;
      literals.push({ col, literal: m[3], kind: m[3] === "'" ? 'string' : 'number' });
    }
  }

  return { tables, joins, literals };
}

// ── Type model ────────────────────────────────────────────────────────────────

export interface ColumnType {
  raw: string;               // "int unsigned", "varchar(255)", "int4"
  family: 'int' | 'decimal' | 'float' | 'string' | 'date' | 'time' | 'datetime' | 'bool' | 'json' | 'binary' | 'enum' | 'other';
  bytes: number;             // int width in bytes (0 = n/a)
  unsigned: boolean;
  length: number | null;     // varchar/char length
  collation: string | null;
  nullable: boolean;
}

const INT_BYTES: Record<string, number> = {
  tinyint: 1, smallint: 2, mediumint: 3, int: 4, integer: 4, bigint: 8,
  int2: 2, int4: 4, int8: 8, serial: 4, bigserial: 8, smallserial: 2,
};

export function parseColumnType(raw: string, collation: string | null, nullable: boolean): ColumnType {
  const t = raw.trim().toLowerCase();
  const base = (/^[a-z0-9_ ]+?(?=\(|$| unsigned| signed)/.exec(t)?.[0] ?? t).trim();
  const unsigned = /\bunsigned\b/.test(t);
  const lenMatch = /\((\d+)/.exec(t);
  const length = lenMatch ? Number(lenMatch[1]) : null;

  let family: ColumnType['family'] = 'other';
  let bytes = 0;
  if (base in INT_BYTES) { family = 'int'; bytes = INT_BYTES[base]; }
  else if (/^(decimal|numeric|dec|money)/.test(base)) family = 'decimal';
  else if (/^(float|double|real|float4|float8)/.test(base)) family = 'float';
  else if (/^(varchar|char|text|tinytext|mediumtext|longtext|character|bpchar|name|citext)/.test(base)) family = 'string';
  else if (/^(datetime|timestamp)/.test(base)) family = 'datetime';
  else if (base === 'date') family = 'date';
  else if (/^time/.test(base)) family = 'time';
  else if (/^(bool|boolean)/.test(base)) family = 'bool';
  else if (/^(json|jsonb)/.test(base)) family = 'json';
  else if (/^(binary|varbinary|blob|tinyblob|mediumblob|longblob|bytea)/.test(base)) family = 'binary';
  else if (/^enum|^set/.test(base)) family = 'enum';

  // tinyint(1) is boolean by convention
  if (base === 'tinyint' && length === 1) family = 'bool';

  return { raw: raw.trim(), family, bytes, unsigned, length, collation, nullable };
}

export function intMax(t: ColumnType): number | null {
  if (t.family !== 'int' || t.bytes === 0) return null;
  const bits = t.bytes * 8 - (t.unsigned ? 0 : 1);
  return Math.pow(2, bits) - 1;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export type ColumnMeta = Map<string, Map<string, ColumnType>>; // tableKey → column → type

function lookup(meta: ColumnMeta, ref: ColumnRef): ColumnType | null {
  const direct = meta.get(ref.table.toLowerCase());
  if (direct) return direct.get(ref.column) ?? null;
  // unqualified table stored qualified (or vice versa)
  const bare = ref.table.split('.').pop()!.toLowerCase();
  for (const [key, cols] of meta) {
    if (key === bare || key.endsWith(`.${bare}`)) {
      const hit = cols.get(ref.column);
      if (hit) return hit;
    }
  }
  return null;
}

export function auditJoinTypes(shape: QueryShape, meta: ColumnMeta): Finding[] {
  const out: Finding[] = [];
  let n = 1;
  const push = (severity: Severity, title: string, detail: string) =>
    out.push({ id: `T${n++}`, severity, title, detail });

  for (const { left, right } of shape.joins) {
    const lt = lookup(meta, left);
    const rt = lookup(meta, right);
    if (!lt || !rt) continue;
    const pair = `${left.table}.${left.column} (${lt.raw}) ↔ ${right.table}.${right.column} (${rt.raw})`;

    if (lt.family === 'int' && rt.family === 'int') {
      if (lt.unsigned !== rt.unsigned) {
        push('orange', `Signed ↔ unsigned join: ${pair}`,
          'Equal-width ints usually still use the index, but values above the signed ceiling (2,147,483,647 for int) silently fail to match. Align the FK type with the referenced PK.');
      }
      if (lt.bytes !== rt.bytes) {
        push('yellow', `Integer width mismatch: ${pair}`,
          'Different int widths on a join key — verify the narrow side cannot overflow, and that the optimizer keeps index access (check SHOW WARNINGS for cast()).');
      }
    } else if (lt.family !== rt.family) {
      const families = `${lt.family} vs ${rt.family}`;
      if ((lt.family === 'string' && rt.family === 'int') || (lt.family === 'int' && rt.family === 'string')) {
        push('red', `Cross-family join (${families}): ${pair}`,
          'String↔number comparison forces an implicit cast; MySQL casts the STRING side per row and cannot use its index. Fix the schema or cast explicitly on the non-indexed side.');
      } else if ((lt.family === 'decimal' && rt.family === 'int') || (lt.family === 'int' && rt.family === 'decimal')) {
        push('yellow', `int ↔ decimal join: ${pair}`,
          'Works, but the same business quantity in different types invites rounding surprises in arithmetic. Schema smell.');
      } else if (lt.family === 'datetime' || rt.family === 'datetime' || lt.family === 'date' || rt.family === 'date') {
        push('orange', `Temporal ↔ ${families} join: ${pair}`,
          'Implicit temporal conversion on a join key — verify formats and index usage.');
      } else {
        push('orange', `Cross-family join (${families}): ${pair}`,
          'Different type families on a join key cause implicit casts; verify index access in EXPLAIN.');
      }
    } else if (lt.family === 'string') {
      if (lt.collation && rt.collation && lt.collation !== rt.collation) {
        push('red', `Collation mismatch on string join: ${pair}`,
          `${lt.collation} vs ${rt.collation} — the index on one side is unusable; MySQL converts per row. Align collations.`);
      } else if (lt.length !== null && rt.length !== null && lt.length !== rt.length) {
        push('info', `String length mismatch: ${pair}`,
          'Harmless for equality, but a modeling smell — and a wide join key costs per-row comparison bytes. Prefer joining on an id.');
      }
      if ((lt.length ?? 0) > 50 || (rt.length ?? 0) > 50) {
        push('yellow', `Wide string join key: ${pair}`,
          'Long string keys make every index comparison expensive. If this derives an id, store the id instead.');
      }
    }
  }

  // literal comparisons — implicit casts against the column
  for (const { col, kind } of shape.literals) {
    const t = lookup(meta, col);
    if (!t) continue;
    if (kind === 'number' && t.family === 'string') {
      push('red', `Numeric literal compared to string column ${col.raw} (${t.raw})`,
        "MySQL casts the COLUMN to a number per row — the index is dead. Quote the literal ('123') or fix the column type.");
    }
    if (kind === 'string' && t.family === 'int') {
      push('yellow', `String literal compared to int column ${col.raw} (${t.raw})`,
        'The constant is cast once, index still used — but it hides type confusion. Use a bare number.');
    }
  }

  return out;
}

/** AUTO_INCREMENT ceiling proximity per table. */
export function auditCeilings(
  rows: { table: string; autoInc: number | null; pkType: ColumnType | null }[],
): Finding[] {
  const out: Finding[] = [];
  let n = 1;
  for (const { table, autoInc, pkType } of rows) {
    if (!autoInc || !pkType) continue;
    const max = intMax(pkType);
    if (!max) continue;
    const pct = (autoInc / max) * 100;
    if (pct < 20) continue;
    const severity: Severity = pct >= 90 ? 'red' : pct >= 60 ? 'orange' : 'yellow';
    out.push({
      id: `A${n++}`,
      severity,
      title: `${table}: AUTO_INCREMENT at ${pct.toFixed(0)}% of ${pkType.raw} ceiling`,
      detail: `${autoInc.toLocaleString()} of ${max.toLocaleString()}. Plan the ${pkType.unsigned ? 'bigint' : 'unsigned/bigint'} migration before it hits the wall — ALTERs on large tables take maintenance windows.`,
    });
  }
  return out;
}

/**
 * The PostgreSQL twin of {@link auditCeilings}: how far the sequence feeding
 * an identity/serial column has run against the COLUMN's integer range. PG
 * sequences themselves are int8, so the ceiling that actually bites is the
 * column's — an `integer` identity column dies at 2,147,483,647 even though
 * its sequence could count for another nine quintillion. `lastValue` is NULL
 * when the account holds no SELECT on the sequence; unknown stays silent.
 */
export function auditPgCeilings(
  rows: { table: string; column: string; dataType: string; lastValue: number | null }[],
): Finding[] {
  const MAX: Record<string, number> = {
    smallint: 32767, int: 2147483647, integer: 2147483647,
    bigint: 9.223372036854776e18, // nearest double — percentage denominator only
  };
  const out: Finding[] = [];
  let n = 1;
  for (const { table, column, dataType, lastValue } of rows) {
    if (lastValue == null) continue;
    const max = MAX[dataType.toLowerCase()];
    if (!max) continue;
    const pct = (lastValue / max) * 100;
    if (pct < 20) continue;
    const severity: Severity = pct >= 90 ? 'red' : pct >= 60 ? 'orange' : 'yellow';
    out.push({
      id: `A${n++}`,
      severity,
      title: `${table}.${column}: sequence at ${pct.toFixed(0)}% of the ${dataType} ceiling`,
      detail: `${lastValue.toLocaleString()} handed out of ${max.toLocaleString()}. PostgreSQL has no unsigned escape hatch — plan the ALTER COLUMN … TYPE bigint rewrite (a full table rewrite on a large table) before the wall, not during it.`,
    });
  }
  return out;
}
