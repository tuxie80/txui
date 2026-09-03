/**
 * Rewrite a MySQL stored routine into an instrumented copy that records its
 * own execution, so the debugger can replay the timeline afterwards.
 *
 * MySQL has no debugging protocol — every tool that advertises MySQL routine
 * debugging (dbForge, Aqua Data Studio) does it this way: parse the body,
 * inject trace calls, CREATE the rewritten routine under a scratch name, run
 * it, read the trace back. The PostgreSQL debugger (plpgsqlInstrument.ts)
 * could stay anonymous because PG has `DO $$ … $$`; MySQL has no anonymous
 * block, so the copy is a real object in a nominated scratch schema and
 * cleanup is the caller's job — `parts.cleanup` in a finally, `parts.sweep`
 * at startup for whatever a crash left behind.
 *
 * Properties the generated SQL relies on:
 *
 * 1. **One trace row per variable per step, NULLs included.** A variable that
 *    is NULL still inserts a row with val NULL — a timeline that omitted NULLs
 *    would make "never assigned" indistinguishable from "assigned NULL", which
 *    is exactly the difference a debugger exists to show. CAST(x AS CHAR)
 *    keeps NULL as NULL and stringifies every scalar; the few types that
 *    cannot cast (GEOMETRY) abort the run — documented, not worked around.
 *
 * 2. **Line numbers are stamped at generation time.** The injected calls shift
 *    every subsequent line of the copy, so the copy's own numbering is
 *    useless; each trace row carries the line the statement ENDED on in the
 *    ORIGINAL body (1-based within RoutineDef.body), which is where the trace
 *    fires and therefore what the gutter should highlight.
 *
 * 3. **Only in-scope variables are referenced.** DECLARE is block-scoped in
 *    MySQL, so referencing a variable outside its BEGIN…END block is a
 *    compile error in the copy. The walker keeps a scope stack and each
 *    injected call names only the variables visible at that point.
 *
 * 4. **A failing run stays debuggable.** An EXIT HANDLER FOR SQLEXCEPTION is
 *    appended after the outer block's own declarations (MySQL requires
 *    handlers to come last in the declare section), recording SQLSTATE and
 *    the error text as the final trace rows before RESIGNALing, so the CALL
 *    still fails honestly. Unlike PG there is no transaction to abort the
 *    read-back — but also no rollback of the routine's side effects: the
 *    copy's writes COMMIT. That is a real difference from the PostgreSQL
 *    debugger and the UI must not pretend otherwise.
 *
 * 5. **The cap is enforced inside the loop, not after it.** Every injected
 *    step is guarded by `IF @__txui_dbg_seq < N`, so a 100k-iteration loop
 *    cannot write 100k rows; a truncation marker row is appended by the run
 *    wrapper when the counter reached the cap.
 *
 * What a linear trace does NOT capture (do not fake fidelity here):
 *
 * - **Cursor loops.** OPEN/FETCH/CLOSE trace as ordinary statements, but a
 *   CONTINUE HANDLER FOR NOT FOUND transfers control implicitly; the timeline
 *   shows the statements that ran, not why they stopped.
 * - **User handler bodies in the OUTER declare section are not traced** —
 *   injecting executable statements there would precede our own DECLARE,
 *   which is a compile error. Handler bodies of INNER blocks are traced.
 * - **Warnings and NOT FOUND** are not recorded, only SQLEXCEPTION.
 * - Functions on binlog-enabled servers: creating the copy needs the same
 *   DETERMINISTIC / log_bin_trust_function_creators story as the original.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { safeIdent, sqlLiteral, unquoteIdent } from './sqlIdent.ts';
import { renderParam, skipQuoted } from './routineDdl.ts';
import type { RoutineDef, RoutineParam } from './routineDdl.ts';
import type { DebugParamValue } from './plpgsqlInstrument.ts';

export { changedVars, formatValue } from './plpgsqlInstrument.ts';

/** Prefix for the scratch copy name and every session variable we inject. */
const P = '__txui_dbg';

/**
 * The step counter lives in a session variable so the copy, the run wrapper
 * and the error handler all share it without declaring anything.
 */
const SEQ = `@${P}_seq`;

/** Trace `var` values that mean something other than "a watched variable". */
const VAR_STEP = '__txui_step';
const VAR_RETURN = '__txui_return';
const VAR_ERROR = '__txui_error';
const VAR_SQLSTATE = '__txui_sqlstate';
const VAR_TRUNCATED = '__txui_truncated';

/**
 * Pseudo-lines for rows that were not fired by a body statement. Negative
 * numbers cannot collide with a real (1-based) source line; LINE_ENTRY is the
 * step recorded before the first statement runs.
 */
