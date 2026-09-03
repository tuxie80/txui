/**
 * TxShell pipeline stages — the part that makes the pipe worth having.
 *
 * FluidShell's pipes carry text: `SELECT … | grep foo` flattens a result set
 * into characters and every downstream step re-parses them. A column holding a
 * comma, a newline or a NULL is where that breaks, and it breaks *silently* —
 * you get a wrong file rather than an error.
 *
 * Here a pipe carries `{columns, rows}` with values intact, so
 * `where total > 100` compares numbers because the column holds numbers. The
 * comparison is resolved from the data, not from the rendered string.
 *
 * Pure and dependency-free — driven by `node --test`. The stages never touch a
 * database or the filesystem; sinks that need IO return a *description* of the
 * write for the caller to perform.
 */
import type { ColumnInfo, QueryResult } from '../types';
import type { PipelineStage } from './txShell.ts';
import { parseWhere, findVerb } from './txShellGrammar.ts';
import type { WhereOp } from './txShellGrammar.ts';

export interface SinkAction {
  kind: 'save' | 'append' | 'to' | 'chart' | 'grid' | 'insert';
  /** For insert — the destination table. */
  table?: string;
  /** For insert — a different connection to write to, without the `@`. */
  destination?: string;
  /** For save/append. */
  file?: string;
  /** For save/append/to — the resolved format. */
  format?: ExportFormat;
}

export interface PipelineResult {
  result: QueryResult;
  sink?: SinkAction;
}

export type PipelineOutcome = PipelineResult | { error: string };

export const EXPORT_FORMATS = ['csv', 'tsv', 'json', 'md', 'ascii', 'inserts',
  'html', 'xml', 'latex', 'xlsx'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

/** Extension → format, for `save report.csv`. */
const BY_EXT: Record<string, ExportFormat> = {
  csv: 'csv', tsv: 'tsv', txt: 'tsv', json: 'json',
  md: 'md', markdown: 'md', sql: 'inserts', xlsx: 'xlsx',
  html: 'html', htm: 'html', xml: 'xml', tex: 'latex',
};

/**
 * Work out the format a filename implies.
 *
 * This is why there is no `>` redirect: `save report.csv` carries the format in
 * the name, so the shell needs no `csv2json`-style family of converters and `>`
 * stays a comparison operator.
 */
export function formatForFile(file: string): ExportFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.trim())?.[1]?.toLowerCase();
  return ext ? (BY_EXT[ext] ?? null) : null;
}

// ── typed values ─────────────────────────────────────────────────────────────

/**
 * Coerce a right-hand side against the column it is being compared with.
 *
 * The whole point of typed pipes. `where total > 100` on a numeric column
 * compares 100 as a number; on a text column it compares "100" as a string,
 * where "9" would otherwise sort above it. The column's *data* decides, with
 * its declared type as the fallback for an all-NULL column.
 */
