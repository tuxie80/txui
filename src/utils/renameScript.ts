/**
 * Rename refactoring — the server-side half.
 *
 * `renameRefactor.ts` renames text inside one editor buffer. This module does
 * the other half: renaming the actual TABLE or COLUMN on the server, which
 * breaks every view, routine, trigger and event whose definition still names
 * the old identifier. The output is NOT an in-place rewrite — it is a
 * migration script the user reviews in an editor buffer and runs through the
 * normal execute path (sqlguard, prod confirmations). Generating it is
 * read-only; this module never talks to a server.
 *
 * ## The one rule that keeps it safe
 *
 * Only `certain` occurrences (the same classification findUsages shows —
 * `classifyHits` is the shared implementation, so the panel and the rewriter
 * can never disagree) are rewritten. `likely` and `possible` occurrences are
 * left byte-for-byte alone and listed as review items — rewriting text on a
 * `likely` is how you corrupt someone's script. An object is dropped and
 * recreated only when it has at least one `certain` hit; a recreated
 * definition that still contains weaker hits is flagged, because if one of
 * those really was the renamed column the CREATE will fail loudly — which is
 * the point of reviewing the script before running it.
 *
 * ## Ordering
 *
 * Drop dependents → rename → recreate. The recreates name the NEW identifier,
 * so they cannot run before the rename; the drops must not run after a failed
 * recreate window has already opened. A delete-before-insert-style slip here
 * leaves the schema with no views and no rename. Compound bodies
 * (BEGIN … END) make the recreate section run under `DELIMITER //`, which the
 * editor's statement splitter honours mid-script, as does the mysql client.
 *
 * ## Dialect notes
 *
 * - **MySQL/MariaDB** stores view, routine, trigger and event definitions as
 *   TEXT. A rename does not touch them — they break. Foreign keys are the
 *   exception: InnoDB repoints FKs at the new table name on RENAME (and
 *   renames generated constraint names unless that collides), so constraint
 *   hits on a table rename are noted, not recreated. `RENAME COLUMN` exists
 *   in MySQL ≥ 8.0 and MariaDB ≥ 10.5 — older servers need CHANGE COLUMN with
 *   the full column definition, which this module deliberately does not
 *   synthesise (a warning is emitted instead).
 * - **PostgreSQL** stores views, matviews, constraints, indexes, defaults and
 *   trigger bindings as catalog references — all of them follow a rename
 *   automatically. Routine BODIES (`prosrc`) are raw text and are the one
 *   thing that breaks, so only routines are dropped and recreated.
 *
 * Pure: no React/Tauri imports — `node --test` covers it.
 */
import {
  classifyHits, type Confidence, type SourceKind, type UsageSource,
} from './findUsages.ts';
import { safeIdent, safePath } from './sqlIdent.ts';

export type RenameEngine = 'mysql' | 'postgres';

/** A corpus source, plus its full CREATE text when the caller fetched one. */
export interface RenameObject extends UsageSource {
  /**
   * The server's own full definition: SHOW CREATE VIEW/TRIGGER/EVENT/
   * PROCEDURE/FUNCTION output on MySQL, `pg_get_functiondef` on PostgreSQL.
   * Required before the object is dropped and recreated — without it the
   * object is listed as a review item instead, never dropped blind.
   */
  createSql?: string;
}

export interface BuildRenameInput {
  engine: RenameEngine;
  /** Schema the table lives in — qualifies the rename DDL. */
  schema: string;
  table: string;
  column?: string;
  newName: string;
  /** Corpus sources that had at least one hit, at any confidence. */
  objects: RenameObject[];
  /** Corpus size, for the header's "what was searched" note. */
  searched?: number;
  /** `SELECT VERSION()`, when the caller has it — gates RENAME COLUMN. */
  serverVersion?: string;
}

export interface ReviewItem {
  label: string;
  kind: SourceKind;
  line?: number;
  lineText?: string;
  confidence?: Exclude<Confidence, 'certain'>;
  message: string;
}

