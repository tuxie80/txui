/**
 * Rewrite a plpgsql routine into an instrumented anonymous block, so it can be
 * run and its variable timeline recorded.
 *
 * PostgreSQL has no debugging protocol available by default (`pldbgapi` needs
 * an extension AND `shared_preload_libraries` AND a server restart). What it
 * does have — and MySQL does not — is `DO $$ … $$`, which executes procedural
 * code *anonymously*. That single capability is what makes debugging possible
 * with nothing installed: the instrumented copy is never created as a database
 * object, and the whole run sits inside a transaction that is rolled back, so
 * the routine's writes are undone while the recorded timeline survives.
 *
 * Two findings from testing against a real server shape the output:
 *
 * 1. **The trace accumulates in memory, not in a table.** Writing each step to
 *    the temp table as it happened lost the entire timeline whenever the
 *    routine raised — an uncaught exception aborts the transaction, and the
 *    SELECT meant to retrieve the trace dies with
 *    `current transaction is aborted`. Wrapping the body in
 *    `EXCEPTION WHEN OTHERS` keeps the transaction alive, but a plpgsql
 *    handler rolls that block's *database* writes back to its savepoint, which
 *    would discard the trace rows too. Variable state is **not** rolled back,
 *    so the timeline lives in a `jsonb[]` and is written once after the
 *    handler. A failing run is the one you most want to debug; this is what
 *    makes it debuggable.
 *
 * 2. **`RETURN` cannot be used at all.** `RETURN expr` does not compile in a
 *    `DO` block, and the obvious fix — record the value then `RETURN;` — is
 *    worse: a bare RETURN leaves the *whole* block, skipping the INSERT that
 *    saves the timeline, so every routine that returned a value produced an
 *    empty trace. Each `RETURN expr` becomes a recorded value plus
 *    `EXIT <label>`, which leaves only the instrumented body.
 *
 * 3. **A `record` variable cannot be read before it is assigned.**
 *    `to_jsonb(r)` raises "record r is not assigned yet" on every step before
 *    the loop that populates it, which killed the run outright. Record-typed
 *    variables are captured through a guarded sub-block into a jsonb holder
 *    that falls back to NULL.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { safeIdent } from './sqlIdent.ts';
import type { RoutineDef, RoutineParam } from './routineDdl.ts';
import { skipQuoted } from './routineDdl.ts';

/** Prefix for every identifier this module introduces. */
const P = '__txui';

/**
 * Label on the instrumented block.
 *
 * A bare `RETURN;` returns from the whole `DO` block — including past the
 * `INSERT` that saves the timeline, which silently discarded every trace of
 * any routine that returned a value. `EXIT <label>` leaves only the labelled
 * block, so the insert still runs.
 */
const BODY_LABEL = `${P}_body`;

export interface DebugParamValue {
  name: string;
  /** SQL literal or expression, inserted verbatim. Empty means NULL. */
  value: string;
}