export function coerce(raw: string, col: ColumnInfo | undefined, sample: unknown): unknown {
  const t = raw.trim();
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;

  const unquoted = (t.length >= 2 && ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"'))))
    ? t.slice(1, -1)
    : null;
  // An explicitly quoted value is a string, whatever the column is.
  if (unquoted !== null) return unquoted;

  const numericColumn = typeof sample === 'number'
    || (sample === undefined && /int|numeric|decimal|float|double|real|serial|money/i
      .test(col?.type_name ?? ''));
  if (numericColumn) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  // A bare number against a text column stays text — comparing "9" with "100"
  // as numbers would silently disagree with what the database would do.
  if (!numericColumn && /^-?\d+(\.\d+)?$/.test(t) && typeof sample === 'string') return t;

  const n = Number(t);
  return Number.isFinite(n) && t !== '' ? n : t;
}

/** First non-null value in a column, to learn what it actually holds. */
function sampleOf(result: QueryResult, idx: number): unknown {
  for (const row of result.rows) {
    const v = row[idx];
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
}

/**
 * Compare two values the way the data implies.
 *
 * NULL sorts and compares as "less than everything", matching what a grid
 * shows and what most people expect; SQL's three-valued logic would make
 * `where x != 5` silently drop NULL rows, which in a shell filter is a
 * surprise rather than a feature.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Does one row satisfy the comparison? */
export function matches(value: unknown, op: WhereOp, target: unknown): boolean {
  switch (op) {
    case '=':  return compareValues(value, target) === 0;
    case '!=':
    case '<>': return compareValues(value, target) !== 0;
    case '<':  return compareValues(value, target) < 0;
    case '<=': return compareValues(value, target) <= 0;
    case '>':  return compareValues(value, target) > 0;
    case '>=': return compareValues(value, target) >= 0;
    case 'is': return target === null
      ? (value === null || value === undefined)
      : compareValues(value, target) === 0;
    case 'like':
    case 'ilike': {
      if (value === null || value === undefined) return false;
      const re = likeToRegex(String(target), op === 'ilike');
      return re.test(String(value));
    }
    case 'in': {
      const list = String(target).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      return list.some(x => String(value) === x);
    }
    default: return false;
  }
}

/** SQL LIKE → RegExp. `%` is any run, `_` is one character. */
export function likeToRegex(pattern: string, insensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, insensitive ? 'i' : '');
}

// ── column lookup ────────────────────────────────────────────────────────────

/**
 * Find a column by name, or by 1-based position.
 *
 * Position matters because an aggregate arrives as `count(*)` or `?column?` —
 * names you cannot type comfortably. `sort 2 desc` is the escape hatch.
 */
export function columnIndex(result: QueryResult, ref: string): number {
  const want = ref.trim().toLowerCase();
  const byName = result.columns.findIndex(c => c.name.toLowerCase() === want);
  if (byName >= 0) return byName;
  if (/^\d+$/.test(want)) {
    const pos = Number(want) - 1;
    if (pos >= 0 && pos < result.columns.length) return pos;
  }
  return -1;
}

function unknownColumn(result: QueryResult, ref: string): string {
  const names = result.columns.map(c => c.name);
  return `No column \`${ref}\` — this result has: ${names.join(', ') || '(none)'}`;
}

const empty = (columns: ColumnInfo[], rows: unknown[][]): QueryResult => ({
  columns, rows, rows_affected: null, execution_ms: 0, fetch_ms: 0, warnings: [],
});

// ── stages ───────────────────────────────────────────────────────────────────

/** Apply one stage. Errors are already user-facing. */
export function applyStage(result: QueryResult, stage: PipelineStage): PipelineOutcome {
  const { name, args } = stage;

  switch (name) {
    case 'where': {
      const parsed = parseWhere(args);
      if ('error' in parsed) return { error: parsed.error };
      const idx = columnIndex(result, parsed.column);
      if (idx < 0) return { error: unknownColumn(result, parsed.column) };
      const target = coerce(parsed.value, result.columns[idx], sampleOf(result, idx));
      return {
        result: empty(result.columns,
          result.rows.filter(r => matches(r[idx], parsed.op, target))),
      };
    }

    case 'select': {
      const idxs: number[] = [];
      for (const a of args) {
        const i = columnIndex(result, a);
        if (i < 0) return { error: unknownColumn(result, a) };
        idxs.push(i);
      }
      return {
        result: empty(idxs.map(i => result.columns[i]),
          result.rows.map(r => idxs.map(i => r[i]))),
      };
    }

    case 'sort': {
      const idx = columnIndex(result, args[0]);
      if (idx < 0) return { error: unknownColumn(result, args[0]) };
      const dir = (args[1] ?? 'asc').toLowerCase();
      if (!['asc', 'desc'].includes(dir)) {
        return { error: `\`sort\` direction must be asc or desc, not \`${args[1]}\`` };
      }
      const sign = dir === 'desc' ? -1 : 1;
      // Copied before sorting: a stage must never mutate its input, or a
      // re-render of an earlier transcript entry would show different rows.
      const rows = [...result.rows].sort((a, b) => sign * compareValues(a[idx], b[idx]));
      return { result: empty(result.columns, rows) };
    }

    case 'head':
    case 'tail': {
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `\`${name}\` needs a whole number — got \`${args[0]}\`` };
      }
      const rows = name === 'head' ? result.rows.slice(0, n) : result.rows.slice(-n || undefined);
      return { result: empty(result.columns, n === 0 ? [] : rows) };
    }

    case 'count':
      return {
        result: empty([{ name: 'count', type_name: 'bigint', nullable: false }],
          [[result.rows.length]]),
      };

    case 'distinct': {
      const idxs = args.length
        ? args.map(a => columnIndex(result, a))
        : result.columns.map((_, i) => i);
      const bad = args.findIndex((_, i) => idxs[i] < 0);
      if (bad >= 0) return { error: unknownColumn(result, args[bad]) };
      const seen = new Set<string>();
      const rows: unknown[][] = [];
      for (const r of result.rows) {
        const key = JSON.stringify(idxs.map(i => r[i]));
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(args.length ? idxs.map(i => r[i]) : r);
      }
      return {
        result: empty(args.length ? idxs.map(i => result.columns[i]) : result.columns, rows),
      };
    }

    case 'stats': {
      const targets = args.length
        ? [columnIndex(result, args[0])]
        : result.columns.map((_, i) => i).filter(i => typeof sampleOf(result, i) === 'number');
      if (args.length && targets[0] < 0) return { error: unknownColumn(result, args[0]) };
      if (targets.length === 0) {
        return { error: 'No numeric column to summarise — name one, e.g. `stats total`' };
      }
      const cols: ColumnInfo[] = [
        { name: 'column', type_name: 'text', nullable: false },
        { name: 'count', type_name: 'bigint', nullable: false },
        { name: 'nulls', type_name: 'bigint', nullable: false },
        { name: 'sum', type_name: 'numeric', nullable: true },
        { name: 'avg', type_name: 'numeric', nullable: true },
        { name: 'min', type_name: 'numeric', nullable: true },
        { name: 'max', type_name: 'numeric', nullable: true },
      ];
      const rows = targets.map(i => {
        const vals = result.rows.map(r => r[i]);
        const nums = vals.filter((v): v is number => typeof v === 'number');
        const nulls = vals.filter(v => v === null || v === undefined).length;
        const sum = nums.reduce((s, v) => s + v, 0);
        return [
          result.columns[i].name,
          vals.length,
          nulls,
          nums.length ? sum : null,
          nums.length ? sum / nums.length : null,
          nums.length ? Math.min(...nums) : null,
          nums.length ? Math.max(...nums) : null,
        ];
      });
      return { result: empty(cols, rows) };
    }

    // ── sinks ──
    case 'save':
    case 'append': {
      const file = args[0];
      const format = formatForFile(file);
      if (!format) {
        return {
          error: `Cannot tell the format of \`${file}\` — end it with `
            + `${EXPORT_FORMATS.map(f => `.${f}`).join(' ')}`,
        };
      }
      return { result, sink: { kind: name, file, format } };
    }

    case 'to': {
      const fmt = args[0].toLowerCase();
      if (!(EXPORT_FORMATS as readonly string[]).includes(fmt) || fmt === 'xlsx') {
        return {
          error: `\`to\` takes ${EXPORT_FORMATS.filter(f => f !== 'xlsx').join(' | ')}`
            + (fmt === 'xlsx' ? ' — xlsx is binary, use `save report.xlsx`' : ''),
        };
      }
      return { result, sink: { kind: 'to', format: fmt as ExportFormat } };
    }

    case 'insert': {
      if (args[0].toLowerCase() !== 'into') {
        return { error: 'Usage: `insert into <table> [@connection]`' };
      }
      const dest = args[2];
      if (dest !== undefined && !dest.startsWith('@')) {
        return {
          error: `A destination must be written \`@${dest}\` — the \`@\` is what `
            + 'distinguishes a connection from part of the table name.',
        };
      }
      return {
        result,
        sink: {
          kind: 'insert', table: args[1],
          destination: dest ? dest.slice(1) : undefined,
        },
      };
    }

    case 'chart':
      return { result, sink: { kind: 'chart' } };
    case 'grid':
      return { result, sink: { kind: 'grid' } };

    default:
      return { error: `\`${name}\` is not a pipeline verb` };
  }
}