export interface RenameScript {
  script: string;
  /** The rename DDL alone (one statement). */
  rename: string;
  dropped: string[];
  recreated: string[];
  /** Objects the server updates itself — informational, no script lines. */
  autoUpdated: { label: string; why: string }[];
  /** Everything NOT touched — review by hand. */
  review: ReviewItem[];
  warnings: string[];
}

// ── small text helpers ───────────────────────────────────────────────────────

function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at; i++) if (text[i] === '\n') line++;
  return line;
}

function lineTextOf(text: string, at: number): string {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at);
  if (end === -1) end = text.length;
  return text.slice(start, end).replace(/\s+$/, '');
}

/** A valid new identifier name, or why not. Null means valid. */
export function invalidNewName(name: string, oldName: string): string | null {
  if (!name) return 'the new name is empty';
  if (name === oldName) return 'the new name is the old name';
  if (name.includes('.')) return 'dotted names are not supported — the object stays in its schema';
  if (/[\r\n]/.test(name)) return 'the new name must be a single line';
  return null;
}

// ── corpus label parsing ─────────────────────────────────────────────────────

export interface ParsedLabel {
  schema?: string;
  /** Bare object name (a view/trigger/routine name — what DROP needs). */
  name: string;
  routineType?: 'procedure' | 'function';
  /** PostgreSQL identity arguments, parens included: `(integer, text)`. */
  args?: string;
}

/**
 * The object name inside a corpus label. Labels are built by
 * `usageSources.ts`: `schema.name` for views and events,
 * `schema.name (procedure|function)` for MySQL routines,
 * `schema.name(identity args)` for PostgreSQL routines, and
 * `schema.name on table` for triggers (ownerTable makes that suffix exact).
 */
export function parseCorpusLabel(
  kind: SourceKind, label: string, ownerTable?: string,
): ParsedLabel | null {
  const dot = label.indexOf('.');
  if (dot <= 0) return null;
  const schema = label.slice(0, dot);
  let rest = label.slice(dot + 1);
  if (!rest) return null;

  if (kind === 'routine') {
    const my = /^(.*)\s+\((procedure|function)\)$/.exec(rest);
    if (my) {
      return { schema, name: my[1], routineType: my[2] as 'procedure' | 'function' };
    }
    // PostgreSQL: name(args) — the args are exactly what
    // pg_get_function_identity_arguments produced, which DROP FUNCTION accepts.
    const open = rest.indexOf('(');
    if (open > 0 && rest.endsWith(')')) {
      return { schema, name: rest.slice(0, open), args: rest.slice(open) };
    }
    return { schema, name: rest };
  }

  if (kind === 'trigger') {
    if (ownerTable && rest.endsWith(` on ${ownerTable}`)) {
      rest = rest.slice(0, rest.length - ` on ${ownerTable}`.length);
    } else {
      const on = rest.lastIndexOf(' on ');
      if (on > 0) rest = rest.slice(0, on);
    }
    if (!rest) return null;
  }

  return { schema, name: rest };
}

// ── the rewriter: certain occurrences only ───────────────────────────────────

export interface RewriteReview {
  line: number;
  lineText: string;
  confidence: Exclude<Confidence, 'certain'>;
  note: string;
}

export interface RewriteResult {
  sql: string;
  rewritten: number;
  /** likely/possible occurrences — left byte-for-byte alone. */
  review: RewriteReview[];
}

/**
 * Rewrite the `certain` occurrences of the target in `sql` to `newName`,
 * preserving quoting: a quoted occurrence keeps its quote style (quote chars
 * inside the new name double up), a bare one is quoted only when the new name
 * would not resolve bare (safeIdent). `likely`/`possible` occurrences are
 * returned in `review`, never touched. Returns null for a name that cannot be
 * one identifier.
 */
