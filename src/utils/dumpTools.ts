/**
 * Command builders for the dump/restore panel.
 *
 * Each tool is described declaratively (options + target kind) and builds an
 * argv. `{{host}}` / `{{port}}` placeholders are resolved by the backend at
 * spawn time (they may point at an SSH tunnel opened for the run). The
 * password is never part of argv — the backend passes it via MYSQL_PWD /
 * PGPASSWORD.
 */
import type { Engine } from '../types';

export type Mode = 'dump' | 'restore';
export type TargetKind = 'save-file' | 'open-file' | 'directory' | 'new-directory';

export interface ToolOption {
  key: string;
  label: string;
  kind: 'flag' | 'text' | 'number';
  def: boolean | string | number;
  hint?: string;
  /** Only offered when the detected version line matches (unused = always) */
  placeholder?: string;
}

export type OptionValues = Record<string, boolean | string | number>;

export interface BuildInput {
  user: string;
  database: string;
  /** Optional space/comma-separated table list (tools that support it) */
  tables: string[];
  target: string;
  options: OptionValues;
  extraArgs: string;
}

export interface BuiltCommand {
  args: string[];
  /** File streamed into the process's stdin (mysql/psql plain-SQL restore) */
  stdinFile?: string;
}

export interface ToolSpec {
  id: string;
  engine: Engine;
  mode: Mode;
  label: string;
  targetLabel: string;
  targetKind: TargetKind;
  /** Default filename suggested in the save dialog */
  targetDefault?: string;
  supportsTables: boolean;
  options: ToolOption[];
  build(i: BuildInput): BuiltCommand;
}

/**
 * Split an "extra args" free-text field on whitespace, shell-style: quotes
 * group anywhere in a token (--where="id > 10" is ONE argument), quote chars
 * themselves are stripped, unterminated quotes run to end of string.
 */
