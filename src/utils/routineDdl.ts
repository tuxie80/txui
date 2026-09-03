/**
 * Stored routines as structured data, not as a blob of DDL text.
 *
 * A routine arrives from the server as one string — `SHOW CREATE PROCEDURE` on
 * MySQL, `pg_get_functiondef` on PostgreSQL — and everything worth building on
 * top needs it taken apart: the editor needs the parameter list to render a
 * form, the debugger needs the body separated from the header so it can map
 * statements to line numbers, and saving needs to put it back together without
 * losing the characteristics the server round-trips.
 *
 * The parsing rule that matters throughout: **never split on a delimiter
 * without tracking nesting and quoting.** A parameter list is not
 * `params.split(',')` — `DECIMAL(10,2)` contains a comma, `SET('a,b','c')`
 * contains one inside a string, and a comment can contain anything at all.
 * Every split here goes through a scanner that knows about parens, `'…'`,
 * `"…"`, backticks, dollar-quoting and both comment forms.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type RoutineKind = 'procedure' | 'function' | 'trigger' | 'event';

export type ParamMode = 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';

export interface RoutineParam {
  mode: ParamMode;
  name: string;
  type: string;
  /** DEFAULT expression, when the parameter has one (PostgreSQL). */
  defaultValue?: string;
}

export interface RoutineDef {
  kind: RoutineKind;
  schema: string | null;
  name: string;
  params: RoutineParam[];
  /** Return type for a function; null for procedures/triggers/events. */
  returns: string | null;
  /** plpgsql / sql / SQL — engine dependent. */
  language: string | null;
  /** The executable body, without the wrapper. */
  body: string;
  /**
   * Header characteristics preserved verbatim so a save round-trips: MySQL's
   * DETERMINISTIC / SQL SECURITY / COMMENT, PostgreSQL's STABLE / STRICT /
   * COST / SECURITY DEFINER.
   */
  characteristics: string[];
  /**
   * Trigger extras, kept so the DDL can be rebuilt.
   *
   * MySQL uses `timing`/`event` (one of each) and holds the body inline. A
   * PostgreSQL trigger is a different shape: it may fire on several events, it
   * chooses a row/statement level, it can carry a WHEN condition, and instead
   * of a body it *calls* an existing function — so the PG-only fields carry
   * that. The base three are still populated on PG (first event, its timing)
   * so anything that only reads them keeps working.
   */
  trigger?: {
    timing: string;
    event: string;
    table: string;
    /** PostgreSQL: the full event set, e.g. `['INSERT','UPDATE']`. */
    events?: string[];
    /** PostgreSQL: `ROW` or `STATEMENT`. */
    level?: 'ROW' | 'STATEMENT';
    /** PostgreSQL: a WHEN condition, without the surrounding parens. */
    when?: string;
    /** PostgreSQL: the function this trigger executes (may be schema.name). */
    function?: string;
    /** PostgreSQL: the argument list for that function, verbatim. */
    functionArgs?: string;
  };
  event?: { schedule: string; enabled: string };
  /** Offset in the ORIGINAL ddl where `body` began — lets the editor map lines. */
  bodyOffset: number;
  /**
   * Text before the `CREATE` keyword, preserved verbatim.
   *
   * SQL Server only. `sys.sql_modules.definition` is the author's original
   * source, not a re-rendering, so a routine that opens with a banner comment
   * keeps it — and rebuilding from the parsed parts would silently delete it
   * the first time someone pressed Save. MySQL and PostgreSQL never see this
   * because their servers hand back a reconstruction with the comment already
   * gone; the difference is a reason to preserve it here, not to match the
   * other engines by throwing it away.
   */
  preamble?: string;
}

// ── scanning ─────────────────────────────────────────────────────────────────

/**
 * Walk `text` from `i`, skipping over any quoted or commented region.
 *
 * Returns the index just past the region, or `i` itself when the character at
 * `i` does not start one. Shared by every splitter below so they cannot
 * disagree about what counts as a string.
 */
export function skipQuoted(text: string, i: number): number {
  const ch = text[i];
  const next = text[i + 1];

  if (ch === '-' && next === '-') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl + 1;
  }
  if (ch === '#') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl + 1;
  }
  if (ch === '/' && next === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === ch) {
        // '' / "" is an escaped quote, not a terminator.
        if (text[j + 1] === ch) { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return text.length;
  }
  if (ch === '`') {
    let j = i + 1;
    while (j < text.length && text[j] !== '`') j++;
    return j + 1;
  }
  if (ch === '$') {
    // PostgreSQL dollar quoting: $$ … $$ or $tag$ … $tag$
    const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
    if (m) {
      const tag = m[0];
      const end = text.indexOf(tag, i + tag.length);
      return end === -1 ? text.length : end + tag.length;
    }
  }
  return i;
}

/**
 * Split on top-level commas — the only correct way to read a parameter list.
 *
 * `DECIMAL(10,2)` and `SET('a,b')` both contain commas that are not
 * separators; depth and quote tracking is what tells them apart.
 */
export function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const skipped = skipQuoted(text, i);
    if (skipped > i) { i = skipped; continue; }
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  // Empty segments are dropped: an empty parameter is malformed either way,
  // and returning [''] for a whitespace-only list makes every caller special-
  // case "one parameter that is nothing".
  return out.filter(Boolean);
}