export function rewriteCertain(
  sql: string,
  target: { table?: string; column?: string; newName: string },
  engine: RenameEngine,
  ownerTable?: string,
  opts?: { tableKeywords?: ReadonlySet<string>; qualifierIsTable?: boolean },
): RewriteResult | null {
  const name = target.newName.trim();
  if (invalidNewName(name, target.column ?? target.table ?? '')) return null;

  const hits = classifyHits(sql, target, engine, ownerTable, opts);
  const quote = engine === 'mysql' ? '`' : '"';
  const bareInsert = safeIdent(name, engine);

  const edits = hits.filter(h => h.confidence === 'certain').sort((a, b) => b.from - a.from);
  let out = sql;
  for (const h of edits) {
    if (sql[h.from - 1] === quote && sql[h.to] === quote) {
      out = out.slice(0, h.from - 1)
        + quote + name.split(quote).join(quote + quote) + quote
        + out.slice(h.to + 1);
    } else {
      out = out.slice(0, h.from) + bareInsert + out.slice(h.to);
    }
  }

  const review: RewriteReview[] = [];
  for (const h of hits) {
    if (h.confidence === 'certain') continue;
    review.push({
      line: lineOf(sql, h.from),
      lineText: lineTextOf(sql, h.from),
      confidence: h.confidence,
      note: h.note ?? 'unverified occurrence',
    });
  }
  review.sort((a, b) => a.line - b.line);
  return { sql: out, rewritten: edits.length, review };
}

// ── the DDL ──────────────────────────────────────────────────────────────────

/** The rename statement itself, one statement, engine dialect. */
export function renameDdl(
  engine: RenameEngine, schema: string, table: string, column: string | undefined, newName: string,
): string {
  const path = safePath([schema, table], engine);
  if (column) {
    return `ALTER TABLE ${path} RENAME COLUMN ${safeIdent(column, engine)} TO ${safeIdent(newName, engine)};`;
  }
  // MySQL resolves a bare new name against the DEFAULT database and errors
  // (1046) when the session has none — qualify it with the same schema (a
  // same-schema move is a rename). PostgreSQL forbids a qualified new name.
  return engine === 'mysql'
    ? `ALTER TABLE ${path} RENAME TO ${safePath([schema, newName], engine)};`
    : `ALTER TABLE ${path} RENAME TO ${safeIdent(newName, engine)};`;
}

/**
 * Does this server version have `ALTER TABLE … RENAME COLUMN`?
 * MySQL ≥ 8.0, MariaDB ≥ 10.5. UNKNOWN means supported — greying (or warning
 * about) a feature the user actually has is worse than the error it replaces.
 */
export function renameColumnSupported(serverVersion?: string): boolean {
  if (!serverVersion) return true;
  const m = /(\d+)\.(\d+)/.exec(serverVersion);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (/mariadb/i.test(serverVersion)) return major > 10 || (major === 10 && minor >= 5);
  return major >= 8;
}

/**
 * Which kinds this engine must drop and recreate around a rename — and which
 * therefore need their full CREATE text fetched before the script is built.
 */
export function needsCreateSql(engine: RenameEngine, kind: SourceKind): boolean {
  if (engine === 'postgres') return kind === 'routine';
  return kind === 'view' || kind === 'routine' || kind === 'trigger' || kind === 'event';
}

/** Why this kind follows the rename by itself, or null when it does not. */
function autoUpdateWhy(engine: RenameEngine, kind: SourceKind, isTableRename: boolean): string | null {
  if (engine === 'postgres') {
    switch (kind) {
      case 'view':
      case 'matview':
        return 'PostgreSQL stores the query as a catalog reference, not text — the definition follows the rename automatically';
      case 'trigger':
        return 'PostgreSQL binds triggers by catalog reference — the binding follows the rename automatically (the trigger FUNCTION is text and is handled separately)';
      case 'default':
      case 'constraint':
      case 'index':
        return 'PostgreSQL stores this as a catalog reference — it follows the rename automatically';
      default:
        return null;
    }
  }
  // MySQL: InnoDB repoints foreign keys at the new name on a TABLE rename.
  if (kind === 'constraint' && isTableRename) {
    return 'InnoDB repoints foreign keys at the new table name automatically (renaming generated constraint names unless that collides)';
  }
  return null;
}