export interface InstrumentOptions {
  /** Values bound to the routine's parameters for this run. */
  values?: DebugParamValue[];
  /**
   * Cap on recorded steps. A loop running a million times would otherwise
   * build a million-element array in the server's memory.
   */
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 5000;

export interface Statement {
  /** 1-based line in the ORIGINAL body. */
  line: number;
  /** Offset just past the terminating `;` in the executable section. */
  end: number;
  text: string;
}

/**
 * Split a plpgsql body into its DECLARE section and executable section.
 *
 * A body is `[DECLARE …] BEGIN … END[;]`. The split matters because the
 * declarations must be extended (with the trace variables and the parameter
 * bindings) while the executable part gets the instrumentation — and because
 * a `;` inside DECLARE is a declaration terminator, not a statement boundary.
 */
export function splitBody(body: string): { declare: string; exec: string; execOffset: number } {
  const src = body;
  let i = 0;
  let declareStart = -1;

  // Find the top-level DECLARE / BEGIN, skipping strings and comments.
  while (i < src.length) {
    const skipped = skipQuoted(src, i);
    if (skipped > i) { i = skipped; continue; }
    const rest = src.slice(i);
    if (declareStart === -1 && /^declare\b/i.test(rest) && atWordStart(src, i)) {
      declareStart = i + 7;
      i += 7;
      continue;
    }
    if (/^begin\b/i.test(rest) && atWordStart(src, i)) {
      const declare = declareStart >= 0 ? src.slice(declareStart, i).trim() : '';
      const execOffset = i + 5;
      // Trim the trailing END / END; that closes this outermost block.
      const exec = stripTrailingEnd(src.slice(execOffset));
      return { declare, exec, execOffset };
    }
    i++;
  }
  // No BEGIN: a single-expression SQL body. Nothing to instrument.
  return { declare: '', exec: '', execOffset: 0 };
}

function atWordStart(src: string, i: number): boolean {
  return i === 0 || !/[\w$]/.test(src[i - 1]);
}

/** Remove the final `END` / `END;` that closes the outermost block. */
function stripTrailingEnd(exec: string): string {
  const m = /\bend\s*;?\s*$/i.exec(exec);
  return m ? exec.slice(0, m.index) : exec;
}

/**
 * Statement boundaries in an executable plpgsql section.
 *
 * A statement ends at a `;` that is not inside parentheses, a string, a
 * comment or a dollar-quoted block. Nested `BEGIN`/`IF`/`LOOP` blocks are NOT
 * excluded — instrumenting inside a loop is the entire point, since that is
 * where values actually change.
 */
export function findStatements(exec: string, startLine = 1): Statement[] {
  const out: Statement[] = [];
  let depth = 0;
  let i = 0;
  let stmtStart = 0;
  let line = startLine;

  while (i < exec.length) {
    const before = i;
    const skipped = skipQuoted(exec, i);
    if (skipped > i) {
      // Count newlines inside the skipped region so line numbers stay true.
      for (let k = before; k < skipped; k++) if (exec[k] === '\n') line++;
      i = skipped;
      continue;
    }
    const ch = exec[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      const text = exec.slice(stmtStart, i + 1).trim();
      // The line reported is where the statement ENDS, because that is where
      // the trace call is injected and therefore what the gutter should
      // highlight as "just executed". Reporting the start line puts the marker
      // on the `FOR` when the value actually changed on the line inside it.
      if (text) out.push({ line, end: i + 1, text });
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Names that can safely be read at any point in the body, with their declared
 * types (the type decides whether a read needs guarding — see isRecordLike).
 */
export function traceableVars(def: RoutineDef, declare: string): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  const push = (name: string, type: string) => {
    if (!out.some(v => v.name === name)) out.push({ name, type });
  };
  for (const p of def.params) {
    if (p.name) push(p.name, p.type);
  }
  // Declarations look like `name type [:= expr];`. A FOR-loop record variable
  // that is NOT declared here is auto-declared by the loop and scoped to it —
  // referencing it outside is a compile error, so only declared names are
  // traced.
  for (const raw of declare.split(';')) {
    const d = raw.trim();
    if (!d) continue;
    const m = /^(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+([\s\S]+)$/.exec(d);
    const name = m?.[1] ?? m?.[2];
    if (!name) continue;
    if (/^(constant|alias)$/i.test(name)) continue;
    const type = (m?.[3] ?? '').split(/:=|\bDEFAULT\b/i)[0].trim();
    push(name, type);
  }
  return out;
}

/** Just the names, in display order. */
export function traceableNames(def: RoutineDef, declare: string): string[] {
  return traceableVars(def, declare).map(v => v.name);
}

/**
 * Is this declared type one that errors when read before assignment?
 *
 * `to_jsonb(r)` on a `record` that has not been assigned yet raises
 * "record r is not assigned yet" — which happens on every step before the
 * loop that populates it, and killed the whole run. Scalars are simply NULL
 * and need no guard.
 */
function isRecordLike(type: string): boolean {
  return /^(record)$/i.test(type.trim()) || /%rowtype\s*$/i.test(type.trim());
}

/** Guarded capture of a record variable into its jsonb holder. */
function captureRecord(name: string): string {
  return `BEGIN ${P}_v_${name} := to_jsonb(${quoteRef(name)}); `
    + `EXCEPTION WHEN OTHERS THEN ${P}_v_${name} := NULL; END;`;
}

/** The plpgsql that records one step. */
function traceStep(
  line: number, names: string[], records: Set<string>, extra?: string,
): string {
  const capture = names.filter(n => records.has(n)).map(captureRecord).join(' ');
  const vars = names.length
    ? `jsonb_build_object(${names.map(n =>
        `'${n}', ${records.has(n) ? `${P}_v_${n}` : `to_jsonb(${quoteRef(n)})`}`).join(', ')})`
    : `'{}'::jsonb`;
  const obj = `jsonb_build_object('n', ${P}_n, 'line', ${line}, 'vars', ${vars}${extra ? `, ${extra}` : ''})`;
  // The cap is checked here rather than after the fact: a runaway loop must not
  // be able to grow the array without bound in the server's memory.
  const step = `IF ${P}_n < ${P}_max THEN ${P}_n := ${P}_n + 1; ${P}_tr := ${P}_tr || ${obj}; END IF;`;
  return capture ? `${capture} ${step}` : step;
}

/** Reference a variable, quoting only when it needs it. */
function quoteRef(name: string): string {
  return safeIdent(name, 'postgres');
}

/**
 * A `RETURN expr;` statement, or null.
 *
 * `RETURN` with a value does not compile inside a `DO` block, so each one is
 * rewritten to record the value and then return bare.
 */
export function returnExpression(stmt: string): string | null {
  const m = /^return\s+([\s\S]+);\s*$/i.exec(stmt.trim());
  if (!m) return null;
  const expr = m[1].trim();
  // `RETURN NEXT` / `RETURN QUERY` are set-returning forms with different
  // semantics; rewriting them as a scalar would be wrong, so they are left
  // alone (and will fail to compile, which is honest).
  if (/^(next|query)\b/i.test(expr)) return null;
  return expr;
}

/**
 * The run, as separate statements.
 *
 * The backend executes these one at a time inside a transaction it always
 * rolls back. Handing it a single blob would mean relying on multi-statement
 * behaviour to decide which result set carries the trace — and, worse, would
 * leave the rollback inside the string that might fail to parse.
 */
export interface RunParts {
  /** The temp sink. */
  setup: string;
  /** The instrumented anonymous block. */
  block: string;
  /** Reads the timeline — the statement whose rows we keep. */
  select: string;
}

export interface InstrumentResult {
  /** The whole run as one script, for "show generated SQL". Not executed. */
  sql: string;
  /** The statements the backend actually runs. */
  parts: RunParts;
  /** Names being watched, in display order. */
  watched: string[];
  /** Statement lines that will report, for the gutter. */
  lines: number[];
  /** Set when the body could not be instrumented, with the reason. */
  unsupported?: string;
}

/**
 * Build the instrumented debug run for a routine.
 *
 * The caller executes `sql` inside a transaction and rolls back afterwards;
 * the trace is SELECTed before the rollback, which is what lets the timeline
 * survive while the routine's writes are discarded.
 */
export function instrumentPlpgsql(
  def: RoutineDef,
  opts: InstrumentOptions = {},
): InstrumentResult {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const { declare, exec, execOffset } = splitBody(def.body);
  // findStatements counts from the start of the executable section, but the
  // gutter highlights the ORIGINAL body — so offset by the lines consumed by
  // the DECLARE section and the BEGIN.
  const execLine = countLines(def.body.slice(0, execOffset));

  const empty: RunParts = { setup: '', block: '', select: '' };
  if (!exec.trim()) {
    return {
      sql: '', parts: empty, watched: [], lines: [],
      unsupported: 'This routine has no BEGIN … END block to step through — '
        + 'a single-expression SQL body executes as one statement.',
    };
  }
  if (/\breturn\s+(next|query)\b/i.test(exec)) {
    return {
      sql: '', parts: empty, watched: [], lines: [],
      unsupported: 'Set-returning routines (RETURN NEXT / RETURN QUERY) cannot be '
        + 'run as an anonymous block, so they cannot be stepped through yet.',
    };
  }

  const vars = traceableVars(def, declare);
  const watched = vars.map(v => v.name);
  const records = new Set(vars.filter(v => isRecordLike(v.type)).map(v => v.name));
  const stmts = findStatements(exec, execLine);
  const lines: number[] = [];

  // Rebuild the executable section with a trace append after each statement.
  let outBody = '';
  let cursor = 0;
  for (const s of stmts) {
    const original = exec.slice(cursor, s.end);
    const ret = returnExpression(s.text);
    if (ret) {
      // Record the returned value, then return bare.
      const lead = original.slice(0, original.length - s.text.length);
      // `RETURN;` would leave the whole DO block and skip the INSERT that
      // saves the timeline; EXIT leaves only the labelled body.
      outBody += lead
        + traceStep(s.line, watched, records, `'ret', to_jsonb(${ret})`)
        + ` EXIT ${BODY_LABEL};`;
    } else {
      outBody += original + '\n' + traceStep(s.line, watched, records);
    }
    lines.push(s.line);
    cursor = s.end;
  }
  outBody += exec.slice(cursor);

  // Parameters become locals initialised to the supplied values.
  const bound = new Map((opts.values ?? []).map(v => [v.name, v.value]));
  const paramDecls = def.params
    .filter(p => p.name)
    .map((p: RoutineParam) => {
      const v = (bound.get(p.name) ?? '').trim();
      return `  ${quoteRef(p.name)} ${p.type}${v ? ` := ${v}` : ''};`;
    })
    .join('\n');

  const decls = [
    paramDecls,
    declare ? declare.split('\n').map(l => `  ${l.trim()}`).join('\n') : '',
    `  ${P}_tr jsonb[] := '{}';`,
    `  ${P}_n int := 0;`,
    `  ${P}_max int := ${maxSteps};`,
    // One holder per record variable, filled by a guarded capture each step.
    ...[...records].map(n => `  ${P}_v_${n} jsonb;`),
  ].filter(Boolean).join('\n');

  // The tag must not occur in the body, or the block terminates early.
  const tag = pickTag(outBody);

  const setup = `CREATE TEMP TABLE ${P}_trace(step jsonb) ON COMMIT DROP`;
  const select = `SELECT step FROM ${P}_trace ORDER BY (step->>'n')::int`;
  const block = [
    `DO ${tag}`,
    'DECLARE',
    decls,
    'BEGIN',
    // The inner block is what the handler guards; the INSERT below sits
    // OUTSIDE it, so it still runs after an exception was caught.
    `  <<${BODY_LABEL}>>`,
    '  BEGIN',
    indent(outBody, 2),
    '  EXCEPTION WHEN OTHERS THEN',
    `    ${P}_n := ${P}_n + 1;`,
    `    ${P}_tr := ${P}_tr || jsonb_build_object('n', ${P}_n, 'line', -1, `
      + `'error', SQLERRM, 'sqlstate', SQLSTATE);`,
    '  END;',
    `  INSERT INTO ${P}_trace(step) SELECT unnest(${P}_tr);`,
    'END',
    tag,
  ].join('\n');

  return {
    sql: `${setup};\n${block};\n${select};`,
    parts: { setup, block, select },
    watched, lines,
  };
}

/** Number of the line at the end of `text`, 1-based. */
function countLines(text: string): number {
  let n = 1;
  for (const ch of text) if (ch === '\n') n++;
  return n;
}

function indent(text: string, by: number): string {
  const pad = ' '.repeat(by);
  return text.split('\n').map(l => (l.trim() ? pad + l : l)).join('\n');
}

/** A dollar tag that cannot appear in the generated body. */
export function pickTag(body: string): string {
  for (const t of [`$${P}_dbg$`, `$${P}_d2$`, `$${P}_d3$`]) {
    if (!body.includes(t)) return t;
  }
  for (let n = 1; ; n++) {
    const t = `$${P}_d${n}x$`;
    if (!body.includes(t)) return t;
  }
}

// ── the recorded timeline ────────────────────────────────────────────────────

export interface TraceStep {
  n: number;
  /** Line in the original body, or -1 for the exception pseudo-step. */
  line: number;
  vars: Record<string, unknown>;
  /** Present on the step that returned. */
  ret?: unknown;
  error?: string;
  sqlstate?: string;
}

/** Parse the rows the debug run returned. */
export function parseTrace(rows: unknown[]): TraceStep[] {
  const out: TraceStep[] = [];
  for (const raw of rows) {
    const o = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    out.push({
      n: Number(r.n) || out.length + 1,
      line: Number(r.line ?? -1),
      vars: (r.vars as Record<string, unknown>) ?? {},
      ret: r.ret,
      error: typeof r.error === 'string' ? r.error : undefined,
      sqlstate: typeof r.sqlstate === 'string' ? r.sqlstate : undefined,
    });
  }
  return out.sort((a, b) => a.n - b.n);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Which watched variables changed between two steps.
 *
 * Stepping through a forty-variable routine is unreadable unless the ones that
 * just moved are marked, so this is what the UI highlights.
 */
export function changedVars(prev: TraceStep | undefined, cur: TraceStep): Set<string> {
  const changed = new Set<string>();
  if (!cur) return changed;
  for (const [k, v] of Object.entries(cur.vars)) {
    const before = prev?.vars[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) changed.add(k);
  }
  return changed;
}

/** Display form for a traced value. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