export const LINE_ENTRY = 0;
export const LINE_ERROR = -1;
export const LINE_OUT = -2;
export const LINE_TRUNCATED = -3;

export const DEFAULT_MAX_STEPS = 5000;

export interface MysqlInstrumentOptions {
  /** Schema the instrumented copy and the trace table are created in. */
  scratchSchema: string;
  /** Trace table name inside the scratch schema. */
  traceTable?: string;
  /** Identifies this run; the trace is read back and deleted by it. */
  runId: string;
  /** Cap on recorded steps — a runaway loop must not fill the server. */
  maxSteps?: number;
  /** Values bound to the routine's parameters for this run. */
  values?: DebugParamValue[];
}

export interface MysqlRunParts {
  /** Trace table + stale-copy drop, before the CREATE. */
  setup: string[];
  /** The instrumented copy (CREATE PROCEDURE/FUNCTION). */
  create: string;
  /** Counter init, OUT/INOUT binding, the CALL, truncation + OUT capture. */
  run: string[];
  /** Reads the timeline — the statement whose rows we keep. */
  select: string;
  /** Drop the copy, delete this run's trace rows — run in a finally. */
  cleanup: string[];
  /** Startup crash-sweep: find leftover copies, purge old trace rows. */
  sweep: string[];
}

export interface MysqlInstrumentResult {
  /** The whole run as one script, for "show generated SQL". Not executed. */
  sql: string;
  /** The statements the backend actually runs, in order, unterminated. */
  parts: MysqlRunParts;
  /** Variables traced at least once, in display order. */
  watched: string[];
  /** Original body lines that will report, for the gutter. */
  lines: number[];
  /** The scratch name of the instrumented copy. */
  copyName: string;
  /** Caveats worth showing the user (e.g. a user error handler shadows ours). */
  notes: string[];
  /** Set when the body could not be instrumented, with the reason. */
  unsupported?: string;
}

// ── tokenizer ────────────────────────────────────────────────────────────────

interface Tok {
  kind: 'word' | 'str' | 'sym';
  text: string;
  start: number;
  end: number;
  /** 1-based line of `start` in the source. */
  line: number;
}