/** The DROP half for one dependent object. Null when unparseable. */
export function dropStatement(
  engine: RenameEngine, kind: SourceKind, parsed: ParsedLabel,
): string | null {
  if (engine === 'postgres') {
    if (kind !== 'routine' || !parsed.args) return null;
    return `DROP FUNCTION ${safePath([parsed.schema!, parsed.name], 'postgres')}${parsed.args};`;
  }
  const path = safePath([parsed.schema!, parsed.name], 'mysql');
  switch (kind) {
    case 'view': return `DROP VIEW ${path};`;
    case 'trigger': return `DROP TRIGGER ${path};`;
    case 'event': return `DROP EVENT ${path};`;
    case 'routine':
      return `DROP ${parsed.routineType === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} ${path};`;
    default: return null;
  }
}

/** One trailing semicolon, no more. */
function asStatement(sql: string): string {
  return sql.replace(/[;\s]+$/, '') + ';';
}

/**
 * Schema-qualify the object's own name in a CREATE header.
 *
 * SHOW CREATE FUNCTION/PROCEDURE/TRIGGER/EVENT emit the name UNqualified, so
 * the recreated object lands in whatever the session's default database is —
 * and with no default at all the CREATE fails (error 1046), leaving the
 * dependent dropped. A generated script must not depend on the tab's schema
 * context. Already-qualified names (SHOW CREATE VIEW emits one,
 * pg_get_functiondef too) are left alone.
 */
