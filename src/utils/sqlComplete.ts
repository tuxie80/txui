/**
 * The editor's completion brain. One source, context-routed:
 *
 *   FROM/JOIN/INTO/…  → tables & views (+ CTEs / derived tables of the doc),
 *                       scoped to the resolution schemas when the entries carry
 *                       a scopeRank (default DB / search_path — everything else
 *                       then spells its schema: `analytics.`)
 *   JOIN              → ready-made FK join clauses ("parcels p ON p.order_id = o.id")
 *   ON                → FK equality pairs, then same-name column pairs
 *   USE               → databases;  CALL → procedures
 *   INSERT INTO t (   → t's columns, minus ones already listed
 *   SELECT/WHERE/…    → columns of the statement's tables (PK first),
 *                       then functions, then keywords
 *   db.               → that schema's tables;  db.table. / alias. / cte. → columns
 *   chain.postfix     → whole-statement templates (orders.sel → SELECT * FROM orders,
 *                       utils/sqlPostfix.ts) alongside the normal dot-completion
 *   GROUP/ORDER BY …  → the select list's own aliases too (price*qty AS total → total)
 *   statement start   → templates (sel/ins/upd/cte/topn…) + keywords
 *
 * All schema data arrives via injected providers (lazy, cached per session).
 */
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { snippetCompletion } from '@codemirror/autocomplete';
import type { Engine } from '../types';
import type { SchemaCompletion } from '../components/SqlEditor';
import { blank, findAliases } from './sqlAlias.ts';
import { classifyContext, findVirtualTables, insertContext, selectListColumns, suggestAlias } from './sqlContext.ts';
import type { VirtualTable } from './sqlContext.ts';
import { postfixCompletions } from './sqlPostfix.ts';
import { applyKeywordCase, keywordCatalog, STATEMENT_TEMPLATES, STATEMENT_SHORTCUTS } from './sqlKeywords.ts';
import { parseKillTrigger } from './killAnalyze.ts';
import { safeIdent, safePath } from './sqlIdent.ts';
import { statementAt } from './sqlSplit.ts';

export interface FkEdge {
  /** child side — owns the FK columns (qualified schema.table) */
  fromTable: string;
  fromCols: string[];
  /** parent side — referenced (qualified schema.table) */
  toTable: string;
  toCols: string[];
}

export interface ServerVariable { name: string; value: string }

/** A stored SQL template (`?name` expansion) — body uses CM snippet syntax. */
export interface SqlTemplateDef {
  name: string;
  /** 'mysql' | 'postgres' | 'redis', or null/undefined/'any' = every engine */
  engine?: string | null;
  description?: string;
  body: string;
}

export interface CompletionProviders {
  getColumns?: (table: string) => Promise<SchemaCompletion[]>;
  getFks?: (table: string) => Promise<FkEdge[]>;
  /** `SHOW VARIABLES` / `pg_settings`, lazy + cached — powers `@@…` completion */
  getServerVariables?: () => Promise<ServerVariable[]>;
  /**
   * Tables/views of a given schema — swept schemas answer instantly, system
   * or post-sweep schemas are fetched lazily and cached by the provider.
   */
  getSchemaTables?: (schema: string) => Promise<SchemaCompletion[]>;
  /** Stored SQL templates — powers `?name` snippet completion */
  getTemplates?: () => Promise<SqlTemplateDef[]>;
}

// MySQL SHOW statements — there aren't many, so offer them all after "SHOW "
const SHOW_COMPLETIONS = [
  'DATABASES', 'TABLES', 'FULL TABLES', 'OPEN TABLES', 'TABLE STATUS',
  'FULL PROCESSLIST', 'PROCESSLIST',
  'GLOBAL VARIABLES LIKE \'%%\'', 'SESSION VARIABLES LIKE \'%%\'', 'VARIABLES',
  'GLOBAL STATUS LIKE \'%%\'', 'SESSION STATUS', 'STATUS',
  'ENGINE INNODB STATUS', 'ENGINE INNODB MUTEX', 'ENGINES',
  'INDEX FROM ', 'KEYS FROM ',
  'CREATE TABLE ', 'CREATE VIEW ', 'CREATE PROCEDURE ', 'CREATE FUNCTION ',
  'CREATE TRIGGER ', 'CREATE EVENT ', 'CREATE DATABASE ', 'CREATE USER ',
  'GRANTS', 'GRANTS FOR ', 'WARNINGS', 'ERRORS',
  'BINARY LOGS', 'BINARY LOG STATUS', 'MASTER STATUS', 'BINLOG EVENTS IN ',
  'REPLICA STATUS', 'REPLICAS', 'SLAVE STATUS', 'SLAVE HOSTS', 'RELAYLOG EVENTS',
  'TRIGGERS', 'EVENTS', 'PLUGINS', 'PRIVILEGES', 'PROFILES',
  'CHARACTER SET', 'COLLATION', 'PROCEDURE STATUS', 'FUNCTION STATUS',
];

/**
 * MySQL optimizer hints — the block-comment hint syntax. Rarely typed from
 * memory, and
 * a DBA reaching for one is usually mid-incident.
 */
const OPTIMIZER_HINTS: { label: string; detail: string }[] = [
  { label: 'MAX_EXECUTION_TIME(1000)', detail: 'abort this SELECT after N ms' },
  { label: 'NO_INDEX(t idx)', detail: 'forbid an index for a table' },
  { label: 'INDEX(t idx)', detail: 'prefer an index' },
  { label: 'GROUP_INDEX(t idx)', detail: 'index for GROUP BY' },
  { label: 'ORDER_INDEX(t idx)', detail: 'index for ORDER BY' },
  { label: 'JOIN_ORDER(a, b)', detail: 'fix the join order' },
  { label: 'JOIN_PREFIX(a)', detail: 'force a table first in the join order' },
  { label: 'BKA(t)', detail: 'batched key access' },
  { label: 'NO_BKA(t)', detail: 'disable batched key access' },
  { label: 'MRR(t)', detail: 'multi-range read' },
  { label: 'NO_MRR(t)', detail: 'disable multi-range read' },
  { label: 'SEMIJOIN(FIRSTMATCH)', detail: 'semi-join strategy' },
  { label: 'NO_SEMIJOIN()', detail: 'disable semi-join strategies' },
  { label: 'SUBQUERY(MATERIALIZATION)', detail: 'subquery strategy' },
  { label: 'MERGE(v)', detail: 'merge a derived table/view' },
  { label: 'NO_MERGE(v)', detail: 'materialize a derived table/view' },
  { label: 'SET_VAR(sort_buffer_size=16M)', detail: 'session variable for this statement' },
  { label: 'RESOURCE_GROUP(rg)', detail: 'run under a resource group' },
];