/**
 * Run every stage in order.
 *
 * Stops at the first failure and reports which stage it was — "row 3 of your
 * pipeline" is the difference between fixing it and retyping it.
 */
export function runPipeline(result: QueryResult, stages: PipelineStage[]): PipelineOutcome {
  let cur = result;
  let sink: SinkAction | undefined;
  for (let i = 0; i < stages.length; i++) {
    const spec = findVerb(stages[i].name);
    if (!spec) return { error: `\`${stages[i].name}\` is not a pipeline verb` };
    const out = applyStage(cur, stages[i]);
    if ('error' in out) {
      return { error: `${out.error}   (stage ${i + 1}: \`${stages[i].raw}\`)` };
    }
    cur = out.result;
    if (out.sink) sink = out.sink;
  }
  return { result: cur, sink };
}

// ── CSV, for `from` ──────────────────────────────────────────────────────────

/**
 * Parse delimited text into a result set.
 *
 * Written rather than reached for because the failure mode matters: a naive
 * `split(',')` mangles any field containing a comma, a quote or a newline, and
 * does it silently. RFC 4180 quoting is handled — `""` inside a quoted field is
 * a literal quote, and a newline inside quotes does not end the record.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let any = false;

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; any = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; any = true; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; any = false;
      i++;
      continue;
    }
    field += ch; any = true; i++;
  }
  if (field || any || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * A delimited file as a result set, with values typed by inspection.
 *
 * Everything in a CSV is text on disk. Leaving it that way would make
 * `where total > 100` a string comparison — the exact bug typed pipes exist to
 * avoid — so a column whose every non-empty value parses as a number becomes
 * numeric. One non-numeric value anywhere keeps the whole column text, because
 * a half-typed column is worse than an honestly untyped one.
 */