/**
 * Words, strings and symbols, with line numbers.
 *
 * Comments vanish (their offsets still delimit statement text) and quoted
 * regions come through as single opaque tokens, so the walker below can never
 * mistake a `;` or an `END` inside a string for structure. `"…"` is treated
 * as a string, not an identifier: ANSI_QUOTES is off by default, and the safe
 * direction is to NOT recognise a double-quoted DECLARE name (an untraced
 * variable) rather than to misread a string as one.
 */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const bump = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] === '\n') line++;
  };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { bump(i, i + 1); i++; continue; }
    // Comments and quoted regions: same rules as routineDdl.skipQuoted, so
    // this splitter cannot disagree with the DDL parser about strings.
    if ((ch === '-' && src[i + 1] === '-') || ch === '#'
      || (ch === '/' && src[i + 1] === '*') || ch === "'" || ch === '"') {
      const end = skipQuoted(src, i);
      if (ch === "'" || ch === '"') toks.push({ kind: 'str', text: src.slice(i, end), start: i, end, line });
      bump(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipQuoted(src, i);
      toks.push({ kind: 'word', text: src.slice(i, end), start: i, end, line });
      bump(i, end);
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      toks.push({ kind: 'word', text: src.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.$]/.test(src[j])) j++;
      toks.push({ kind: 'str', text: src.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    toks.push({ kind: 'sym', text: ch, start: i, end: i + 1, line });
    i++;
  }
  return toks;
}

// ── body walker ──────────────────────────────────────────────────────────────

export interface MysqlStatement {
  /** 1-based line in the ORIGINAL body where the statement ends. */
  line: number;
  /** Offset of the first token, in the original body. */
  start: number;
  /** Offset just past the terminating `;` (or past the last token). */
  end: number;
  /** Whether the statement carried its own semicolon. */
  hadSemi: boolean;
  text: string;
  /**
   * 'declare' — a variable/cursor/condition/handler declaration;
   * 'return'  — a RETURN with an expression (its trace must fire BEFORE it,
   *             since nothing after RETURN ever executes);
   * 'statement' — everything else, including block ENDs.
   */
  kind: 'statement' | 'declare' | 'return';
  /** Variable names in scope immediately after this statement, outer first. */
  vars: string[];
  /** Offset of the RETURN keyword and its expression, when kind is 'return'. */
  returnAt?: number;
  returnExpr?: string;
  /**
   * True for statements inside the OUTER block's declare section (including
   * handler bodies there): no trace may be injected at these, because our own
   * DECLARE must come before any executable statement of the outer block.
   */
  inDeclareSection: boolean;
}

interface Construct {
  kind: 'begin' | 'if' | 'case' | 'while' | 'repeat' | 'loop';
  /** Opened inside the outer declare section (a handler body's BEGIN…END). */
  fromDeclare: boolean;
  /** A BEGIN block accepts DECLAREs only until its first real statement. */
  acceptsDeclares: boolean;
}

interface WalkResult {
  statements: MysqlStatement[];
  /** The body is wrapped in its own BEGIN…END (vs a single bare statement). */
  outerBlock: boolean;
  /** Offset where our DECLARE + entry trace go: end of the declare section. */
  sectionEnd: number;
  /** False when the outer block already handles SQLEXCEPTION (a duplicate
   *  handler declaration would be a compile error in the copy). */
  ownHandlerOk: boolean;
  error?: string;
}

/**
 * Parse a routine body into statements with scope tracking.
 *
 * The splitter's one rule, inherited from routineDdl: never split on `;`
 * without tracking quoting and nesting. Every `;` at paren depth 0 ends a
 * statement — including the ones inside IF branches and loop bodies, because
 * injecting inside loops is the whole point — and every such position is a
 * legal statement position in MySQL's grammar (branch bodies are statement
 * LISTS), so no lookahead for ELSE/UNTIL/WHEN is needed. The only illegal
 * injection point is *between two DECLAREs* or before our own handler
 * declaration, which the declare-section bookkeeping below prevents.
 *
 * Construct tracking exists for one reason: matching ENDs to their openers.
 * `END` can close a BEGIN (scope pop), an IF/CASE/loop (no scope change), or
 * a CASE *expression* (`SET x = CASE … END;`) — only a stack tells these
 * apart; peeking at the word after END cannot (a CASE expression's END is
 * followed by `;`, exactly like a block's).
 */
function walkBody(body: string, params: string[]): WalkResult {
  const toks = tokenize(body);
  const scopes: string[][] = [params.filter(Boolean)];
  const constructs: Construct[] = [];
  const statements: MysqlStatement[] = [];
  let error: string | undefined;
  let outerBlock = false;
  let outerClosed = false;
  let declareSection = false;
  let declareConstructs = 0;
  let sectionEnd = -1;
  let ownHandlerOk = true;

  let paren = 0;
  let chunkFirstTok = -1;
  let chunkStart = true;
  let kind: MysqlStatement['kind'] = 'statement';
  let declareNames: string[] = [];
  let declareVar = false;
  let returnTok: Tok | null = null;
  let afterEnd = false;
  let bodyStarted = false;
  let chunkClosedDeclare = false;

  const scopeVars = (): string[] => {
    const out: string[] = [];
    for (const s of scopes) for (const v of s) if (!out.includes(v)) out.push(v);
    return out;
  };

  const pushConstruct = (k: Construct['kind']) => {
    const fromDeclare = declareSection && (kind === 'declare' || declareConstructs > 0);
    constructs.push({ kind: k, fromDeclare, acceptsDeclares: k === 'begin' });
    if (fromDeclare) declareConstructs++;
  };

  /** An IF is the statement form only if a depth-0 THEN precedes the next
   *  `;` — the IF(a,b,c) function never has one. */
  const ifIsStatement = (from: number): boolean => {
    let d = 0;
    for (let k = from + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t.kind === 'sym') {
        if (t.text === '(') d++;
        else if (t.text === ')') d--;
        else if (t.text === ';' && d === 0) return false;
      } else if (t.kind === 'word' && d === 0 && /^then$/i.test(t.text)) {
        return true;
      }
    }
    return false;
  };

  /** `DECLARE … HANDLER FOR SQLEXCEPTION` within the chunk starting at `from`. */
  const handlerTargetsSqlException = (from: number): boolean => {
    let d = 0;
    let sawHandler = false;
    for (let k = from; k < toks.length; k++) {
      const t = toks[k];
      if (t.kind === 'sym') {
        if (t.text === '(') d++;
        else if (t.text === ')') d--;
        else if (t.text === ';' && d === 0) return false;
      } else if (t.kind === 'word') {
        if (/^handler$/i.test(t.text)) sawHandler = true;
        else if (sawHandler && /^sqlexception$/i.test(t.text)) return true;
      }
    }
    return false;
  };

  const tryDeclare = (ti: number) => {
    const top = constructs[constructs.length - 1];
    // DECLARE is legal only at the start of a BEGIN block. Anywhere else the
    // original would not compile either, so the word is ignored — safe.
    if (!top || top.kind !== 'begin' || !top.acceptsDeclares) return;
    kind = 'declare';
    const w1 = toks[ti + 1];
    if (w1 && w1.kind === 'word' && /^(exit|continue|undo)$/i.test(w1.text)) {
      // A handler declaration: no variable, but a SQLEXCEPTION handler in the
      // OUTER block makes ours a duplicate — the copy would not compile.
      if (declareSection && constructs.length === 1 && handlerTargetsSqlException(ti)) {
        ownHandlerOk = false;
      }
      return;
    }
    // `DECLARE name [, name]… type [DEFAULT …]`, unless the word after the
    // names is CONDITION or CURSOR (not readable variables).
    const names: string[] = [];
    let j = ti + 1;
    while (j < toks.length) {
      const nt = toks[j];
      if (nt.kind !== 'word') break;
      names.push(nt.text[0] === '`' ? unquoteIdent(nt.text) : nt.text);
      const sep = toks[j + 1];
      if (sep?.kind === 'sym' && sep.text === ',') { j += 2; continue; }
      j++;
      break;
    }
    const afterW = toks[j]?.kind === 'word' ? toks[j].text.toUpperCase() : '';
    if (names.length && afterW !== 'CONDITION' && afterW !== 'CURSOR') {
      declareNames = names;
      declareVar = true;
    }
  };

  const closeChunk = (endOff: number, exprEnd: number, line: number, hadSemi: boolean) => {
    if (chunkFirstTok < 0) return;
    const start = toks[chunkFirstTok].start;
    const raw = body.slice(start, endOff);
    if (!raw.trim()) { chunkFirstTok = -1; return; }

    // A bare `BEGIN;` is START TRANSACTION, not a block — undo the push.
    // (`label: BEGIN` stays a block; its text is not exactly "begin".)
    if (/^begin$/i.test(raw.trim())) {
      const c = constructs[constructs.length - 1];
      if (c && c.kind === 'begin') {
        constructs.pop();
        if (c.fromDeclare) declareConstructs--;
        if (scopes.length > 1) scopes.pop();
        if (outerBlock && constructs.length === 0 && statements.length === 0) {
          outerBlock = false;
          declareSection = false;
          sectionEnd = -1;
        }
      }
    }

    // The variables a declaration introduces are visible in its own trace.
    if (kind === 'declare' && declareVar) {
      const scope = scopes[scopes.length - 1];
      for (const n of declareNames) if (!scope.includes(n)) scope.push(n);
    }

    const retExpr = returnTok ? body.slice(returnTok.end, exprEnd).trim() : '';
    const stmtKind: MysqlStatement['kind'] = returnTok && retExpr ? 'return' : kind;
    const stmt: MysqlStatement = {
      line, start, end: endOff, hadSemi, text: raw.trimEnd(),
      kind: stmtKind, vars: scopeVars(), inDeclareSection: false,
    };
    if (stmtKind === 'return' && returnTok) {
      stmt.returnAt = returnTok.start;
      stmt.returnExpr = retExpr;
    }

    // The outer declare section runs until the first chunk that is neither a
    // declaration nor part of one (a handler's BEGIN…END spans many chunks).
    const belongs = declareSection
      && (kind === 'declare' || declareConstructs > 0 || chunkClosedDeclare);
    stmt.inDeclareSection = belongs;
    if (belongs) sectionEnd = endOff;
    else if (declareSection) declareSection = false;

    // Once a block holds a real statement, later DECLAREs in it are invalid;
    // stop recognising them so a stray one cannot corrupt the scope stack.
    // Chunks inside the declare section are exempt: a handler body's
    // statements must not close the OUTER block's declare section.
    if (kind !== 'declare' && !belongs) {
      for (const c of constructs) if (c.kind === 'begin') c.acceptsDeclares = false;
    }

    statements.push(stmt);
    chunkFirstTok = -1;
    chunkStart = true;
    kind = 'statement';
    declareNames = [];
    declareVar = false;
    returnTok = null;
    afterEnd = false;
    chunkClosedDeclare = false;
  };

  for (let ti = 0; ti < toks.length && !error && !outerClosed; ti++) {
    const t = toks[ti];
    if (chunkFirstTok < 0) chunkFirstTok = ti;

    if (t.kind === 'sym') {
      if (t.text === ';' && paren === 0) {
        closeChunk(t.end, t.start, t.line, true);
        continue; // closeChunk leaves chunkStart=true for the next statement
      }
      if (t.text === '(') paren++;
      else if (t.text === ')') { if (paren > 0) paren--; }
      chunkStart = false;
      continue;
    }
    if (t.kind === 'str') { chunkStart = false; continue; }

    // Word. `@x` makes the next word a variable name, never a keyword.
    const prev = ti > 0 ? toks[ti - 1] : null;
    const prevWord = prev?.kind === 'word' ? prev.text.toUpperCase() : '';
    if (paren === 0 && !afterEnd && !(prev?.kind === 'sym' && prev.text === '@')
      && t.text[0] !== '`') {
      // A label at statement start: `lbl: BEGIN`, `lbl: LOOP`. Skip both
      // tokens; the label stays part of the chunk's text and the word after
      // the colon is still the chunk's lead.
      if (chunkStart && toks[ti + 1]?.kind === 'sym' && toks[ti + 1].text === ':') {
        ti++;
        continue;
      }
      const w = t.text.toUpperCase();
      if (w === 'BEGIN' && prevWord !== 'XA') {
        pushConstruct('begin');
        scopes.push([]);
        if (!bodyStarted && statements.length === 0) {
          outerBlock = true;
          declareSection = true;
          // MariaDB spells it BEGIN NOT ATOMIC — the declare section, and so
          // our injection point, starts after ATOMIC.
          let e = t.end;
          if (/^not$/i.test(toks[ti + 1]?.text ?? '') && /^atomic$/i.test(toks[ti + 2]?.text ?? '')) {
            e = toks[ti + 2].end;
          }
          sectionEnd = e;
        }
      } else if (w === 'END') {
        const c = constructs.pop();
        if (!c) {
          if (outerBlock) outerClosed = true;
          else error = 'The routine body could not be parsed: an END has no matching BEGIN/IF/CASE/loop.';
          continue;
        }
        if (c.fromDeclare) { declareConstructs--; chunkClosedDeclare = true; }
        if (c.kind === 'begin' && scopes.length > 1) scopes.pop();
        // When the outer BEGIN closes, the body is over — whatever follows
        // (a label, a stray semicolon) is not a statement.
        if (outerBlock && constructs.length === 0) { outerClosed = true; continue; }
        // Whatever follows END in this chunk (IF/LOOP/CASE/WHILE/REPEAT or a
        // label) is a closer, not a new construct — `END CASE` must not push.
        afterEnd = true;
      } else if (w === 'IF' && ifIsStatement(ti)) {
        pushConstruct('if');
      } else if (w === 'CASE') {
        pushConstruct('case');
      } else if (w === 'WHILE' || w === 'REPEAT') {
        // Reserved words: they can only be the loop statement, wherever they
        // appear (`END WHILE` is suppressed by afterEnd above).
        pushConstruct(w.toLowerCase() as Construct['kind']);
      } else if (w === 'LOOP'
        && (chunkStart || prevWord === 'THEN' || prevWord === 'ELSE' || prevWord === 'DO'
          || prevWord === 'BEGIN' || (prev?.kind === 'sym' && prev.text === ':'))) {
        // LOOP is non-reserved (a table may be called `loop`), so it is only
        // recognised where a statement can begin: chunk lead, after
        // BEGIN/THEN/ELSE/DO, or after a label.
        pushConstruct('loop');
      } else if (w === 'DECLARE') {
        tryDeclare(ti);
      } else if (w === 'RETURN' && !returnTok) {
        returnTok = t;
      }
    }
    chunkStart = false;
    bodyStarted = true;
  }

  // A trailing statement without its semicolon (a bare `RETURN x` body).
  if (!error && !outerClosed && chunkFirstTok >= 0 && toks.length) {
    const last = toks[toks.length - 1];
    closeChunk(last.end, last.end, last.line, false);
  }

  if (!error) {
    if (outerBlock && !outerClosed) {
      error = 'The routine body opens a BEGIN…END block that never closes — the definition looks truncated.';
    } else if (constructs.length) {
      error = 'The routine body could not be parsed: unbalanced IF/CASE/loop blocks.';
    }
  }
  return { statements, outerBlock, sectionEnd, ownHandlerOk, error };
}

/**
 * The statements of a routine body, with original line numbers and the
 * variables in scope at each one. Exported for tests and for any UI that
 * wants the map without the generated SQL.
 */
export function findMysqlStatements(body: string, params: string[] = []): MysqlStatement[] {
  return walkBody(body, params).statements;
}

// ── the instrumented run ─────────────────────────────────────────────────────

/** A user variable that receives an OUT/INOUT parameter across the CALL. */
function paramVar(name: string): string {
  const raw = `${P}_p_${name}`;
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(raw) ? `@${raw}` : `@\`${raw.replace(/`/g, '``')}\``;
}