export function qualifyObjectName(createSql: string, schema: string, engine: RenameEngine): string {
  const m = /^([\s\S]*?\b(?:view|function|procedure|trigger|event)\s+)([`"]?[A-Za-z_]\w*[`"]?)/i
    .exec(createSql);
  if (!m) return createSql;
  const after = createSql.slice(m.index + m[0].length);
  if (/^[`"]?\s*\./.test(after)) return createSql; // already schema-qualified
  const raw = m[2].replace(/^[`"]|[`"]$/g, '');
  return createSql.slice(0, m.index) + m[1] + safePath([schema, raw], engine)
    + createSql.slice(m.index + m[0].length);
}

// ── the script ───────────────────────────────────────────────────────────────

const KIND_WORD: Record<SourceKind, string> = {
  view: 'view', matview: 'materialized view', routine: 'routine',
  trigger: 'trigger', event: 'event', constraint: 'constraint',
  index: 'index', default: 'default / generated column',
  computed: 'computed column', buffer: 'open script', saved: 'saved SQL',
};

/**
 * Build the migration script. Returns null when `newName` cannot name the
 * object at all (invalidNewName). Everything else — a dependent whose full
 * definition is missing, a hit that is only `likely` — degrades to a review
 * item, never to a silent rewrite or a blind drop.
 */
export function buildRenameScript(input: BuildRenameInput): RenameScript | null {
  const { engine, schema, table, column } = input;
  const newName = input.newName.trim();
  const oldName = column ?? table;
  if (invalidNewName(newName, oldName)) return null;

  const isTableRename = !column;
  const what = column ? `${schema}.${table}.${column}` : `${schema}.${table}`;
  const rename = renameDdl(engine, schema, table, column, newName);
  const query = column ? { table, column } : { table };

  const warnings: string[] = [];
  if (column && engine === 'mysql' && !renameColumnSupported(input.serverVersion)) {
    warnings.push(
      `this server (${input.serverVersion}) has no RENAME COLUMN — it needs MySQL 8.0 / `
      + 'MariaDB 10.5. The statement below will fail there; use CHANGE COLUMN with the full '
      + 'column definition instead.',
    );
  }

  const dropped: string[] = [];
  const recreated: string[] = [];
  const autoUpdated: RenameScript['autoUpdated'] = [];
  const review: ReviewItem[] = [];
  const dropSql: string[] = [];
  const createSqls: string[] = [];

  for (const obj of input.objects) {
    const hits = classifyHits(obj.sql, query, engine, obj.ownerTable);
    const certain = hits.filter(h => h.confidence === 'certain');
    const weak = hits.filter(h => h.confidence !== 'certain');
    // Weak corpus hits are listed once, here — EXCEPT for objects that are
    // recreated (the rewrite of the full definition reports its own weak hits,
    // with better line numbers, and listing both says the same thing twice) or
    // auto-updated by the server (those references DO move — with the catalog,
    // not with this script — so "not touched" would be a lie).
    const listWeak = () => {
      // In a PostgreSQL catalog object the SERVER moves whatever it parsed as
      // a reference — the note for a weak hit there is "glance at it", not
      // "fix it by hand".
      const auto = engine === 'postgres' ? autoUpdateWhy(engine, obj.kind, isTableRename) : null;
      for (const h of weak) {
        review.push({
          label: obj.label, kind: obj.kind,
          line: lineOf(obj.sql, h.from), lineText: lineTextOf(obj.sql, h.from),
          confidence: h.confidence as Exclude<Confidence, 'certain'>,
          message: auto
            ? `not rewritten — ${h.note ?? 'unverified occurrence'}. The server moves parsed `
              + 'references by itself; just confirm this one.'
            : `not rewritten — ${h.note ?? 'unverified occurrence'}. Review by hand.`,
        });
      }
    };

    if (certain.length === 0) { listWeak(); continue; }

    if (needsCreateSql(engine, obj.kind)) {
      const parsed = parseCorpusLabel(obj.kind, obj.label, obj.ownerTable);
      const drop = parsed ? dropStatement(engine, obj.kind, parsed) : null;
      if (!obj.createSql || !drop) {
        review.push({
          label: obj.label, kind: obj.kind,
          message: `${certain.length} certain reference(s), but the full definition could not be `
            + 'fetched — NOT dropped. Recreate this object by hand with the new name.',
        });
        listWeak();
        continue;
      }
      // A trigger's CREATE text carries `ON <table>`; in that one text `on`
      // names the table. `LOCK TABLES <t>` can appear in a procedure. Only for
      // a table rename — neither names a column. And a table used as a
      // qualifier (`<table>.col`) must move with the rename, or the recreated
      // definition still points at the old name.
      const rw = rewriteCertain(obj.createSql, { ...query, newName }, engine, obj.ownerTable,
        isTableRename
          ? {
            qualifierIsTable: true,
            tableKeywords: obj.kind === 'trigger' ? new Set(['on', 'tables']) : new Set(['tables']),
          }
          : undefined);
      if (!rw || rw.rewritten === 0) {
        review.push({
          label: obj.label, kind: obj.kind,
          message: 'the reference found in the corpus text could not be located in the full '
            + 'definition — NOT dropped. Recreate this object by hand.',
        });
        listWeak();
        continue;
      }
      for (const r of rw.review) {
        review.push({
          label: obj.label, kind: obj.kind, line: r.line, lineText: r.lineText,
          confidence: r.confidence,
          message: `left unchanged in the recreated ${KIND_WORD[obj.kind]} — ${r.note}. If this `
            + `really was ${oldName}, the CREATE will fail; edit the script by hand.`,
        });
      }
      if (engine === 'mysql' && /DEFINER/i.test(obj.createSql)) {
        warnings.push(
          `${obj.label}: the recreated definition keeps its DEFINER clause — running it needs `
          + "that definer's privileges.",
        );
      }
      dropSql.push(drop);
      createSqls.push(asStatement(qualifyObjectName(rw.sql, obj.schema ?? schema, engine)));
      dropped.push(obj.label);
      recreated.push(obj.label);
      continue;
    }

    const why = autoUpdateWhy(engine, obj.kind, isTableRename);
    if (why) {
      autoUpdated.push({ label: obj.label, why });
      continue;
    }

    // Certain, but a kind this tool deliberately does not recreate.
    let message: string;
    if (obj.kind === 'buffer' || obj.kind === 'saved') {
      message = 'a script you can edit — rewrite it there (the editor rename, or by hand)';
    } else if (obj.kind === 'default' && engine === 'mysql' && column) {
      message = 'a default / generated-column expression names this column. The server may '
        + 'reject the rename while the generated column exists — drop and recreate it by hand.';
    } else if (obj.kind === 'constraint' && engine === 'mysql' && column) {
      message = 'a constraint references this column. MySQL 8 updates FK column references on '
        + 'RENAME COLUMN, but verify this one afterwards.';
    } else {
      message = `${certain.length} certain reference(s) in a ${KIND_WORD[obj.kind]} this tool `
        + 'does not recreate — handle by hand.';
    }
    review.push({ label: obj.label, kind: obj.kind, message });
  }

  // ── assemble ──
  const lines: string[] = [];
  lines.push(`-- Rename migration: ${what} → ${newName}`);
  lines.push('--');
  lines.push(`-- Generated by TxUI's rename refactoring (${engine}), from the find-usages corpus`
    + (input.searched !== undefined ? ` (${input.searched} definitions searched)` : '') + '.');
  lines.push('-- REVIEW THE WHOLE SCRIPT BEFORE RUNNING ANY OF IT. The order is load-bearing:');
  lines.push('-- dependents are dropped first, the rename runs second, the recreates last.');
  lines.push('-- Only occurrences classified CERTAIN were rewritten. Everything else is listed');
  lines.push('-- at the bottom under "not touched" — nothing there was rewritten.');
  if (engine === 'mysql' && !column) {
    lines.push('-- MySQL/MariaDB: views, routines, triggers and events store their definitions');
    lines.push('-- as text and are recreated below; foreign keys follow the rename by themselves.');
  }
  if (engine === 'postgres') {
    lines.push('-- PostgreSQL: views, matviews, constraints, indexes, defaults and trigger');
    lines.push('-- bindings follow the rename automatically; routine bodies are text and are');
    lines.push('-- recreated below.');
  }
  for (const w of warnings) lines.push(`-- WARNING: ${w}`);
  lines.push('');

  if (dropSql.length) {
    lines.push('-- ── 1. Drop dependents ─────────────────────────────────────────────');
    lines.push(...dropSql, '');
  }
  lines.push(`-- ── ${dropSql.length ? '2' : '1'}. The rename ───────────────────────────────────────────────────`);
  lines.push(rename, '');
  if (createSqls.length) {
    lines.push('-- ── 3. Recreate dependents ───────────────────────────────────────────');
    // A compound body (BEGIN … END) contains semicolons, so the recreate
    // section must run under a different terminator — the editor's splitter
    // honours the DELIMITER directive mid-script, as does the mysql client.
    const compound = engine === 'mysql'
      && createSqls.some(s => s.trim().replace(/;$/, '').includes(';'));
    if (compound) {
      lines.push('DELIMITER //');
      for (const c of createSqls) lines.push(c.replace(/;\s*$/, ''), '//', '');
      lines.push('DELIMITER ;', '');
    } else {
      lines.push(createSqls.join('\n\n'), '');
    }
  }
  if (!dropSql.length && !createSqls.length) {
    lines.push('-- No dependent object needed recreating.', '');
  }

  if (autoUpdated.length) {
    lines.push('-- ── Updated by the server — no action needed ─────────────────────────');
    for (const a of autoUpdated) lines.push(`-- ${a.label}: ${a.why}`);
    lines.push('');
  }

  if (review.length) {
    lines.push(`-- ── Not touched — review by hand (${review.length}) ───────────────────────`);
    for (const r of review) {
      const where = r.line !== undefined ? ` line ${r.line}` : '';
      const conf = r.confidence ? ` [${r.confidence}]` : '';
      lines.push(`-- ${r.label} (${KIND_WORD[r.kind]})${where}${conf}: ${r.message}`);
      if (r.lineText) lines.push(`--   ${r.lineText}`);
    }
    lines.push('');
  }

  lines.push('-- Nothing in this script has seen your application code, another schema,');
  lines.push('-- or a database on another server.');

  return {
    script: lines.join('\n'),
    rename, dropped, recreated, autoUpdated, review, warnings,
  };
}