/**
 * Index of the `)` matching the `(` at `open`, or -1.
 *
 * Used to find the end of a parameter list without tripping over parentheses
 * inside a type, a string, or a comment.
 */
export function matchParen(text: string, open: number): number {
  if (text[open] !== '(') return -1;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const skipped = skipQuoted(text, i);
    if (skipped > i) { i = skipped; continue; }
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// ── parameters ───────────────────────────────────────────────────────────────

const MODES: ParamMode[] = ['INOUT', 'IN', 'OUT', 'VARIADIC'];

/**
 * Parse one parameter declaration.
 *
 * Shapes handled: `IN id INT`, `id INT`, `OUT total DECIMAL(10,2)`,
 * `VARIADIC vals int[]`, `p_name text DEFAULT 'x'`, and PostgreSQL's
 * mode-first-or-absent forms. A parameter may also be unnamed (`int`), which
 * PostgreSQL allows and the editor must not silently rename.
 */
export function parseParam(text: string): RoutineParam | null {
  let rest = text.trim();
  if (!rest) return null;

  let mode: ParamMode = 'IN';
  for (const m of MODES) {
    const re = new RegExp(`^${m}\\s+`, 'i');
    if (re.test(rest)) {
      mode = m;
      rest = rest.replace(re, '').trim();
      break;
    }
  }

  // DEFAULT / `=` tail, kept verbatim.
  let defaultValue: string | undefined;
  const defMatch = /\s+(?:DEFAULT\s+|=\s*)([\s\S]+)$/i.exec(rest);
  if (defMatch) {
    defaultValue = defMatch[1].trim();
    rest = rest.slice(0, defMatch.index).trim();
  }

  // `name type` — the name is the first token, unless there is only one token
  // (an unnamed parameter, which is a bare type).
  const m = /^(`[^`]+`|"[^"]+"|[A-Za-z_][\w$]*)\s+([\s\S]+)$/.exec(rest);
  if (!m) return { mode, name: '', type: rest, defaultValue };

  const rawName = m[1];
  const name = /^[`"]/.test(rawName) ? rawName.slice(1, -1) : rawName;
  return { mode, name, type: m[2].trim(), defaultValue };
}

/** Render a parameter back to DDL. */
export function renderParam(p: RoutineParam, engine: string, kind?: string): string {
  // T-SQL puts the mode after the type and the `@` inside the name — a
  // different enough shape that it gets its own renderer rather than a third
  // set of conditions in this one.
  if (engine === 'sqlserver') return renderMssqlParam(p);
  const parts: string[] = [];
  // MySQL accepts a mode on PROCEDURE parameters only — on a FUNCTION
  // parameter a mode is a syntax error (ERROR 1064, verified live on 8.4).
  // On procedures emitting the mode always is valid and makes intent explicit.
  const mysqlFunction = engine === 'mysql' && kind === 'function';
  if (!mysqlFunction && (p.mode !== 'IN' || engine === 'mysql')) parts.push(p.mode);
  if (p.name) parts.push(safeIdent(p.name, engine));
  parts.push(p.type);
  if (p.defaultValue) parts.push(`DEFAULT ${p.defaultValue}`);
  return parts.join(' ');
}

/**
 * Quote an identifier for the engine, only when it needs it.
 *
 * Delegates to `utils/sqlIdent`. The copy that used to live here tested only
 * for a bare-legal *shape*, so it left reserved words alone — and
 * `CREATE PROCEDURE p(order INT)` is a syntax error on MySQL 8.0.46, verified.
 * Re-exported under this name because callers already import it from here.
 */
import { safeIdent, safePath } from './sqlIdent.ts';
export { safeIdent as quoteIdent };

// ── MySQL ────────────────────────────────────────────────────────────────────

/**
 * MySQL characteristics that sit between the signature and the body.
 * Order is not significant to the server, so they are preserved as written.
 */
const MYSQL_CHARS = [
  /^DETERMINISTIC\b/i,
  /^NOT\s+DETERMINISTIC\b/i,
  /^NO\s+SQL\b/i,
  /^CONTAINS\s+SQL\b/i,
  /^READS\s+SQL\s+DATA\b/i,
  /^MODIFIES\s+SQL\s+DATA\b/i,
  /^SQL\s+SECURITY\s+(?:DEFINER|INVOKER)\b/i,
  /^COMMENT\s+'(?:[^'\\]|\\.|'')*'/i,
  /^LANGUAGE\s+SQL\b/i,
];

/**
 * Parse `SHOW CREATE PROCEDURE` / `FUNCTION` / `TRIGGER` / `EVENT` output.
 *
 * The DEFINER clause is deliberately dropped: it names the account that
 * created the routine, and re-issuing it requires SUPER on most servers.
 * Saving without it makes the current user the definer, which is what someone
 * editing a routine almost always wants and what fails loudly rather than
 * silently if not.
 */