/**
 * Build the instrumented debug run for a MySQL procedure or function.
 *
 * The caller executes `parts` in order — setup, create, run, select, and
 * cleanup in a finally — and keeps the rows of `select`. Everything is a
 * separate, unterminated statement: the backend must not rely on
 * multi-statement execution deciding which result set carries the trace.
 */
export function instrumentMysqlRoutine(
  def: RoutineDef,
  opts: MysqlInstrumentOptions,
): MysqlInstrumentResult {
  const notes: string[] = [];
  const empty: MysqlRunParts = { setup: [], create: '', run: [], select: '', cleanup: [], sweep: [] };
  const fail = (reason: string): MysqlInstrumentResult => ({
    sql: '', parts: empty, watched: [], lines: [], copyName: '', notes, unsupported: reason,
  });

  if (def.kind !== 'procedure' && def.kind !== 'function') {
    return fail(`Only procedures and functions can be debugged — a ${def.kind} `
      + 'has no callable body, and a copy of one would not fire.');
  }
  if (!def.body.trim()) return fail('The routine has an empty body.');
  if (!opts.scratchSchema?.trim()) return fail('No scratch schema was nominated for the instrumented copy.');
  if (!opts.runId) return fail('A run id is required to keep concurrent traces apart.');

  const maxSteps = Math.max(1, Math.floor(opts.maxSteps ?? DEFAULT_MAX_STEPS));
  // MySQL identifiers cap at 64 characters; the prefix is 11 of them.
  let copyName = `${P}_${def.name}`;
  if (copyName.length > 64) {
    copyName = copyName.slice(0, 64);
    notes.push(`The routine name is long; the copy is truncated to ${copyName}.`);
  }

  const paramNames = def.params.map(p => p.name).filter(Boolean);
  const walk = walkBody(def.body, paramNames);
  if (walk.error) return fail(walk.error);

  const qSchema = safeIdent(opts.scratchSchema, 'mysql');
  const tableRef = `${qSchema}.${safeIdent(opts.traceTable ?? '__txui_trace', 'mysql')}`;
  const copyRef = `${qSchema}.${safeIdent(copyName, 'mysql')}`;
  const runLit = sqlLiteral(opts.runId, 'mysql');
  const kindSql = def.kind.toUpperCase();

  const castRow = (name: string): [string, string] =>
    [name, `CAST(${safeIdent(name, 'mysql')} AS CHAR)`];

  /**
   * One traced step: bump the counter and write one row per variable, all
   * sharing the step number. The cap is checked here, not after the fact —
   * a runaway loop must not be able to write rows without bound. A step with
   * no in-scope variables still writes a sentinel row, or the step would be
   * invisible in the timeline and its line never marked executed.
   */
  const traceBlock = (line: number, rows: Array<[string, string]>): string => {
    const vals = rows.length
      ? rows.map(([v, e]) => `(${runLit}, ${SEQ}, ${line}, ${sqlLiteral(v, 'mysql')}, ${e})`)
        .join(',\n    ')
      : `(${runLit}, ${SEQ}, ${line}, '${VAR_STEP}', NULL)`;
    return `IF ${SEQ} < ${maxSteps} THEN\n`
      + `  SET ${SEQ} = ${SEQ} + 1;\n`
      + `  INSERT INTO ${tableRef} (run, seq, line, var, val) VALUES\n`
      + `    ${vals};\n`
      + `END IF;`;
  };

  // Recorded before RESIGNAL so the CALL still fails honestly while the trace
  // carries the cause. Unguarded by the step cap: the error row is the one a
  // truncated run needs most.
  const handlerDecl = `DECLARE EXIT HANDLER FOR SQLEXCEPTION\n`
    + `BEGIN\n`
    + `  GET DIAGNOSTICS CONDITION 1\n`
    + `    @${P}_sqlstate = RETURNED_SQLSTATE,\n`
    + `    @${P}_errno = MYSQL_ERRNO,\n`
    + `    @${P}_errmsg = MESSAGE_TEXT;\n`
    + `  INSERT INTO ${tableRef} (run, seq, line, var, val) VALUES\n`
    + `    (${runLit}, ${SEQ} + 1, ${LINE_ERROR}, '${VAR_ERROR}', @${P}_errmsg),\n`
    + `    (${runLit}, ${SEQ} + 1, ${LINE_ERROR}, '${VAR_SQLSTATE}', @${P}_sqlstate);\n`
    + `  RESIGNAL;\n`
    + `END;`;

  // The entry step shows parameter and DEFAULT-initialised values before the
  // first statement runs — the values a post-statement trace would be too
  // late to explain.
  const sectionStmts = walk.statements.filter(s => s.inDeclareSection);
  const entryVars = sectionStmts.length
    ? sectionStmts[sectionStmts.length - 1].vars
    : paramNames;
  const entryTrace = traceBlock(LINE_ENTRY, entryVars.map(castRow));

  if (!walk.ownHandlerOk) {
    notes.push('The routine already declares a HANDLER FOR SQLEXCEPTION in its outer '
      + 'block, so no error row can be recorded — the routine’s own handler decides '
      + 'what an error does.');
  }
  const declHead = walk.ownHandlerOk ? `${handlerDecl}\n${entryTrace}` : entryTrace;

  interface Injection { at: number; order: number; text: string }
  const injections: Injection[] = [];
  const lines: number[] = [];

  if (walk.outerBlock) {
    injections.push({ at: walk.sectionEnd, order: 0, text: `\n${declHead}\n` });
  }

  const stmts = walk.statements;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.inDeclareSection) continue;
    if (s.kind === 'return' && s.returnAt !== undefined && s.returnExpr) {
      // Nothing after RETURN executes, so the trace — including the returned
      // value — goes BEFORE it, inside whatever branch the RETURN sits in.
      const rows: Array<[string, string]> =
        [[VAR_RETURN, `CAST((${s.returnExpr}) AS CHAR)`], ...s.vars.map(castRow)];
      injections.push({ at: s.returnAt, order: 1, text: `${traceBlock(s.line, rows)}\n` });
      if (!s.hadSemi) injections.push({ at: s.end, order: 2, text: ';' });
      lines.push(s.line);
    } else if (s.kind === 'declare') {
      // A trace between two DECLAREs is a compile error ("DECLARE is only
      // allowed at the start of a block"), so only the LAST declaration of a
      // run is traced — which still captures every initial value.
      const next = stmts[i + 1];
      if (next && next.kind === 'declare') continue;
      injections.push({
        at: s.end, order: 1,
        text: `${s.hadSemi ? '' : ';'}\n${traceBlock(s.line, s.vars.map(castRow))}\n`,
      });
      lines.push(s.line);
    } else {
      injections.push({
        at: s.end, order: 1,
        text: `${s.hadSemi ? '' : ';'}\n${traceBlock(s.line, s.vars.map(castRow))}\n`,
      });
      lines.push(s.line);
    }
  }

  injections.sort((a, b) => a.at - b.at || a.order - b.order);
  let bodyOut = '';
  let cursor = 0;
  for (const inj of injections) {
    bodyOut += def.body.slice(cursor, inj.at) + inj.text;
    cursor = inj.at;
  }
  bodyOut += def.body.slice(cursor);

  // A body that is not its own BEGIN…END (a bare `RETURN x`, one statement)
  // is wrapped so the handler declaration has somewhere legal to live.
  const newBody = walk.outerBlock
    ? bodyOut
    : `BEGIN\n${declHead}\n${bodyOut}\nEND`;

  // MySQL function parameters carry no mode: `CREATE FUNCTION f(IN x INT)`
  // is a syntax error (8.4, verified live by dev/probe_mysql_debugger.mjs),
  // while procedures accept — and default to — the explicit IN. renderParam
  // owns the rule (it takes the routine kind); the copy just passes it.
  const paramList = def.params
    .map(p => renderParam(p, 'mysql', def.kind))
    .join(', ');
  const create = [
    `CREATE ${kindSql} ${copyRef}(${paramList})`,
    // A function is not valid without its RETURNS — and it must precede the
    // characteristics (DETERMINISTIC & friends), which the server rejects
    // before it (8.4, verified live by dev/probe_mysql_debugger.mjs).
    ...(def.kind === 'function' && def.returns ? [`RETURNS ${def.returns}`] : []),
    ...def.characteristics,
    newBody,
  ].join('\n');

  const bound = new Map((opts.values ?? []).map(v => [v.name, v.value]));
  const boundValue = (name: string): string => (bound.get(name) ?? '').trim() || 'NULL';
  const isOut = (p: RoutineParam) => p.mode === 'OUT' || p.mode === 'INOUT';
  const args = def.params
    .map(p => (isOut(p) && p.name ? paramVar(p.name) : boundValue(p.name)))
    .join(', ');

  const run: string[] = [`SET ${SEQ} = 0`];
  for (const p of def.params) {
    if (isOut(p) && p.name) run.push(`SET ${paramVar(p.name)} = ${boundValue(p.name)}`);
  }
  // OUT/INOUT parameters cross the CALL in session variables; a function's
  // return value additionally comes back as this statement's result set.
  run.push(def.kind === 'function'
    ? `SELECT ${copyRef}(${args}) AS \`${P}_ret\``
    : `CALL ${copyRef}(${args})`);
  // The honest truncation marker: written by the wrapper only when the counter
  // actually reached the cap, so a short run carries no scar.
  run.push(`INSERT INTO ${tableRef} (run, seq, line, var, val)\n`
    + `SELECT ${runLit}, ${SEQ} + 1, ${LINE_TRUNCATED}, '${VAR_TRUNCATED}', ${sqlLiteral(String(maxSteps), 'mysql')}\n`
    + `WHERE ${SEQ} >= ${maxSteps}`);
  const outParams = def.params.filter(p => isOut(p) && p.name);
  if (outParams.length) {
    const vals = outParams
      .map(p => `(${runLit}, ${SEQ} + 1, ${LINE_OUT}, ${sqlLiteral(p.name, 'mysql')}, CAST(${paramVar(p.name)} AS CHAR))`)
      .join(',\n    ');
    run.push(`INSERT INTO ${tableRef} (run, seq, line, var, val) VALUES\n    ${vals}`);
  }

  const setup = [
    `CREATE TABLE IF NOT EXISTS ${tableRef} (\n`
    + `  run VARCHAR(64) NOT NULL,\n`
    + `  seq INT UNSIGNED NOT NULL,\n`
    + `  line INT NOT NULL,\n`
    + `  var VARCHAR(128) NOT NULL,\n`
    + `  val LONGTEXT NULL,\n`
    + `  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n`
    + `  PRIMARY KEY (run, seq, var)\n`
    + `)`,
    // A crashed earlier run may have left the copy behind.
    `DROP ${kindSql} IF EXISTS ${copyRef}`,
  ];

  const select = `SELECT seq, line, var, val\nFROM ${tableRef}\nWHERE run = ${runLit}\nORDER BY seq, var`;

  const cleanup = [
    `DROP ${kindSql} IF EXISTS ${copyRef}`,
    `DELETE FROM ${tableRef} WHERE run = ${runLit}`,
  ];

  // Crash-sweep, at startup: leftover copies are found in information_schema
  // (LIKE escapes its own wildcards) and dropped with
  //   DROP PROCEDURE|FUNCTION IF EXISTS <schema>.<name>
  // per row; trace rows older than a day are purged — run that DELETE only
  // when the trace table exists, a fresh scratch schema has none.
  const sweep = [
    `SELECT ROUTINE_TYPE, ROUTINE_SCHEMA, ROUTINE_NAME\n`
    + `FROM information_schema.ROUTINES\n`
    + `WHERE ROUTINE_NAME LIKE ${sqlLiteral(`${`${P}_`.replace(/_/g, '\\_')}%`, 'mysql')}`,
    `DELETE FROM ${tableRef} WHERE ts < NOW() - INTERVAL 1 DAY`,
  ];

  // The display script needs DELIMITER around the CREATE — the copy's body is
  // full of semicolons. The executed parts never go near a delimiter.
  const sql = [
    ...setup.map(s => `${s};`),
    'DELIMITER $$',
    `${create}$$`,
    'DELIMITER ;',
    ...run.map(s => `${s};`),
    `${select};`,
    '-- finally, whether or not the run succeeded:',
    ...cleanup.map(s => `${s};`),
  ].join('\n');

  const watched: string[] = [];
  for (const v of [...entryVars, ...stmts.flatMap(s => s.vars)]) {
    if (!watched.includes(v)) watched.push(v);
  }

  return { sql, parts: { setup, create, run, select, cleanup, sweep }, watched, lines, copyName, notes };
}