/** Always sensible on the right-hand side of a value. */
const VALUE_LITERALS: Completion[] = [
  { label: 'NULL', type: 'keyword' },
  { label: 'DEFAULT', type: 'keyword' },
  { label: 'NOW()', type: 'function', detail: 'current timestamp' },
  { label: 'CURRENT_TIMESTAMP', type: 'function' },
  { label: 'UUID()', type: 'function' },
];

/**
 * Values worth offering for a specific column, read from its declared type:
 * every `enum`/`set` member, booleans for `tinyint(1)`/`boolean`, `NOW()` for
 * temporal columns, `0` for numerics. This is the difference between "a popup
 * appeared" and "the popup knew what goes here".
 */
function valueOptions(col: SchemaCompletion): Completion[] {
  const type = (col.detail ?? '').toLowerCase();
  const out: Completion[] = [];
  const enumMatch = /^(?:enum|set)\s*\((.*)\)$/is.exec(type.trim());
  if (enumMatch) {
    for (const raw of enumMatch[1].split(',')) {
      const v = raw.trim();
      if (!v) continue;
      out.push({ label: v, type: 'text', detail: `${col.label} value`, boost: 90 });
    }
    return out;
  }
  if (/^(tinyint\(1\)|boolean|bool)/.test(type)) {
    out.push({ label: '1', type: 'text', detail: 'true', boost: 90 });
    out.push({ label: '0', type: 'text', detail: 'false', boost: 89 });
    return out;
  }
  if (/(date|time|year)/.test(type)) {
    out.push({ label: 'NOW()', type: 'function', detail: `${col.label} — current time`, boost: 90 });
    out.push({ label: 'CURRENT_DATE', type: 'function', boost: 88 });
    return out;
  }
  if (/(int|decimal|numeric|float|double)/.test(type)) {
    out.push({ label: '0', type: 'text', detail: col.detail, boost: 80 });
  }
  return out;
}

const CM_TYPE: Record<string, string> = {
  table: 'class', view: 'class', column: 'property',
  keyword: 'keyword', schema: 'namespace', database: 'namespace',
};

function toOption(c: SchemaCompletion, boost = 0): Completion {
  return {
    label: c.label,
    apply: c.apply,
    type: CM_TYPE[c.type] ?? 'keyword',
    detail: c.detail,
    info: c.info,
    boost,
  };
}

const bare = (t: string) => t.split('.').pop() ?? t;

/** Is the caret inside a '…' / "…" literal? (used before context classification) */
function endsInsideString(before: string): boolean {
  let open: string | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (open) {
      if (c === '\\') { i++; continue; }
      if (c === open) open = null;
      continue;
    }
    if (c === '-' && before[i + 1] === '-') { const n = before.indexOf('\n', i); if (n < 0) return false; i = n; continue; }
    if (c === '/' && before[i + 1] === '*') { const n = before.indexOf('*/', i); if (n < 0) return false; i = n + 1; continue; }
    if (c === "'" || c === '"') open = c;
  }
  return open !== null;
}

/**
 * Identifiers present in the buffer — a last-resort completion source for names
 * the catalog does not know (aliases, CTEs, temp tables, a column you are about
 * to create). Deliberately capped and de-noised: 3+ chars, not the word being
 * typed, not a number.
 */
function documentWords(doc: string, current: string): string[] {
  // The word scan is per DOCUMENT — memoized on the doc string identity
  // (WP-14 14.7); only the cheap `current` filter runs per keystroke.
  let words = docWordsCache.get(doc);
  if (!words) {
    const out = new Set<string>();
    for (const m of doc.matchAll(/[A-Za-z_][\w$]{2,}/g)) {
      out.add(m[0]);
      if (out.size >= 201) break;
    }
    words = [...out];
    docWordsCache.set(doc, words);
  }
  return words.filter(w => w !== current).slice(0, 200);
}

// ── Whole-document derivation caches (WP-14 14.7) ───────────────────────────
//
// Each completion request used to run several full-document passes: the
// `doc.toString()`, `findVirtualTables(doc)` and the word scan above. They
// are memoized on object identity — CodeMirror's `state.doc` is immutable
// (a new document version is a new object), and the WeakMaps keep the module
// pure and leak-free. Strings can't key a WeakMap, so the two string-keyed
// caches are single-slot (the editor asks about one document at a time; a
// different doc simply misses).
const docTextCache = new WeakMap<object, string>();
let docWordsCacheKey = '';
let docWordsCacheVal: string[] | null = null;
const docWordsCache = {
  get(doc: string): string[] | null { return doc === docWordsCacheKey ? docWordsCacheVal : null; },
  set(doc: string, words: string[]) { docWordsCacheKey = doc; docWordsCacheVal = words; },
};
let vtCacheKey = '';
let vtCacheVal: ReturnType<typeof findVirtualTables> | null = null;

/** table (as written) → preferred reference: its alias if one exists, else its bare name */
function tableRefs(aliases: Map<string, string>): Map<string, string> {
  const refs = new Map<string, string>();
  for (const [alias, table] of aliases) {
    const existing = refs.get(table);
    const isBare = alias === bare(table).toLowerCase();
    if (!existing || (!isBare && existing === bare(table).toLowerCase())) {
      refs.set(table, alias);
    }
  }
  return refs;
}

function eqCond(
  engine: Engine,
  leftRef: string, leftCols: string[], rightRef: string, rightCols: string[],
): string {
  // Refs are aliases (already safe by construction); the COLUMN names come from
  // the catalog and may be reserved words or camelCase on PG — quote those.
  return leftCols
    .map((c, i) => `${leftRef}.${safeIdent(c, engine)} = ${rightRef}.${safeIdent(rightCols[i], engine)}`)
    .join(' AND ');
}

/**
 * Guess a join between two tables when the schema declares no foreign key.
 *
 * Plenty of real schemas carry no FK constraints at all — MyISAM legacy, ORMs
 * that never emitted them, warehouses that dropped them for load speed — and
 * in those the FK-driven suggestions are simply empty, which is the case where
 * a join hint would have helped most. Convention gets it right often enough to
 * be worth offering, provided it is *labelled* as a guess so nobody mistakes it
 * for a declared relationship.
 *
 * Two patterns, in confidence order:
 *   1. `orders.customer_id` → `customers.id`     (singular table + _id → PK)
 *   2. `orders.customer_id` → `customers.customer_id`  (same name both sides)
 *
 * Returns null when nothing plausible lines up — a wrong join silently
 * inserted is worse than no suggestion.
 */