export function splitExtraArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const close = s.indexOf(c, i + 1);
      const end = close === -1 ? s.length : close;
      cur += s.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (/\s/.test(c)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
      i++;
    } else {
      cur += c;
      inToken = true;
      i++;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

export function splitTables(s: string): string[] {
  return s.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
}

function baseMysql(i: BuildInput): string[] {
  return ['--host', '{{host}}', '--port', '{{port}}', '--user', i.user];
}
function basePg(i: BuildInput): string[] {
  return ['--host', '{{host}}', '--port', '{{port}}', '--username', i.user, '--no-password'];
}

export const TOOL_SPECS: ToolSpec[] = [
  // ── MySQL dump ──────────────────────────────────────────────────────────
  {
    id: 'mysqldump',
    engine: 'mysql',
    mode: 'dump',
    label: 'mysqldump — single .sql file',
    targetLabel: 'Output file',
    targetKind: 'save-file',
    targetDefault: 'dump.sql',
    supportsTables: true,
    options: [
      { key: 'singleTx', label: '--single-transaction (consistent InnoDB snapshot)', kind: 'flag', def: true },
      { key: 'routines', label: '--routines --triggers --events', kind: 'flag', def: true },
      { key: 'noData',   label: '--no-data (schema only)', kind: 'flag', def: false },
      { key: 'quick',    label: '--quick (row-at-a-time streaming)', kind: 'flag', def: true },
    ],
    build(i) {
      const a = baseMysql(i);
      if (i.options.singleTx) a.push('--single-transaction');
      if (i.options.routines) a.push('--routines', '--triggers', '--events');
      if (i.options.noData) a.push('--no-data');
      if (i.options.quick) a.push('--quick');
      a.push(...splitExtraArgs(i.extraArgs));
      a.push('--result-file', i.target, i.database, ...i.tables);
      return { args: a };
    },
  },
  {
    id: 'mydumper',
    engine: 'mysql',
    mode: 'dump',
    label: 'mydumper — parallel, per-table files',
    targetLabel: 'Output directory',
    targetKind: 'new-directory',
    supportsTables: false,
    options: [
      { key: 'threads',  label: 'Threads', kind: 'number', def: 4 },
      { key: 'rows',     label: 'Chunk rows (--rows, 0 = off)', kind: 'number', def: 0,
        hint: 'split big tables into chunks for parallel dump' },
      { key: 'compress', label: '--compress output files', kind: 'flag', def: true },
      { key: 'trxOnly',  label: '--trx-consistency-only (InnoDB-only, minimal locking)', kind: 'flag', def: false,
        hint: 'flag name drifts across mydumper versions — check the preview against your --version' },
      { key: 'regex',    label: 'Table regex (--regex)', kind: 'text', def: '',
        placeholder: '^mydb\\.(orders|users)$' },
    ],
    build(i) {
      const a = baseMysql(i);
      a.push('--outputdir', i.target, '--threads', String(i.options.threads || 4), '--verbose', '3');
      if (i.database) a.push('--database', i.database);
      if (Number(i.options.rows) > 0) a.push('--rows', String(i.options.rows));
      if (i.options.compress) a.push('--compress');
      if (i.options.trxOnly) a.push('--trx-consistency-only');
      if (i.options.regex) a.push('--regex', String(i.options.regex));
      a.push(...splitExtraArgs(i.extraArgs));
      return { args: a };
    },
  },
  // ── MySQL restore ───────────────────────────────────────────────────────
  {
    id: 'mysql',
    engine: 'mysql',
    mode: 'restore',
    label: 'mysql — load a .sql file',
    targetLabel: 'Dump file (.sql)',
    targetKind: 'open-file',
    supportsTables: false,
    options: [
      { key: 'force', label: '--force (continue past SQL errors)', kind: 'flag', def: false },
    ],
    build(i) {
      const a = baseMysql(i);
      if (i.options.force) a.push('--force');
      a.push(...splitExtraArgs(i.extraArgs));
      if (i.database) a.push(i.database);
      return { args: a, stdinFile: i.target };
    },
  },
  {
    id: 'myloader',
    engine: 'mysql',
    mode: 'restore',
    label: 'myloader — parallel restore of a mydumper directory',
    targetLabel: 'Dump directory',
    targetKind: 'directory',
    supportsTables: false,
    options: [
      { key: 'threads',   label: 'Threads', kind: 'number', def: 4 },
      { key: 'overwrite', label: '--overwrite-tables (DROP + recreate)', kind: 'flag', def: false },
      { key: 'newDb',     label: 'Restore into database (--database, blank = original)', kind: 'text', def: '' },
    ],
    build(i) {
      const a = baseMysql(i);
      a.push('--directory', i.target, '--threads', String(i.options.threads || 4), '--verbose', '3');
      if (i.options.overwrite) a.push('--overwrite-tables');
      if (i.options.newDb) a.push('--database', String(i.options.newDb));
      a.push(...splitExtraArgs(i.extraArgs));
      return { args: a };
    },
  },
  // ── PostgreSQL dump ─────────────────────────────────────────────────────
  {
    id: 'pg_dump',
    engine: 'postgres',
    mode: 'dump',
    label: 'pg_dump — custom or plain format',
    targetLabel: 'Output file',
    targetKind: 'save-file',
    targetDefault: 'dump.pgdump',
    supportsTables: true,
    options: [
      { key: 'format',     label: 'Format (custom | plain | directory)', kind: 'text', def: 'custom' },
      { key: 'jobs',       label: 'Jobs (directory format only)', kind: 'number', def: 4 },
      { key: 'schemaOnly', label: '--schema-only', kind: 'flag', def: false },
      { key: 'noOwner',    label: '--no-owner --no-privileges', kind: 'flag', def: true },
    ],
    build(i) {
      const a = basePg(i);
      const fmt = String(i.options.format || 'custom');
      a.push('--format', fmt);
      if (fmt === 'directory') a.push('--jobs', String(i.options.jobs || 4));
      if (i.options.schemaOnly) a.push('--schema-only');
      if (i.options.noOwner) a.push('--no-owner', '--no-privileges');
      for (const t of i.tables) a.push('--table', t);
      a.push(...splitExtraArgs(i.extraArgs));
      a.push('--file', i.target, i.database);
      return { args: a };
    },
  },
  // ── PostgreSQL restore ──────────────────────────────────────────────────
  {
    id: 'pg_restore',
    engine: 'postgres',
    mode: 'restore',
    label: 'pg_restore — custom/directory-format archive',
    targetLabel: 'Archive file or directory',
    targetKind: 'open-file',
    supportsTables: false,
    options: [
      { key: 'jobs',  label: 'Jobs (parallel restore)', kind: 'number', def: 4 },
      { key: 'clean', label: '--clean --if-exists (drop objects first)', kind: 'flag', def: false },
      { key: 'noOwner', label: '--no-owner', kind: 'flag', def: true },
    ],
    build(i) {
      const a = basePg(i);
      a.push('--dbname', i.database, '--jobs', String(i.options.jobs || 4));
      if (i.options.clean) a.push('--clean', '--if-exists');
      if (i.options.noOwner) a.push('--no-owner');
      a.push(...splitExtraArgs(i.extraArgs));
      a.push(i.target);
      return { args: a };
    },
  },
  {
    id: 'psql',
    engine: 'postgres',
    mode: 'restore',
    label: 'psql — load a plain .sql file',
    targetLabel: 'Dump file (.sql)',
    targetKind: 'open-file',
    supportsTables: false,
    options: [
      { key: 'stopOnError', label: 'ON_ERROR_STOP=1 (abort on first error)', kind: 'flag', def: true },
    ],
    build(i) {
      const a = basePg(i);
      a.push('--dbname', i.database);
      if (i.options.stopOnError) a.push('-v', 'ON_ERROR_STOP=1');
      a.push(...splitExtraArgs(i.extraArgs));
      a.push('--file', i.target);
      return { args: a };
    },
  },
];

export function specsFor(engine: Engine, mode: Mode): ToolSpec[] {
  return TOOL_SPECS.filter(s => s.engine === engine && s.mode === mode);
}

export function defaultOptions(spec: ToolSpec): OptionValues {
  const v: OptionValues = {};
  for (const o of spec.options) v[o.key] = o.def;
  return v;
}

/** Shell-style display of the command for the preview pane. */
export function previewCommand(tool: string, built: BuiltCommand): string {
  const quote = (a: string) => (/[\s"'\\$`*?[\]{}()<>|&;#~]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);
  let s = [tool, ...built.args.map(quote)].join(' ');
  if (built.stdinFile) s += ` < ${quote(built.stdinFile)}`;
  return s;
}