// ── the recorded timeline ────────────────────────────────────────────────────

export interface MysqlTraceStep {
  /** The step number (trace `seq`). */
  n: number;
  /** Original body line, or one of the LINE_* pseudo-lines. */
  line: number;
  vars: Record<string, string | null>;
  /** The value a function returned, on the step that returned. */
  ret?: string | null;
  error?: string;
  sqlstate?: string;
  /** The run hit the step cap; later statements are not in the trace. */
  truncated?: boolean;
  /** The pre-execution step (parameters and DEFAULT values). */
  entry?: boolean;
}

/**
 * Group the trace rows back into steps.
 *
 * The SELECT returns one row per variable per step; everything whose `var` is
 * one of the `__txui_*` sentinels is folded onto the step itself, the rest
 * become its variable map. NULL survives as null — see the module header for
 * why that is load-bearing.
 */
export function parseMysqlTrace(rows: unknown[]): MysqlTraceStep[] {
  const bySeq = new Map<number, MysqlTraceStep>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const seq = Number(r.seq);
    if (!Number.isFinite(seq)) continue;
    let step = bySeq.get(seq);
    if (!step) {
      step = { n: seq, line: Number(r.line ?? LINE_ERROR), vars: {} };
      bySeq.set(seq, step);
    }
    if (step.line === LINE_ENTRY) step.entry = true;
    const varName = typeof r.var === 'string' ? r.var : '';
    if (!varName) continue;
    const val = r.val === null || r.val === undefined ? null : String(r.val);
    if (varName === VAR_ERROR) step.error = val ?? '';
    else if (varName === VAR_SQLSTATE) step.sqlstate = val ?? '';
    else if (varName === VAR_TRUNCATED) step.truncated = true;
    else if (varName === VAR_RETURN) step.ret = val;
    else if (varName !== VAR_STEP) step.vars[varName] = val;
  }
  return [...bySeq.values()].sort((a, b) => a.n - b.n);
}