export function inferJoin(
  fromCols: string[],
  toTable: string, toCols: string[],
): { fromCol: string; toCol: string } | null {
  const bareName = (t: string) => t.split('.').pop()!.toLowerCase();
  const singular = (s: string) => (s.endsWith('ies') ? s.slice(0, -3) + 'y'
    : s.endsWith('ses') ? s.slice(0, -2)
    : s.endsWith('s') ? s.slice(0, -1) : s);

  const target = bareName(toTable);
  const stem = singular(target);
  const lower = (cols: string[]) => new Map(cols.map(c => [c.toLowerCase(), c]));
  const fromMap = lower(fromCols);
  const toMap = lower(toCols);

  // 1. orders.customer_id → customers.id / customers.customer_id
  for (const candidate of [`${stem}_id`, `${target}_id`, `${stem}id`]) {
    const fk = fromMap.get(candidate);
    if (!fk) continue;
    const pk = toMap.get('id') ?? toMap.get(candidate) ?? toMap.get(`${stem}_id`);
    if (pk) return { fromCol: fk, toCol: pk };
  }

  // 2. identical non-generic column name on both sides. `id` alone is excluded:
  // every table has one and joining orders.id = customers.id is nonsense.
  for (const [lc, original] of fromMap) {
    if (lc === 'id' || !lc.endsWith('_id')) continue;
    const match = toMap.get(lc);
    if (match) return { fromCol: original, toCol: match };
  }
  return null;
}

async function columnsOf(
  table: string,
  vts: Map<string, VirtualTable>,
  getColumns?: (t: string) => Promise<SchemaCompletion[]>,
): Promise<SchemaCompletion[]> {
  const vt = vts.get(table.toLowerCase()) ?? vts.get(bare(table).toLowerCase());
  if (vt) {
    return vt.columns.map(c => ({
      label: c, type: 'column' as const, detail: vt.kind === 'cte' ? 'CTE' : 'subquery',
    }));
  }
  return getColumns ? getColumns(table) : [];
}

/**
 * Is the caret sitting right after a statement terminator?
 *
 * When a line ends with `;` (or the configured custom delimiter) the statement
 * is DONE — offering completions there only means Enter accepts the first hint
 * instead of inserting a newline. The check is line-local on purpose: a new
 * statement started on the NEXT line completes normally.
 *
 * Word-like delimiters (`GO`) get the same boundary rule the splitter uses
 * (`delimiterFits` in sqlSplit.ts): `GOODS` is an identifier, not a terminator.
 */
export function afterStatementEnd(lineBeforeCaret: string, delimiter = ';'): boolean {
  const trimmed = lineBeforeCaret.replace(/\s+$/, '');
  if (!trimmed) return false;
  const delim = delimiter.trim() || ';';
  if (!trimmed.endsWith(delim)) return false;
  const before = trimmed.length - delim.length;
  if (/\w/.test(delim[delim.length - 1]) && before > 0 && /\w/.test(trimmed[before - 1])) {
    return false;
  }
  return true;
}

export interface CompletionOptions {
  /** how keywords/functions are written; the host reads the preference */
  upperCaseKeywords?: boolean;
  /**
   * Statement terminator for the after-`;` completion suppression
   * (`afterStatementEnd`). The host passes the `sqlDelimiter()` preference;
   * defaults to `;`.
   */
  delimiter?: string;
  /**
   * Which MySQL-protocol server this is.
   *
   * MySQL and MariaDB do not accept the same statements: `EXPLAIN ANALYZE` is
   * MySQL-only, sequences and `RETURNING` are MariaDB-only. Completing the
   * wrong set offers syntax errors, which is worse than offering nothing.
   */
  flavor?: 'mysql' | 'mariadb' | 'percona';
  /**
   * Recency/frequency boost for a completion label (utils/usageRank). Refines
   * ordering within a category by what the user actually runs; returns 0 by
   * default so ranking is unchanged when it isn't supplied.
   */
  usageBoost?: (label: string) => number;
}