export function parseMysqlRoutine(ddl: string, kind: RoutineKind): RoutineDef {
  const src = ddl.trim();

  const nameRe = new RegExp(
    `CREATE\\s+(?:DEFINER\\s*=\\s*\\S+\\s+)?${kind.toUpperCase()}\\s+` +
    '(?:(`[^`]+`|"[^"]+"|[\\w$]+)\\s*\\.\\s*)?(`[^`]+`|"[^"]+"|[\\w$]+)',
    'i');
  const nm = nameRe.exec(src);
  const unquote = (s: string | undefined) =>
    s ? (/^[`"]/.test(s) ? s.slice(1, -1) : s) : null;

  const schema = unquote(nm?.[1]);
  const name = unquote(nm?.[2]) ?? '';

  if (kind === 'trigger') return parseMysqlTrigger(src, schema, name);
  if (kind === 'event') return parseMysqlEvent(src, schema, name);

  // Parameter list starts at the first '(' after the name.
  const afterName = nm ? nm.index + nm[0].length : 0;
  const open = src.indexOf('(', afterName);
  const close = open >= 0 ? matchParen(src, open) : -1;
  const params = open >= 0 && close > open
    ? splitTopLevel(src.slice(open + 1, close))
        .map(parseParam)
        .filter((p): p is RoutineParam => p !== null && (p.name !== '' || p.type !== ''))
    : [];

  let cursor = close >= 0 ? close + 1 : afterName;

  // RETURNS <type> (functions only), before the characteristics.
  let returns: string | null = null;
  const retRe = /^\s*RETURNS\s+/i;
  const tail = src.slice(cursor);
  const retM = retRe.exec(tail);
  if (retM) {
    const from = cursor + retM[0].length;
    const end = findCharacteristicStart(src, from);
    returns = src.slice(from, end).trim();
    cursor = end;
  }

  // Characteristics run until the body keyword.
  const characteristics: string[] = [];
  for (;;) {
    const rest = src.slice(cursor);
    const lead = rest.match(/^\s*/)?.[0].length ?? 0;
    const at = rest.slice(lead);
    const hit = MYSQL_CHARS.find(re => re.test(at));
    if (!hit) break;
    const m = hit.exec(at)!;
    characteristics.push(m[0].trim());
    cursor += lead + m[0].length;
  }

  const body = src.slice(cursor).trim();
  return {
    kind, schema, name, params, returns,
    language: 'SQL',
    body,
    characteristics,
    bodyOffset: src.length - body.length,
  };
}

/** Where the characteristics (or the body) begin after a RETURNS type. */
function findCharacteristicStart(src: string, from: number): number {
  let i = from;
  let depth = 0;
  while (i < src.length) {
    const skipped = skipQuoted(src, i);
    if (skipped > i) { i = skipped; continue; }
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      const rest = src.slice(i);
      if (/^\s/.test(ch)) {
        const at = rest.replace(/^\s+/, '');
        if (MYSQL_CHARS.some(re => re.test(at)) || /^BEGIN\b|^RETURN\b/i.test(at)) return i;
      }
    }
    i++;
  }
  return src.length;
}

function parseMysqlTrigger(src: string, schema: string | null, name: string): RoutineDef {
  const m = /\b(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+(?:(`[^`]+`|[\w$]+)\s*\.\s*)?(`[^`]+`|[\w$]+)/i
    .exec(src);
  const strip = (s: string | undefined) => (s ? s.replace(/^`|`$/g, '') : '');
  const bodyM = /\bFOR\s+EACH\s+ROW\b/i.exec(src);
  const body = bodyM ? src.slice(bodyM.index + bodyM[0].length).trim() : '';
  return {
    kind: 'trigger', schema, name, params: [], returns: null, language: 'SQL',
    body,
    characteristics: [],
    trigger: {
      timing: (m?.[1] ?? 'BEFORE').toUpperCase(),
      event: (m?.[2] ?? 'INSERT').toUpperCase(),
      table: strip(m?.[4]),
    },
    bodyOffset: src.length - body.length,
  };
}

function parseMysqlEvent(src: string, schema: string | null, name: string): RoutineDef {
  const sched = /\bON\s+SCHEDULE\s+([\s\S]*?)(?=\s+(?:ON\s+COMPLETION|ENABLE|DISABLE|COMMENT|DO)\b)/i
    .exec(src);
  const enabled = /\b(ENABLE|DISABLE(?:\s+ON\s+SLAVE)?)\b/i.exec(src);
  const doM = /\bDO\b/i.exec(src);
  const body = doM ? src.slice(doM.index + 2).trim() : '';
  return {
    kind: 'event', schema, name, params: [], returns: null, language: 'SQL',
    body,
    characteristics: [],
    event: {
      schedule: sched?.[1]?.trim() ?? '',
      enabled: (enabled?.[1] ?? 'ENABLE').toUpperCase(),
    },
    bodyOffset: src.length - body.length,
  };
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

/**
 * Parse `pg_get_functiondef` output.
 *
 * PostgreSQL hands back a complete `CREATE OR REPLACE FUNCTION` with the body
 * dollar-quoted. The body is extracted from between the quote tags rather than
 * by scanning for a keyword, because a plpgsql body legitimately contains
 * every keyword this could otherwise anchor on.
 */
export function parsePgRoutine(ddl: string, kind: RoutineKind): RoutineDef {
  const src = ddl.trim();
  const nm = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:("[^"]+"|[\w$]+)\s*\.\s*)?("[^"]+"|[\w$]+)/i
    .exec(src);
  const unquote = (s: string | undefined) =>
    s ? (s.startsWith('"') ? s.slice(1, -1) : s) : null;

  const schema = unquote(nm?.[1]);
  const name = unquote(nm?.[2]) ?? '';

  const open = nm ? src.indexOf('(', nm.index + nm[0].length) : -1;
  const close = open >= 0 ? matchParen(src, open) : -1;
  const params = open >= 0 && close > open
    ? splitTopLevel(src.slice(open + 1, close))
        .map(parseParam)
        .filter((p): p is RoutineParam => p !== null && (p.name !== '' || p.type !== ''))
    : [];

  const retM = /\bRETURNS\s+([\s\S]*?)(?=\s+(?:LANGUAGE|AS|IMMUTABLE|STABLE|VOLATILE|STRICT|SECURITY|COST|ROWS|PARALLEL|WINDOW|SET)\b)/i
    .exec(src);
  const returns = retM ? retM[1].trim() : null;

  const langM = /\bLANGUAGE\s+("?[\w]+"?)/i.exec(src);
  const language = langM ? langM[1].replace(/"/g, '') : null;

  // Body: everything between the dollar-quote tags after AS.
  let body = '';
  let bodyOffset = 0;
  const asM = /\bAS\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i.exec(src);
  if (asM) {
    const tag = asM[1];
    const start = asM.index + asM[0].length;
    const end = src.indexOf(tag, start);
    body = end === -1 ? src.slice(start) : src.slice(start, end);
    bodyOffset = start;
    // A dollar-quoted body conventionally opens with a newline; dropping it
    // keeps the editor from showing a blank first line every time.
    if (body.startsWith('\n')) { body = body.slice(1); bodyOffset += 1; }
  } else {
    // `AS 'body'` — the older single-quoted form.
    const q = /\bAS\s+'([\s\S]*?)'\s*(?:;|$)/i.exec(src);
    if (q) { body = q[1]; bodyOffset = q.index + q[0].indexOf(q[1]); }
  }

  const characteristics: string[] = [];
  for (const re of [
    /\b(IMMUTABLE|STABLE|VOLATILE)\b/i,
    /\b(?:RETURNS\s+NULL\s+ON\s+NULL\s+INPUT|CALLED\s+ON\s+NULL\s+INPUT|STRICT)\b/i,
    /\bSECURITY\s+(?:DEFINER|INVOKER)\b/i,
    /\bPARALLEL\s+(?:SAFE|RESTRICTED|UNSAFE)\b/i,
    /\bCOST\s+[\d.]+/i,
    /\bROWS\s+[\d.]+/i,
  ]) {
    // Only look at the header — the body may contain any of these words.
    const header = src.slice(0, asM ? asM.index : src.length);
    const m = re.exec(header);
    if (m) characteristics.push(m[0].trim());
  }

  return {
    kind, schema, name, params, returns, language,
    body: body.replace(/\s+$/, ''),
    characteristics,
    bodyOffset,
  };
}

/**
 * Parse a `pg_get_triggerdef` string into the trigger shape.
 *
 * Shape: `CREATE TRIGGER name {BEFORE|AFTER|INSTEAD OF} ev1 [OR ev2 …] ON
 * [schema.]table FOR EACH {ROW|STATEMENT} [WHEN (cond)] EXECUTE
 * {FUNCTION|PROCEDURE} fn(args)`. A best-effort read — the panel can also
 * build one from scratch — so unmatched pieces fall back to sensible blanks
 * rather than throwing.
 */
export function parsePgTrigger(ddl: string): RoutineDef {
  const src = ddl.trim();
  const unq = (s: string | undefined) => (s ? s.replace(/^"|"$/g, '') : '');

  const nameM = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("[^"]+"|[\w$]+)/i.exec(src);
  const name = unq(nameM?.[1]);

  const timingM = /\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i.exec(src);
  const timing = timingM ? timingM[1].toUpperCase().replace(/\s+/g, ' ') : 'BEFORE';

  // Events sit between the timing keyword and ` ON `.
  const evStart = timingM ? timingM.index + timingM[0].length : 0;
  const onM = /\sON\s+/i.exec(src.slice(evStart));
  const evText = onM ? src.slice(evStart, evStart + onM.index) : '';
  const events = evText
    .split(/\s+OR\s+/i)
    .map(e => e.trim().replace(/\s+OF\s+.*$/i, '').toUpperCase()) // drop `UPDATE OF cols`
    .filter(Boolean);

  const tableM = /\sON\s+(?:("[^"]+"|[\w$]+)\s*\.\s*)?("[^"]+"|[\w$]+)/i.exec(src);
  const schema = tableM?.[1] ? unq(tableM[1]) : null;
  const table = unq(tableM?.[2]);

  const level: 'ROW' | 'STATEMENT' =
    /\bFOR\s+EACH\s+STATEMENT\b/i.test(src) ? 'STATEMENT' : 'ROW';

  // WHEN ( … ) — take a balanced parenthesised span.
  let when = '';
  const whenM = /\bWHEN\s*\(/i.exec(src);
  if (whenM) {
    const openIdx = whenM.index + whenM[0].length - 1;
    const closeIdx = matchParen(src, openIdx);
    if (closeIdx > openIdx) when = src.slice(openIdx + 1, closeIdx).trim();
  }

  const fnM = /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:("[^"]+"|[\w$]+)\s*\.\s*)?("[^"]+"|[\w$]+)\s*\(([\s\S]*?)\)\s*;?\s*$/i
    .exec(src);
  const fnSchema = fnM?.[1] ? unq(fnM[1]) + '.' : '';
  const fn = fnM ? fnSchema + unq(fnM[2]) : '';
  const functionArgs = fnM?.[3]?.trim() ?? '';

  return {
    kind: 'trigger', schema, name, params: [], returns: null, language: null,
    body: '', characteristics: [],
    trigger: {
      timing,
      event: events[0] ?? 'INSERT',
      table,
      events: events.length ? events : ['INSERT'],
      level,
      when,
      function: fn,
      functionArgs,
    },
    bodyOffset: 0,
  };
}

// ── SQL Server ───────────────────────────────────────────────────────────────

/**
 * T-SQL characteristics — the clauses between the signature and `AS`.
 *
 * A much shorter list than MySQL's, because most of what MySQL spells as a
 * characteristic (DETERMINISTIC, READS SQL DATA) SQL Server either infers or
 * does not have. `WITH ENCRYPTION` is included so it round-trips if it is
 * somehow present — though a module created with it has no readable definition
 * at all, so in practice this is only ever authored, never parsed back.
 */
const MSSQL_CHARS = [
  /^WITH\s+(?:SCHEMABINDING|ENCRYPTION|NATIVE_COMPILATION|EXECUTE\s+AS\s+\S+|RECOMPILE)(?:\s*,\s*(?:SCHEMABINDING|ENCRYPTION|NATIVE_COMPILATION|RECOMPILE|EXECUTE\s+AS\s+\S+))*/i,
];

/**
 * Skip leading whitespace and comments to the first real token.
 *
 * `sys.sql_modules.definition` is the author's original text, not a
 * reconstruction — so a definition routinely begins with a banner comment, and
 * anchoring on `^CREATE` misses every routine in a well-commented codebase.
 */
function skipLeadingTrivia(src: string): number {
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    const skipped = skipQuoted(src, i);
    // skipQuoted also steps over strings; only advance for a comment, since a
    // leading string is not trivia, it is (malformed) code.
    if (skipped > i && (src[i] === '-' || src[i] === '/')) { i = skipped; continue; }
    break;
  }
  return i;
}

/**
 * Parse a T-SQL parameter: `@name type [= default] [OUT|OUTPUT] [READONLY]`.
 *
 * Two differences from every other dialect make the shared `parseParam` wrong
 * here. The mode is a **suffix**, not a prefix — `@total int OUTPUT`, never
 * `OUT @total int` — and the name carries a leading `@` that is part of the
 * identifier, not decoration. Keeping the `@` in `name` is deliberate: it is
 * what `EXEC p @name = …` needs, and stripping it would make the execute form
 * build a call the server rejects.
 */
export function parseMssqlParam(text: string): RoutineParam | null {
  let rest = text.trim();
  if (!rest) return null;

  let mode: ParamMode = 'IN';
  // OUTPUT/OUT, and READONLY (table-valued parameters), both trail the type.
  const tail = /\s+(OUTPUT|OUT)\b\s*(READONLY\b\s*)?$|\s+READONLY\s*$/i.exec(rest);
  if (tail) {
    if (/OUT/i.test(tail[0])) mode = 'OUT';
    rest = rest.slice(0, tail.index).trim();
  }

  let defaultValue: string | undefined;
  // `= expr`. T-SQL has no DEFAULT keyword for parameters.
  const eq = /\s*=\s*([\s\S]+)$/.exec(rest);
  if (eq) {
    defaultValue = eq[1].trim();
    rest = rest.slice(0, eq.index).trim();
  }

  const m = /^(@[\w$#]+|\[[^\]]+\]|"[^"]+")\s+([\s\S]+)$/.exec(rest);
  if (!m) return { mode, name: '', type: rest, defaultValue };
  const raw = m[1];
  const name = /^[["]/.test(raw) ? raw.slice(1, -1) : raw;
  return { mode, name, type: m[2].trim(), defaultValue };
}

/**
 * Parse a `sys.sql_modules.definition`.
 *
 * The shape is `CREATE [OR ALTER] {PROCEDURE|FUNCTION|TRIGGER} name
 * [ ( params ) | params ] [RETURNS type] [WITH …] AS body`. Two T-SQL quirks
 * drive the implementation:
 *
 * - **A procedure's parameter list may have no parentheses.** `CREATE PROCEDURE
 *   p @a int, @b int AS …` is as legal as the parenthesised form, and the
 *   fixture uses it. So the list is read to the `AS` keyword when there is no
 *   `(`, which means finding a top-level `AS` — one not inside a string, a
 *   comment, or a type's parentheses.
 * - **`AS` is also a type alias keyword**, so the body split cannot be the
 *   first `AS` in the text. It is the first at paren depth zero after the
 *   signature, which is what `topLevelAs` finds.
 */
export function parseMssqlRoutine(ddl: string, kind: RoutineKind): RoutineDef {
  const src = ddl.trim();
  const start = skipLeadingTrivia(src);

  const nameRe = new RegExp(
    `CREATE\\s+(?:OR\\s+ALTER\\s+)?${kind === 'trigger' ? 'TRIGGER' : kind.toUpperCase()}\\s+` +
    '(?:(\\[[^\\]]+\\]|"[^"]+"|[\\w$]+)\\s*\\.\\s*)?(\\[[^\\]]+\\]|"[^"]+"|[\\w$]+)',
    'i');
  const nm = nameRe.exec(src.slice(start));
  const unquote = (s: string | undefined) =>
    s ? (/^[["]/.test(s) ? s.slice(1, -1) : s) : null;
  const schema = unquote(nm?.[1]);
  const name = unquote(nm?.[2]) ?? '';
  const afterName = nm ? start + nm.index + nm[0].length : start;

  if (kind === 'trigger') return parseMssqlTrigger(src, schema, name, afterName);

  // Parameters: parenthesised, or bare up to the RETURNS/WITH/AS that follows.
  let params: RoutineParam[] = [];
  let cursor = afterName;
  const nextNonSpace = src.slice(afterName).search(/\S/);
  if (nextNonSpace >= 0 && src[afterName + nextNonSpace] === '(') {
    const open = afterName + nextNonSpace;
    const close = matchParen(src, open);
    if (close > open) {
      params = splitTopLevel(src.slice(open + 1, close))
        .map(parseMssqlParam)
        .filter((p): p is RoutineParam => p !== null && (p.name !== '' || p.type !== ''));
      cursor = close + 1;
    }
  } else {
    const stop = topLevelKeyword(src, afterName, /^(RETURNS|WITH|AS)\b/i);
    if (stop > afterName) {
      params = splitTopLevel(src.slice(afterName, stop))
        .map(parseMssqlParam)
        .filter((p): p is RoutineParam => p !== null && (p.name !== '' || p.type !== ''));
      cursor = stop;
    }
  }

  // RETURNS <type> — scalar, `TABLE`, or `@t TABLE ( … )` for a
  // multi-statement TVF, all of which are kept verbatim so a save round-trips.
  let returns: string | null = null;
  const retM = /^\s*RETURNS\s+/i.exec(src.slice(cursor));
  if (retM) {
    const from = cursor + retM[0].length;
    const end = topLevelKeyword(src, from, /^(WITH|AS)\b/i);
    returns = src.slice(from, end).trim();
    cursor = end;
  }

  const characteristics: string[] = [];
  for (;;) {
    const rest = src.slice(cursor);
    const lead = rest.match(/^\s*/)?.[0].length ?? 0;
    const hit = MSSQL_CHARS.find(re => re.test(rest.slice(lead)));
    if (!hit) break;
    const m = hit.exec(rest.slice(lead))!;
    characteristics.push(m[0].trim());
    cursor += lead + m[0].length;
  }

  // The body is everything past the `AS` that opens it.
  const asM = /^\s*AS\b/i.exec(src.slice(cursor));
  const bodyStart = asM ? cursor + asM[0].length : cursor;
  const body = src.slice(bodyStart).replace(/^\s*\n?/, '').replace(/\s+$/, '');

  return {
    kind, schema, name, params, returns,
    language: 'SQL',
    body,
    characteristics,
    bodyOffset: src.length - body.length,
    preamble: src.slice(0, start),
  };
}

/**
 * Index of the first keyword matching `re` at paren depth zero, from `from`.
 *
 * Everything here has to be depth- and quote-aware: `decimal(10, 2)` contains a
 * comma, a default can be a string containing the word AS, and a parameter list
 * that is scanned naively will end in the middle of a type.
 */
function topLevelKeyword(text: string, from: number, re: RegExp): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const skipped = skipQuoted(text, i);
    if (skipped > i) { i = skipped; continue; }
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      const j = i + (text.slice(i).match(/^\s+/)?.[0].length ?? 0);
      if (re.test(text.slice(j, j + 16))) return i;
    }
    i++;
  }
  return text.length;
}

/**
 * A T-SQL trigger.
 *
 * Shape: `CREATE TRIGGER name ON table {AFTER|FOR|INSTEAD OF} ev [, ev …] AS
 * body`. Unlike PostgreSQL it holds its body inline (like MySQL), and unlike
 * MySQL the table comes *before* the timing and several events can share one
 * trigger. There is no `FOR EACH ROW`: a T-SQL trigger is per-statement and
 * sees the affected rows through the `inserted`/`deleted` pseudo-tables.
 */
function parseMssqlTrigger(
  src: string, schema: string | null, name: string, afterName: number,
): RoutineDef {
  const strip = (s: string | undefined) =>
    (s ? s.replace(/^[["]|[\]"]$/g, '') : '');
  const onM = /\bON\s+(?:(\[[^\]]+\]|"[^"]+"|[\w$]+)\s*\.\s*)?(\[[^\]]+\]|"[^"]+"|[\w$]+)/i
    .exec(src.slice(afterName));
  const table = strip(onM?.[2]);

  const timeM = /\b(AFTER|INSTEAD\s+OF|FOR)\s+(INSERT|UPDATE|DELETE)((?:\s*,\s*(?:INSERT|UPDATE|DELETE))*)/i
    .exec(src.slice(afterName));
  // `FOR` and `AFTER` are synonyms; normalising to AFTER means the round-trip
  // is stable and the form has one fewer meaningless choice.
  const timing = /INSTEAD/i.test(timeM?.[1] ?? '') ? 'INSTEAD OF' : 'AFTER';
  const events = timeM
    ? [timeM[2], ...(timeM[3] ?? '').split(',')]
        .map(e => e.trim().toUpperCase()).filter(Boolean)
    : ['INSERT'];

  const asAt = timeM
    ? topLevelKeyword(src, afterName + timeM.index + timeM[0].length, /^AS\b/i)
    : afterName;
  const asM = /^\s*AS\b/i.exec(src.slice(asAt));
  const bodyStart = asM ? asAt + asM[0].length : asAt;
  const body = src.slice(bodyStart).replace(/^\s*\n?/, '').replace(/\s+$/, '');

  return {
    kind: 'trigger', schema, name, params: [], returns: null, language: 'SQL',
    body,
    characteristics: [],
    trigger: { timing, event: events[0], table, events },
    bodyOffset: src.length - body.length,
    preamble: src.slice(0, skipLeadingTrivia(src)),
  };
}

/**
 * Rebuild T-SQL DDL.
 *
 * `CREATE OR ALTER` is the whole reason SQL Server needs no drop-then-create
 * dance: it has existed since 2016 SP1, it is one statement, and a rejected
 * definition leaves the previous one untouched. The MySQL hazard this module's
 * header describes simply does not apply.
 */
export function buildMssqlRoutineDdl(def: RoutineDef, orReplace: boolean): string {
  const q = (s: string) => safeIdent(s, 'sqlserver');
  const qualified = def.schema ? `${q(def.schema)}.${q(def.name)}` : q(def.name);
  const head = orReplace ? 'CREATE OR ALTER' : 'CREATE';
  // Whatever stood before CREATE goes back before CREATE. Trailing blank lines
  // are normalised to one newline so a round trip does not accumulate them.
  const pre = def.preamble && def.preamble.trim()
    ? `${def.preamble.replace(/\s+$/, '')}\n` : '';

  if (def.kind === 'trigger' && def.trigger) {
    const t = def.trigger;
    const events = (t.events && t.events.length ? t.events : [t.event])
      .filter(Boolean).join(', ');
    const table = def.schema ? `${q(def.schema)}.${q(t.table)}` : q(t.table);
    return pre
      + `${head} TRIGGER ${qualified}\n`
      + `ON ${table}\n`
      + `${t.timing} ${events}\n`
      + `AS\n${def.body}`;
  }

  const paramList = def.params.map(p => renderMssqlParam(p)).join(',\n    ');
  // The parentheses are required on a function and optional on a procedure,
  // and T-SQL is conventionally written both ways round — parenthesised on the
  // signature line for a function, an indented bare list for a procedure.
  // Following that keeps a diff against the server's own text readable.
  const lines = [
    pre + (def.kind === 'function'
      ? `${head} FUNCTION ${qualified}(${paramList})`
      : `${head} ${def.kind.toUpperCase()} ${qualified}`),
  ];
  if (def.kind !== 'function' && paramList) lines.push(`    ${paramList}`);
  if (def.returns) lines.push(`RETURNS ${def.returns}`);
  for (const c of def.characteristics) lines.push(c);
  lines.push('AS');
  lines.push(def.body);
  return lines.join('\n');
}

/** Render one T-SQL parameter — mode trails the type, not leads it. */
export function renderMssqlParam(p: RoutineParam): string {
  // The `@` is part of the name. A name arriving without one (typed into the
  // form) gets it, because `CREATE PROCEDURE p(n int)` is a syntax error.
  const name = p.name ? (p.name.startsWith('@') ? p.name : `@${p.name}`) : '';
  const parts = [name, p.type].filter(Boolean);
  let out = parts.join(' ');
  if (p.defaultValue) out += ` = ${p.defaultValue}`;
  if (p.mode === 'OUT' || p.mode === 'INOUT') out += ' OUTPUT';
  return out;
}

/** Parse whichever dialect produced this definition. */
export function parseRoutine(engine: string, ddl: string, kind: RoutineKind): RoutineDef {
  if (engine === 'sqlserver') return parseMssqlRoutine(ddl, kind);
  if (engine === 'postgres') {
    // A PostgreSQL trigger is not a pg_proc, so it takes a separate parser.
    return kind === 'trigger' ? parsePgTrigger(ddl) : parsePgRoutine(ddl, kind);
  }
  return parseMysqlRoutine(ddl, kind);
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * Rebuild executable DDL from a definition.
 *
 * `orReplace` is honoured only where the engine supports it: PostgreSQL has
 * `CREATE OR REPLACE`, MySQL has nothing equivalent for routines and needs a
 * DROP first — which the caller must run as a separate statement, inside a
 * transaction, so a failed create cannot leave the routine missing.
 */
export function buildRoutineDdl(
  engine: string, def: RoutineDef, opts: { orReplace?: boolean } = {},
): string {
  if (engine === 'sqlserver') return buildMssqlRoutineDdl(def, opts.orReplace ?? false);

  const q = (s: string) => safeIdent(s, engine);
  const qualified = def.schema ? `${q(def.schema)}.${q(def.name)}` : q(def.name);

  if (def.kind === 'trigger' && def.trigger) {
    // PostgreSQL triggers call a function rather than holding a body, so they
    // are built from a different clause set entirely.
    if (engine === 'postgres') return buildPgTriggerDdl(def);
    return `CREATE TRIGGER ${qualified}\n`
      + `${def.trigger.timing} ${def.trigger.event} ON ${q(def.trigger.table)}\n`
      + `FOR EACH ROW\n${def.body}`;
  }
  if (def.kind === 'event' && def.event) {
    return `CREATE EVENT ${qualified}\n`
      + `ON SCHEDULE ${def.event.schedule}\n`
      + `${def.event.enabled}\nDO\n${def.body}`;
  }

  const head = engine === 'postgres' && opts.orReplace
    ? `CREATE OR REPLACE ${def.kind.toUpperCase()}`
    : `CREATE ${def.kind.toUpperCase()}`;
  const paramList = def.params.map(p => renderParam(p, engine, def.kind)).join(', ');
  const lines = [`${head} ${qualified}(${paramList})`];

  if (def.returns) lines.push(`RETURNS ${def.returns}`);

  if (engine === 'postgres') {
    if (def.language) lines.push(`LANGUAGE ${def.language}`);
    for (const c of def.characteristics) lines.push(c);
    // Pick a dollar tag that cannot appear in the body — a body containing
    // `$$` (nested dollar-quoting is legal) would otherwise terminate early.
    lines.push(`AS ${dollarTag(def.body)}`);
    lines.push(def.body);
    lines.push(dollarTag(def.body));
    return lines.join('\n');
  }

  for (const c of def.characteristics) lines.push(c);
  lines.push(def.body);
  return lines.join('\n');
}

/**
 * A PostgreSQL `CREATE TRIGGER`.
 *
 * Unlike the MySQL form this has no body — a PG trigger names an existing
 * function to `EXECUTE` — so the panel picks timing, events, table, level, an
 * optional WHEN condition, and the function. Multiple events join with `OR`
 * (`BEFORE INSERT OR UPDATE`), which is exactly the shape `pg_get_triggerdef`
 * round-trips.
 *
 * Identifiers go through `safePath`/`safeIdent`; the function's argument list
 * and the WHEN expression are user-authored SQL, kept verbatim.
 */
export function buildPgTriggerDdl(def: RoutineDef): string {
  const t = def.trigger!;
  const q = (s: string) => safeIdent(s, 'postgres');
  const events = (t.events && t.events.length ? t.events : [t.event])
    .filter(Boolean).join(' OR ');
  const table = def.schema
    ? `${q(def.schema)}.${q(t.table)}`
    : safePath(t.table.split('.'), 'postgres');
  const lines = [
    `CREATE TRIGGER ${q(def.name)}`,
    `${t.timing} ${events} ON ${table}`,
    `FOR EACH ${t.level ?? 'ROW'}`,
  ];
  if (t.when && t.when.trim()) lines.push(`WHEN (${t.when.trim()})`);
  const fn = (t.function ?? '').trim();
  const fnRef = fn ? safePath(fn.split('.'), 'postgres') : '""';
  lines.push(`EXECUTE FUNCTION ${fnRef}(${(t.functionArgs ?? '').trim()})`);
  return lines.join('\n');
}

/**
 * A dollar-quote tag guaranteed not to occur inside `body`.
 *
 * `$$` is the conventional choice and is wrong whenever the body itself
 * dollar-quotes something — which plpgsql that builds dynamic SQL routinely
 * does. Escalate until the tag is unique.
 */
export function dollarTag(body: string): string {
  if (!body.includes('$$')) return '$$';
  for (const tag of ['$body$', '$func$', '$txui$']) {
    if (!body.includes(tag)) return tag;
  }
  for (let n = 1; ; n++) {
    const tag = `$txui${n}$`;
    if (!body.includes(tag)) return tag;
  }
}

/** The `DROP` that must precede a MySQL re-create. */
export function dropRoutineDdl(engine: string, def: RoutineDef): string {
  const q = (s: string) => safeIdent(s, engine);
  const qualified = def.schema ? `${q(def.schema)}.${q(def.name)}` : q(def.name);
  if (def.kind === 'trigger') {
    // A SQL Server trigger name IS unique per schema, so unlike PostgreSQL the
    // qualified name is enough and no table is needed.
    if (engine === 'sqlserver') return `DROP TRIGGER IF EXISTS ${qualified}`;
    // PostgreSQL triggers are named per-table, so the drop must say which
    // table; the trigger name alone is not unique across a schema.
    if (engine === 'postgres' && def.trigger) {
      const table = def.schema
        ? `${q(def.schema)}.${q(def.trigger.table)}`
        : safePath(def.trigger.table.split('.'), 'postgres');
      return `DROP TRIGGER IF EXISTS ${q(def.name)} ON ${table}`;
    }
    return `DROP TRIGGER IF EXISTS ${qualified}`;
  }
  if (def.kind === 'event') return `DROP EVENT IF EXISTS ${qualified}`;
  // SQL Server has no routine overloading, so the bare name identifies it —
  // and `DROP … IF EXISTS` has been supported since 2016.
  if (engine === 'sqlserver') return `DROP ${def.kind.toUpperCase()} IF EXISTS ${qualified}`;
  // PostgreSQL needs the argument types to identify an overload; MySQL does not
  // allow overloading at all, so the bare name is unambiguous there.
  if (engine === 'postgres') {
    const sig = def.params
      .filter(p => p.mode !== 'OUT')
      .map(p => p.type)
      .join(', ');
    return `DROP ${def.kind.toUpperCase()} IF EXISTS ${qualified}(${sig})`;
  }
  return `DROP ${def.kind.toUpperCase()} IF EXISTS ${qualified}`;
}

/** A one-line signature for lists and tab labels. */
export function routineSignature(def: RoutineDef): string {
  if (def.kind === 'trigger' && def.trigger) {
    const events = def.trigger.events && def.trigger.events.length
      ? def.trigger.events.join(' OR ')
      : def.trigger.event;
    return `${def.name} — ${def.trigger.timing} ${events} ON ${def.trigger.table}`;
  }
  if (def.kind === 'event') return def.name;
  const params = def.params
    .map(p => `${p.mode === 'IN' ? '' : p.mode + ' '}${p.name}${p.type ? ' ' + p.type : ''}`.trim())
    .join(', ');
  return `${def.name}(${params})${def.returns ? ` → ${def.returns}` : ''}`;
}