export function delimitedToResult(text: string, delimiter = ','): QueryResult {
  const grid = parseDelimited(text, delimiter).filter(r => r.length > 1 || r[0] !== '');
  if (grid.length === 0) return empty([], []);
  const header = grid[0];
  const body = grid.slice(1);

  const numeric = header.map((_, c) => {
    let sawValue = false;
    for (const r of body) {
      const v = (r[c] ?? '').trim();
      if (v === '') continue;
      sawValue = true;
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return false;
    }
    return sawValue;
  });

  const columns: ColumnInfo[] = header.map((name, c) => ({
    name: name || `column${c + 1}`,
    type_name: numeric[c] ? 'numeric' : 'text',
    nullable: true,
  }));
  const rows = body.map(r => header.map((_, c) => {
    const v = r[c];
    if (v === undefined || v === '') return null;
    return numeric[c] ? Number(v) : v;
  }));
  return empty(columns, rows);
}

// ── fan-out ──────────────────────────────────────────────────────────────────

/**
 * Does a connection name match a `@pattern`?
 *
 * Glob rather than regex: `prod-*` is what a DBA reaches for, and a regex in
 * this position would make an accidental `.` match everything — on a command
 * that runs against every server it matched.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p === '*') return true;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

/**
 * Stack per-server results into one, with the server named in a new column.
 *
 * The reason fan-out is worth having: one result set you can pipe, rather than
 * fourteen you have to read separately.
 */
export function unionResults(
  parts: Array<{ name: string; result: QueryResult }>,
): QueryResult {
  const withRows = parts.filter(p => p.result.columns.length > 0);
  if (withRows.length === 0) return empty([], []);
  const base = withRows[0].result.columns;
  const columns: ColumnInfo[] = [
    { name: 'connection', type_name: 'text', nullable: false },
    ...base,
  ];
  const rows: unknown[][] = [];
  for (const p of withRows) {
    // A server whose shape differs is realigned by column NAME, not position —
    // two servers can legitimately return the same columns in a different
    // order, and stacking them positionally would silently mix the values.
    const map = base.map(c => p.result.columns.findIndex(
      x => x.name.toLowerCase() === c.name.toLowerCase()));
    for (const r of p.result.rows) {
      rows.push([p.name, ...map.map(i => (i >= 0 ? r[i] : null))]);
    }
  }
  return empty(columns, rows);
}