export function buildCompletionSource(
  engine: Engine,
  schema: SchemaCompletion[],
  providers: CompletionProviders,
  options: CompletionOptions = {},
) {
  const usage = options.usageBoost ?? (() => 0);
  // Schema completions go through `opt`, which layers the usage boost on top of
  // the structural boost each call site passes.
  const opt = (c: SchemaCompletion, base = 0): Completion => toOption(c, base + usage(c.label));
  const kwItems = applyKeywordCase(
    keywordCatalog(engine, options.flavor), options.upperCaseKeywords !== false);
  const kwOptions = (boost: number): Completion[] =>
    kwItems.map(k => k.snippet
      ? snippetCompletion(k.snippet, { label: k.label, detail: k.detail, type: k.type, boost })
      : { label: k.label, detail: k.detail, type: k.type, boost });

  const templateOptions = (): Completion[] =>
    STATEMENT_TEMPLATES.map(t =>
      snippetCompletion(t.snippet, { label: t.label, detail: t.detail, type: 'text', boost: 30 }));

  /** Whole-statement DBA shortcuts ("pro…" → SHOW FULL PROCESSLIST), filtered by engine. */
  const shortcutOptions = (): Completion[] =>
    STATEMENT_SHORTCUTS
      .filter(s => (s.engines as string[]).includes(engine))
      .map(s => ({
        label: s.shortcut, apply: s.statement, type: 'text', detail: s.detail, boost: 30,
      } as Completion));

  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const { getColumns, getFks, getSchemaTables } = providers;

    // Memoized on the immutable CM document object — see the caches above.
    const docObj = ctx.state.doc as unknown as object;
    let doc = docTextCache.get(docObj);
    if (doc === undefined) {
      doc = ctx.state.doc.toString();
      docTextCache.set(docObj, doc);
    }

    // Caret right after a statement terminator (`;` or the custom delimiter):
    // the statement is finished — no popup, so Enter just inserts a newline.
    const lineStart = doc.lastIndexOf('\n', ctx.pos - 1) + 1;
    if (afterStatementEnd(doc.slice(lineStart, ctx.pos), options.delimiter)) return null;

    const before = doc.slice(0, ctx.pos);
    const sqlCtx = classifyContext(before);

    // ── @@system / @user / :bound variables (B9) ─────────────────────────────
    const varTok = ctx.matchBefore(/@@?[\w$.]*/);
    if (varTok && varTok.text.startsWith('@') && !endsInsideString(before)) {
      const opts: Completion[] = [];
      if (varTok.text.startsWith('@@')) {
        for (const v of await (providers.getServerVariables?.() ?? Promise.resolve([]))) {
          opts.push({ label: `@@${v.name}`, type: 'variable', detail: v.value, boost: 10 });
        }
      } else {
        // user variables already mentioned in this document
        for (const m of new Set([...doc.matchAll(/@([A-Za-z_]\w*)/g)].map(x => x[1]))) {
          opts.push({ label: `@${m}`, type: 'variable', detail: 'session variable', boost: 5 });
        }
      }
      if (opts.length > 0) return { from: varTok.from, options: opts, validFor: /^@@?[\w$.]*$/ };
    }

    // ── MySQL optimizer hints inside /*+ … */ (B10) ──────────────────────────
    const hint = ctx.matchBefore(/\/\*\+[\s\S]*/);
    if (hint && engine === 'mysql' && !before.slice(hint.from).includes('*/')) {
      const tail = /[\w()]*$/.exec(hint.text)?.[0] ?? '';
      return {
        from: ctx.pos - tail.length,
        options: OPTIMIZER_HINTS.map(h => ({
          label: h.label, detail: h.detail, type: 'keyword', boost: 10,
        })),
        validFor: /^[\w()]*$/,
      };
    }

    // Inside a string/comment: offer NOTHING — this must precede every other
    // branch (dotted tokens inside literals would otherwise fire DB lookups,
    // and accepting any item would splice code into the literal).
    // NOTE: the two branches ABOVE are deliberately earlier — an optimizer hint
    // lives INSIDE a block comment (so the literal guard would swallow it), and
    // `@@session.sql_mode` must not be read as a dotted `session.` qualifier.
    if (sqlCtx.kind === 'literal') return null;

    // `kill …` / `killall` gets the live process picker instead (KillPicker) —
    // two popups fighting over ↑↓⏎ would be unusable, and no keyword list can
    // tell you which thread id is the runaway one.
    if (parseKillTrigger(before)) return null;

    // ── ?name — stored SQL templates (curated + user), snippet-expanded ─────
    const tmplTok = ctx.matchBefore(/\?[\w-]*$/);
    if (tmplTok) {
      const templates = await (providers.getTemplates?.() ?? Promise.resolve([]));
      const opts = templates
        .filter(t => !t.engine || t.engine === 'any' || t.engine === engine)
        .map(t => snippetCompletion(t.body, {
          label: `?${t.name}`,
          detail: t.description || 'SQL template',
          info: t.body,
          type: 'text',
          boost: 40,
        }));
      if (opts.length > 0) return { from: tmplTok.from, options: opts, validFor: /^\?[\w-]*$/ };
    }

    // ── MySQL SHOW catalog — only when the statement actually IS a SHOW
    // (matching "show" anywhere before the caret hijacked completion after
    // string values like '… title = ''show time'' AND ').
    if (engine === 'mysql') {
      const blanked = blank(before);
      const curStmt = blanked.slice(blanked.lastIndexOf(';') + 1);
      if (/^\s*show\s/i.test(curStmt)) {
        const show = ctx.matchBefore(/\bshow\s+[\s\S]*/i);
        if (show) {
          const after = show.text.replace(/^show\s+/i, '');
          const expectsObject = /\b(table|view|procedure|function|trigger|event|index|keys|columns|grants)\b\s+(from\s+|for\s+)?[\w.`$]*$/i.test(after)
            && /\s[\w.`$]*$/.test(after);
          if (!expectsObject) {
            const tail = /[A-Za-z' %]*$/.exec(after)?.[0] ?? '';
            return {
              from: ctx.pos - tail.length,
              options: SHOW_COMPLETIONS.map(s => ({ label: s, type: 'keyword' })),
              validFor: /^[A-Za-z' %]*$/,
            };
          }
          // else fall through — "SHOW CREATE TABLE or…" hints tables
        }
      }
    }

    const stmtFull = statementAt(doc, ctx.pos)?.text ?? doc;
    let vts: ReturnType<typeof findVirtualTables>;
    if (doc === vtCacheKey && vtCacheVal) {
      vts = vtCacheVal;
    } else {
      vts = findVirtualTables(doc);
      vtCacheKey = doc;
      vtCacheVal = vts;
    }

    // ── Dotted: alias. / cte. / db. / db.table. ──────────────────────────
    const dotted = ctx.matchBefore(/[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?\.\w*/);
    if (dotted) {
      const dot = dotted.text.lastIndexOf('.');
      const qualifier = dotted.text.slice(0, dot);
      const partFrom = dotted.from + dot + 1;

      // Postfix templates (orders.sel → SELECT * FROM orders) ride ALONGSIDE
      // the normal dot-completion: the result spans the text after the dot (so
      // fuzzy filtering works), the apply reaches back to dotted.from and
      // replaces the whole chain. Empty for Redis — see utils/sqlPostfix.ts.
      const postfix = postfixCompletions(qualifier, dotted.from, engine);

      // CTE / derived-table columns
      const vt = vts.get(qualifier.toLowerCase());
      if (vt && vt.columns.length > 0) {
        return {
          from: partFrom,
          options: [
            ...vt.columns.map(c => ({
              label: c, type: 'property', detail: vt.kind === 'cte' ? 'CTE' : 'subquery',
            })),
            ...postfix,
          ],
          validFor: /^\w*$/,
        };
      }

      // alias. / table. / db. / db.table. — two candidate interpretations:
      //   columns  — qualifier is a table alias/name (columnsOf, not raw
      //              getColumns, so a CTE/derived-table alias serves its
      //              projected columns instead of hitting the DB)
      //   tables   — qualifier is a schema/database name (lazy provider
      //              covers system schemas like `mysql.` too)
      // "FROM mysql." self-maps the schema name as a phantom table, so a REAL
      // alias (alias ≠ the table's own bare name) wins; a known schema name
      // beats the phantom self-map; each path falls back to the other.
      const aliasTable = findAliases(doc).get(qualifier.toLowerCase());
      const isRealAlias = !!aliasTable && bare(aliasTable).toLowerCase() !== qualifier.toLowerCase();
      const isSchemaName = schema.some(c =>
        (c.kind === 'schema' || c.type === 'database') && c.label.toLowerCase() === qualifier.toLowerCase());

      const columnTarget = aliasTable ?? (qualifier.includes('.') ? qualifier : undefined);
      const columnPath = async (): Promise<SchemaCompletion[]> =>
        columnTarget && getColumns ? columnsOf(columnTarget, vts, getColumns) : [];
      const schemaPath = async (): Promise<SchemaCompletion[]> =>
        !qualifier.includes('.') && getSchemaTables ? getSchemaTables(qualifier) : [];

      const paths = isRealAlias || (!isSchemaName && columnTarget)
        ? [columnPath, schemaPath]
        : [schemaPath, columnPath];
      for (const path of paths) {
        const opts = await path().catch(() => [] as SchemaCompletion[]);
        if (opts.length > 0) {
          return {
            from: partFrom,
            options: [...opts.map(c => opt(c, c.pk ? 5 : 0)), ...postfix],
            validFor: /^\w*$/,
          };
        }
      }
      // unknown qualifier — the postfixes still work (the chain needs no
      // catalog); without them, fall through to the generic list
      if (postfix.length > 0) {
        return { from: partFrom, options: postfix, validFor: /^\w*$/ };
      }
    }

    // ── JOIN … USING ( col ) (B14) ───────────────────────────────────────────
    const usingTok = /\busing\s*\(\s*([\w$,\s]*)$/i.exec(before);
    if (usingTok && getColumns) {
      const refs = [...new Set(findAliases(stmtFull).values())];
      if (refs.length >= 2) {
        const lists = await Promise.all(refs.slice(0, 6).map(t =>
          columnsOf(t, vts, getColumns).catch(() => [] as SchemaCompletion[])));
        const counts = new Map<string, { label: string; n: number; detail?: string }>();
        for (const list of lists) {
          for (const c of new Map(list.map(x => [x.label.toLowerCase(), x])).values()) {
            const key = c.label.toLowerCase();
            const prev = counts.get(key);
            counts.set(key, { label: c.label, n: (prev?.n ?? 0) + 1, detail: c.detail });
          }
        }
        const listed = new Set(usingTok[1].split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
        const shared = [...counts.values()]
          .filter(c => c.n >= 2 && !listed.has(c.label.toLowerCase()))
          .map(c => ({
            label: c.label, type: 'property', detail: `in ${c.n} of the joined tables`,
            boost: 20,
          } as Completion));
        const tail = /[\w$]*$/.exec(before)?.[0] ?? '';
        if (shared.length > 0) {
          return { from: ctx.pos - tail.length, options: shared, validFor: /^[\w$]*$/ };
        }
      }
    }

    // The INSERT model is consulted before the guard below, because
    // `INSERT INTO t ` classifies as 'generic' (no clause keyword precedes the
    // caret) yet is one of the most structural positions there is.
    const ins = insertContext(before);

    const word = ctx.matchBefore(/[\w`"$.]+/);
    const from = word ? word.from : ctx.pos;
    // A STRUCTURAL position hints with nothing typed: after `INSERT INTO `,
    // `FROM `, `SET `, `WHERE `, `VALUES (` … you may not know the name yet, and
    // that is exactly when you need the list. Only the unstructured fallback
    // (which would dump the whole catalog on every space) still needs a word.
    const structural = sqlCtx.kind !== 'generic' || ins !== null;
    if (!word && !ctx.explicit && !structural) return null;

    // ── the INSERT / REPLACE flow, end to end ────────────────────────────────
    // classifyContext only knows the column-list case; the target, the VALUES
    // tuple and MySQL's SET form need the fuller model in sqlContext.
    if (ins && getColumns) {
      const cols = await columnsOf(ins.table, vts, getColumns).catch(() => [] as SchemaCompletion[]);

      // `INSERT INTO t ` → offer the whole skeleton (all columns + VALUES)
      if (ins.where === 'after-target' && cols.length > 0) {
        const names = cols.map(c => c.apply ?? c.label);
        const noPk = cols.filter(c => !c.pk);
        const options: Completion[] = [{
          label: `(${cols.map(c => c.label).join(', ')}) VALUES (…)`,
          apply: `(${names.join(', ')})\nVALUES (${cols.map(() => '?').join(', ')})`,
          type: 'text', detail: `all ${cols.length} columns`, boost: 60,
        }];
        if (noPk.length > 0 && noPk.length !== cols.length) {
          options.push({
            label: `(${noPk.map(c => c.label).join(', ')}) VALUES (…)`,
            apply: `(${noPk.map(c => c.apply ?? c.label).join(', ')})\nVALUES (${noPk.map(() => '?').join(', ')})`,
            type: 'text', detail: 'without the primary key', boost: 59,
          });
        }
        options.push({ label: 'VALUES (', type: 'keyword', boost: 40 });
        options.push({ label: 'SET ', type: 'keyword', detail: 'MySQL assignment form', boost: 39 });
        options.push({ label: 'SELECT ', type: 'keyword', detail: 'INSERT … SELECT', boost: 38 });
        return { from, options, validFor: /^[\w(]*$/ };
      }

      // inside a VALUES tuple → what belongs in THIS position
      if (ins.where === 'values' && cols.length > 0) {
        const target = ins.columns
          ? cols.find(c => c.label.toLowerCase() === (ins.columns![ins.index] ?? '').toLowerCase())
          : cols[ins.index];
        // Which column this position feeds is shown by the inline hint bar above
        // the editor (see SqlEditor's signature help) — putting it in the list as
        // a pseudo-item that inserts nothing would just be clutter you can
        // accidentally accept.
        const options: Completion[] = [
          ...(target ? valueOptions(target) : []),
          ...VALUE_LITERALS.map(v => ({ ...v, boost: 20 } as Completion)),
          // Only FUNCTIONS from the catalog: `SELECT`/`FROM` in a value position
          // is noise, and 150 irrelevant options is how a popup stops being read.
          ...kwItems.filter(k => k.type === 'function').map(k => k.snippet
            ? snippetCompletion(k.snippet, { label: k.label, detail: k.detail, type: 'function', boost: -10 })
            : { label: k.label, detail: k.detail, type: 'function', boost: -10 }),
        ];
        return { from, options, validFor: /^[\w'"$.]*$/ };
      }

      // MySQL `INSERT … SET col = …` / `ON DUPLICATE KEY UPDATE col = …`
      if (ins.where === 'set' && cols.length > 0) {
        const assigned = new Set(
          [...before.matchAll(/([\w`"$]+)\s*=/g)].map(m => m[1].replace(/[`"]/g, '').toLowerCase()));
        const lastEq = /=\s*[\w'"$.]*$/.test(before);
        const options = lastEq
          // right-hand side: values for the column being assigned
          ? (() => {
              const colName = /([\w`"$]+)\s*=\s*[\w'"$.]*$/.exec(before)?.[1]?.replace(/[`"]/g, '');
              const col = cols.find(c => c.label.toLowerCase() === colName?.toLowerCase());
              return [
                ...(col ? valueOptions(col) : []),
                ...VALUE_LITERALS.map(v => ({ ...v, boost: 20 } as Completion)),
                ...kwItems.filter(k => k.type === 'function').map(k => k.snippet
                  ? snippetCompletion(k.snippet, { label: k.label, detail: k.detail, type: 'function', boost: -10 })
                  : { label: k.label, detail: k.detail, type: 'function', boost: -10 }),
              ];
            })()
          : cols.filter(c => !assigned.has(c.label.toLowerCase())).map(c => opt(c, c.pk ? 25 : 20));
        return { from, options, validFor: /^[\w'"$.]*$/ };
      }
    }

    /**
     * Objects filtered by kind, with virtual tables of this doc prepended.
     *
     * `scopeToPath` (table contexts only): when entries carry a scopeRank —
     * the hook's resolution-order tag, see utils/searchPath.ts — tables and
     * views outside it drop out of the list, and the survivors order by path
     * position (earlier schema, higher boost). Cross-schema work is never
     * blocked: schema names are offered unscoped, so `analytics.` still dots
     * in. When NO candidate carries a rank the resolution is unknown (metadata
     * still loading, no default database chosen) — and unknown means allowed,
     * so the full list shows.
     */
    const objectOptions = (kinds: Set<string>, boost = 10, scopeToPath = false): Completion[] => {
      const opts: Completion[] = [];
      for (const [, vt] of vts) {
        if (kinds.has('table')) {
          opts.push({ label: vt.name, type: 'class', detail: vt.kind === 'cte' ? 'CTE' : 'subquery', boost: boost + 5 });
        }
      }
      const candidates = schema.filter(c => kinds.has(c.kind ?? c.type));
      const ranked = scopeToPath ? candidates.filter(c => c.scopeRank !== undefined) : [];
      const scoped = ranked.length > 0;
      for (const c of scoped ? ranked : candidates) {
        opts.push(opt(c, boost - (scoped ? (c.scopeRank ?? 0) : 0)));
      }
      return opts;
    };

    /**
     * Same objects, but each table also offered WITH a generated alias
     * (`orders o`) — you are about to join or qualify it, and aliasing after the
     * fact means going back to the FROM clause. The bare form stays first.
     */
    const tableOptionsWithAliases = (boost = 10): Completion[] => {
      const taken = new Set(findAliases(stmtFull).keys());
      const opts = objectOptions(new Set(['table', 'view']), boost, true);
      const aliased: Completion[] = [];
      // Only for what the user is actually typing, and capped: on a 15k-object
      // schema, aliasing everything would double the list CodeMirror filters on
      // every keystroke for no benefit.
      const typed = (ctx.matchBefore(/[\w`"$.]+/)?.text ?? '').toLowerCase();
      const ALIAS_CAP = 40;
      for (const o of opts) {
        if (aliased.length >= ALIAS_CAP) break;
        if (typed && typeof o.label === 'string' && !o.label.toLowerCase().startsWith(typed)) continue;
        if (typeof o.label !== 'string' || o.type !== 'class') continue;
        const insert = (typeof o.apply === 'string' ? o.apply : o.label);
        const alias = suggestAlias(o.label, taken);
        if (!alias || alias === o.label.toLowerCase()) continue;
        aliased.push({
          label: `${o.label} ${alias}`,
          apply: `${insert} ${alias}`,
          type: 'class',
          detail: 'with alias',
          boost: (o.boost ?? boost) - 1,
        });
      }
      return [...opts, ...aliased];
    };

    switch (sqlCtx.kind) {
      case 'statement-start': {
        return {
          from,
          options: [
            ...templateOptions(),
            ...shortcutOptions(),
            ...kwOptions(15),
            ...objectOptions(new Set(['table', 'view', 'schema', 'database']), 0),
          ],
          validFor: /^[\w ]*$/,
        };
      }

      case 'use-db':
        return {
          from,
          options: objectOptions(new Set(['schema', 'database']), 20),
          validFor: /^[\w]*$/,
        };

      case 'call-proc':
        return {
          from,
          options: objectOptions(new Set(['procedure', 'function']), 20),
          validFor: /^[\w.]*$/,
        };

      case 'insert-cols': {
        if (!sqlCtx.insertTable || !getColumns) break;
        const cols = await columnsOf(sqlCtx.insertTable, vts, getColumns);
        // hide columns already listed between '(' and the caret
        const listed = new Set(
          (/\(([^)]*)$/.exec(before)?.[1] ?? '')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
        return {
          from,
          options: cols
            .filter(c => !listed.has(c.label.toLowerCase()))
            .map(c => opt(c, c.pk ? 5 : 0)),
          validFor: /^\w*$/,
        };
      }

      case 'join-table': {
        const tableOpts = tableOptionsWithAliases(10);
        if (!getFks) return { from, options: tableOpts, validFor: /^[\w.]*$/ };

        // scope = tables already in the statement, excluding the token being typed
        const typed = (word?.text ?? '').toLowerCase();
        const aliases = findAliases(stmtFull);
        if (typed) {
          for (const [a, t] of [...aliases]) {
            if (a === typed || t.toLowerCase() === typed) aliases.delete(a);
          }
        }
        const refs = tableRefs(aliases);
        const scope = [...refs.keys()].filter(t => !vts.has(t.toLowerCase())).slice(0, 8);
        const taken = new Set(aliases.keys());

        const fkOpts: Completion[] = [];
        const seen = new Set<string>();
        const edgeLists = await Promise.all(scope.map(t => getFks(t).catch(() => [] as FkEdge[])));
        scope.forEach((t, i) => {
          const ref = refs.get(t) ?? bare(t);
          for (const e of edgeLists[i]) {
            const scopeIsChild = bare(e.fromTable).toLowerCase() === bare(t).toLowerCase();
            const other = scopeIsChild ? e.toTable : e.fromTable;
            if (scope.some(s => bare(s).toLowerCase() === bare(other).toLowerCase())) continue; // already joined
            const insertName = t.includes('.')
              ? safePath(other.split('.'), engine)
              : safeIdent(bare(other), engine);
            const alias = suggestAlias(other, taken);
            const cond = scopeIsChild
              ? eqCond(engine, alias, e.toCols, ref, e.fromCols)
              : eqCond(engine, alias, e.fromCols, ref, e.toCols);
            const text = `${insertName} ${alias} ON ${cond}`;
            if (seen.has(text)) continue;
            seen.add(text);
            fkOpts.push({
              label: text,
              type: 'class',
              detail: scopeIsChild ? 'FK →' : '← FK',
              boost: 90,
            });
          }
        });
        return { from, options: [...fkOpts, ...tableOpts], validFor: /^[\w.]*$/ };
      }

      case 'on-clause': {
        const opts: Completion[] = [];
        const { joinTarget } = sqlCtx;
        if (joinTarget && getColumns) {
          const aliases = findAliases(stmtFull);
          const refs = tableRefs(aliases);
          const targetTable = aliases.get(joinTarget.alias.toLowerCase()) ?? joinTarget.table;
          const scope = [...refs.keys()]
            .filter(t => t !== targetTable && !vts.has(t.toLowerCase()))
            .slice(0, 8);
          const seen = new Set<string>();

          // FK-backed equality pairs
          if (getFks) {
            const edges = await getFks(targetTable).catch(() => [] as FkEdge[]);
            for (const e of edges) {
              const targetIsChild = bare(e.fromTable).toLowerCase() === bare(targetTable).toLowerCase();
              const otherBare = bare(targetIsChild ? e.toTable : e.fromTable).toLowerCase();
              const scopeT = scope.find(s => bare(s).toLowerCase() === otherBare);
              if (!scopeT) continue;
              const scopeRef = refs.get(scopeT) ?? bare(scopeT);
              const cond = targetIsChild
                ? eqCond(engine, joinTarget.alias, e.fromCols, scopeRef, e.toCols)
                : eqCond(engine, joinTarget.alias, e.toCols, scopeRef, e.fromCols);
              if (!seen.has(cond)) {
                seen.add(cond);
                opts.push({ label: cond, type: 'property', detail: 'FK', boost: 95 });
              }
            }
          }

          // same-name column pairs (fallback heuristic)
          const targetCols = await columnsOf(targetTable, vts, getColumns).catch(() => []);
          const targetNames = new Map<string, string>(targetCols.map(c => [c.label.toLowerCase(), c.label]));
          // All scope tables in parallel — sequential awaits stalled the popup
          // by one IPC round-trip per table.
          const scopeColsList = await Promise.all(
            scope.map(scopeT => columnsOf(scopeT, vts, getColumns).catch(() => [])));
          scope.forEach((scopeT, si) => {
            const scopeRef = refs.get(scopeT) ?? bare(scopeT);
            for (const sc of scopeColsList[si]) {
              const tn = targetNames.get(sc.label.toLowerCase());
              if (!tn || sc.label.toLowerCase() === 'id') continue; // id=id joins are usually wrong
              const cond = `${joinTarget.alias}.${tn} = ${scopeRef}.${sc.label}`;
              if (!seen.has(cond)) {
                seen.add(cond);
                opts.push({ label: cond, type: 'property', detail: 'same name', boost: 60 });
              }
            }
          });
        }
        // plus plain column completion below
        const colOpts = await columnContextOptions();
        return { from, options: [...opts, ...(colOpts ?? [])], validFor: /^[\w. ]*$/ };
      }

      case 'table-clause':
        return {
          from,
          options: [
            ...await joinClauseOptions(),
            ...tableOptionsWithAliases(15),
            ...objectOptions(new Set(['schema', 'database']), 15),
          ],
          validFor: /^[\w.]*$/,
        };

      case 'column': {
        const colOpts = await columnContextOptions();
        if (colOpts && colOpts.length > 0) {
          return {
            from,
            options: [...colOpts, ...kwOptions(-10)],
            validFor: /^[\w ]*$/,
          };
        }
        break;
      }

      case 'generic': {
        // A bare `j` mid-statement is far more often the start of a JOIN than
        // of a column called `j`, and the whole clause is what you actually
        // want typed for you.
        const joins = await joinClauseOptions();
        if (joins.length > 0) {
          return {
            from,
            options: [...joins, ...kwOptions(-5),
              ...schema.map(c => opt(c, c.type === 'table' || c.type === 'view' ? 5 : 0))],
            validFor: /^[\w.]*$/,
          };
        }
        break;
      }
    }

    // ── Fallback: full object list + keywords/functions + words in the buffer
    // (B12: aliases, CTE names and anything else you have typed but that the
    // catalog has never heard of — a completion source of last resort).
    return {
      from,
      options: [
        ...shortcutOptions(),
        ...schema.map(c => opt(c, c.type === 'table' || c.type === 'view' ? 5 : 0)),
        ...kwOptions(-5),
        ...documentWords(doc, word?.text ?? '').map(w => ({
          label: w, type: 'text', detail: 'in this buffer', boost: -8,
        } as Completion)),
      ],
      validFor: /^[\w.]*$/,
    };

    /**
     * Whole `JOIN … ON …` clauses, offered from a bare `j`.
     *
     * dbForge's best editor trick: you type one letter and get the entire join
     * written for you, both sides resolved. The existing FK suggestions only
     * appear once `JOIN ` is already typed, which is a keystroke too late and
     * misses the moment you are actually deciding.
     *
     * Labels start with the join keyword (`JOIN customers c ON …`), so
     * CodeMirror's own prefix filter surfaces them the instant you type `j`
     * and hides them otherwise — no separate trigger to get wrong.
     */
    async function joinClauseOptions(): Promise<Completion[]> {
      // Gate on the typed prefix before doing any catalog work: this runs on
      // every keystroke in a generic context, and fetching FK metadata for
      // every table in scope on each one would be felt.
      const typed = (word?.text ?? '').toLowerCase();
      if (typed && !/^(j|jo|joi|join|l|le|lef|left|i|in|inn|inne|inner)$/.test(typed)) return [];
      if (!getColumns && !getFks) return [];

      const aliases = findAliases(stmtFull);
      // Drop the token being typed — in `FROM orders o j`, `j` can look like an
      // alias to the scanner and would otherwise join the table to itself.
      if (typed) {
        for (const [a, t] of [...aliases]) {
          if (a === typed || bare(t).toLowerCase() === typed) aliases.delete(a);
        }
      }
      const refs = tableRefs(aliases);
      const scope = [...refs.keys()].filter(t => !vts.has(t.toLowerCase())).slice(0, 4);
      if (scope.length === 0) return [];

      const taken = new Set(aliases.keys());
      const out: Completion[] = [];
      const seen = new Set<string>();

      const push = (
        source: string, boost: number,
        other: string, cond: string, anchor: string,
      ) => {
        const insertName = anchor.includes('.')
          ? safePath(other.split('.'), engine)
          : safeIdent(bare(other), engine);
        const alias = suggestAlias(other, taken);
        for (const kw of ['JOIN', 'LEFT JOIN']) {
          const text = `${kw} ${insertName} ${alias} ON ${cond.replace(/\{A\}/g, alias)}`;
          if (seen.has(text)) continue;
          seen.add(text);
          out.push({
            label: text,
            type: 'class',
            detail: source,
            // A declared FK outranks a guess, and both outrank plain tables.
            boost: kw === 'JOIN' ? boost : boost - 2,
          });
        }
      };

      // ── declared foreign keys ──
      if (getFks) {
        const edgeLists = await Promise.all(scope.map(t => getFks(t).catch(() => [] as FkEdge[])));
        scope.forEach((t, i) => {
          const ref = refs.get(t) ?? bare(t);
          for (const e of edgeLists[i]) {
            const scopeIsChild = bare(e.fromTable).toLowerCase() === bare(t).toLowerCase();
            const other = scopeIsChild ? e.toTable : e.fromTable;
            if (scope.some(s => bare(s).toLowerCase() === bare(other).toLowerCase())) continue;
            const cond = scopeIsChild
              ? eqCond(engine, '{A}', e.toCols, ref, e.fromCols)
              : eqCond(engine, '{A}', e.fromCols, ref, e.toCols);
            push('foreign key', 95, other, cond, t);
          }
        });
      }

      // ── name-convention inference, only where FKs produced nothing ──
      // A schema with declared keys should never see guesses mixed in with
      // facts; one without them would otherwise get no help at all.
      if (out.length === 0 && getColumns) {
        // `apply` carries the qualified name (shop.customers) — the columns
        // provider is keyed on that, not on the bare label shown in the popup.
        const candidates = schema
          .filter(c => c.type === 'table' || c.type === 'view')
          .map(c => c.apply ?? c.label)
          .slice(0, 40);
        const inScope = new Set(scope.map(t => bare(t).toLowerCase()));
        const cols = await Promise.all(scope.map(t => columnsOf(t, vts, getColumns).catch(() => [])));
        // Candidate columns in parallel: the sequential await inside the loop
        // cost one round-trip per candidate (up to scope × 40 of them).
        const candCols = await Promise.all(
          candidates.map(cand => columnsOf(cand, vts, getColumns).catch(() => [])));

        for (let i = 0; i < scope.length && out.length < 12; i++) {
          const t = scope[i];
          const ref = refs.get(t) ?? bare(t);
          const myCols = cols[i].map(c => c.label);
          for (let ci = 0; ci < candidates.length; ci++) {
            const cand = candidates[ci];
            if (out.length >= 12) break;
            if (inScope.has(bare(cand).toLowerCase())) continue;
            const theirCols = candCols[ci].map(c => c.label);
            if (theirCols.length === 0) continue;
            const guess = inferJoin(myCols, cand, theirCols)
              ?? (() => {
                // Try the other direction too: the FK column may live on the
                // candidate (customers.order_id) rather than on the table
                // already in the statement.
                const back = inferJoin(theirCols, t, myCols);
                return back ? { fromCol: back.toCol, toCol: back.fromCol } : null;
              })();
            if (!guess) continue;
            const cond = `{A}.${safeIdent(guess.toCol, engine)} = ${ref}.${safeIdent(guess.fromCol, engine)}`;
            push('inferred from names — verify', 70, cand, cond, t);
          }
        }
      }

      return out;
    }

    /** Merged columns of the statement's tables — PK/id first, ORDER BY gets DESC companions. */
    async function columnContextOptions(): Promise<Completion[] | null> {
      const orderByCtx = /\border\s+by[\s\w,]*$/i.test(before);
      // After GROUP BY / ORDER BY / HAVING (or a comma inside them) the select
      // list's OWN names complete too — `SELECT price*qty AS total … ORDER BY t…`
      // → `total`. Document-derived (the same parser the CTE column discovery
      // uses), so it works even when the catalog knows nothing about the tables.
      const aliasCtx = /\b(?:group\s+by|order\s+by|having)\b[\s\w,()]*$/i.test(blank(before));
      const selectNames = aliasCtx ? selectListColumns(blank(stmtFull)) : [];
      const aliasOpts = (exclude: Set<string>): Completion[] =>
        selectNames
          .filter(n => !exclude.has(n.toLowerCase()))
          .map(n => ({ label: n, type: 'variable', detail: 'in select list', boost: 30 }));
      // The FULL statement, not just text before the caret — in
      // "SELECT | FROM orders" the table is defined after the caret, and
      // its columns must still hint (WHERE/HAVING get theirs from before).
      const tables = [...new Set(findAliases(stmtFull).values())];
      if (!getColumns || tables.length === 0) {
        return selectNames.length > 0 ? aliasOpts(new Set()) : null;
      }
      const perTable = await Promise.all(tables.map(t => columnsOf(t, vts, getColumns).catch(() => [])));
      const seen = new Set<string>();
      const merged: SchemaCompletion[] = [];
      for (const cols of perTable) {
        for (const c of cols) {
          const k = c.label.toLowerCase();
          if (!seen.has(k)) { seen.add(k); merged.push(c); }
        }
      }
      if (merged.length === 0) {
        return selectNames.length > 0 ? aliasOpts(new Set()) : null;
      }
      merged.sort((a, b) => {
        const rank = (c: SchemaCompletion) =>
          c.pk ? 0 : c.label.toLowerCase() === 'id' ? 1 : 2;
        const ra = rank(a), rb = rank(b);
        return ra !== rb ? ra - rb : a.label.localeCompare(b.label);
      });
      const mergedOpts = merged.flatMap((c, i) => {
        const ins = c.apply ?? c.label;      // quoted when the bare name would not resolve
        const base: Completion = {
          label: c.label,
          apply: c.apply,
          type: 'property',
          detail: c.detail,
          info: c.info,
          boost: 20 - Math.min(i, 19),
        };
        if (orderByCtx && (c.pk || c.label.toLowerCase() === 'id')) {
          return [
            { label: `${c.label} DESC`, apply: `${ins} DESC`, type: 'property',
              detail: 'newest first', boost: 25 } as Completion,
            base,
          ];
        }
        return [base];
      });
      // select-list names first, minus whatever the catalog already offers
      return [...aliasOpts(new Set(merged.map(c => c.label.toLowerCase()))), ...mergedOpts];
    }
  };
}
