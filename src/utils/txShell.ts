/**
 * TxShell — turning a typed line into something executable.
 *
 * The grammar and the reasoning behind it live in `txShellGrammar.ts`. The one
 * rule that shapes this file: **no shell operator is a character that is also
 * valid SQL.** The pipe is `|>`; there is no `>` redirect and no `<` source,
 * because both of those characters belong to SQL comparisons. Nothing here
 * ever has to guess what a line means, which is why TxShell needs no modes and
 * no `go` buffer.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { skipQuoted } from './routineDdl.ts';
import type { QueryResult } from '../types/index.ts';
import {
  PIPE, findVerb, findMeta, suggest, checkArity, VERB_NAMES, META_NAMES,
} from './txShellGrammar.ts';

export type ShellHead =
  | { kind: 'sql'; sql: string }
  | { kind: 'fanout'; pattern: string; sql: string }
  | { kind: 'meta'; name: string; args: string[] }
  | { kind: 'source'; name: string; args: string[] }
  | { kind: 'os'; command: string }
  | { kind: 'assign'; name: string; value: string }
  | { kind: 'comment' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

export interface PipelineStage {
  name: string;
  args: string[];
  raw: string;
}

export interface ParsedLine {
  head: ShellHead;
  stages: PipelineStage[];
  /** Set when the line is well-formed but cannot run; already user-facing. */
  error?: string;
}

/** Only diff's first argument makes #digits a reference rather than a comment. */
function skipShellQuoted(text: string, i: number): number {
  const resultRef = text[i] === '#' && /\d/.test(text[i + 1] ?? '')
    && /(?:^|\|>)\s*diff\s+$/i.test(text.slice(0, i));
  return resultRef ? i : skipQuoted(text, i);
}

/**
 * Split on `|>` at the top level.
 *
 * Quote-aware via the shared scanner, so a pipe inside a string, a comment or a
 * dollar-quoted plpgsql body is left alone. The `prev !== '|'` guard keeps
 * PostgreSQL's `||` concatenation from being mistaken for a pipe when followed
 * by a comparison: `a||>b` is invalid SQL, but the scanner should not be the
 * thing that decides that.
 */
export function splitPipeline(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  while (i < line.length) {
    const skipped = skipShellQuoted(line, i);
    if (skipped > i) { i = skipped; continue; }
    const ch = line[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && line.startsWith(PIPE, i) && line[i - 1] !== '|') {
      out.push(line.slice(start, i));
      i += PIPE.length;
      start = i;
      continue;
    }
    i++;
  }
  out.push(line.slice(start));
  return out;
}

/** Strip one layer of surrounding quotes. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split arguments on whitespace, honouring quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || quoted) { out.push(cur); cur = ''; quoted = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

/**
 * A bare `|` immediately followed by a known verb is almost certainly someone
 * reaching for a Unix pipe. Saying so beats running their bitwise-or.
 */
function barePipeHint(segment: string): string | null {
  const m = /\|\s*([a-z]+)/i.exec(segment);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  if (!findVerb(verb)) return null;
  return `Use \`${PIPE}\` for pipelines, not \`|\` — \`|\` is SQL's bitwise-or. `
    + `Try: … ${PIPE} ${verb} …`;
}

/** Classify the first segment of a line. */
export function dispatchHead(segment: string): ShellHead {
  const s = segment.trim();
  if (!s) return { kind: 'empty' };
  if (s.startsWith('#')) return { kind: 'comment' };

  // `!` hands the rest to the OS shell verbatim — pipes and redirects included,
  // so `!ls | wc -l` means there exactly what it means in a terminal.
  if (s.startsWith('!')) {
    const command = s.slice(1).trim();
    return command
      ? { kind: 'os', command }
      : { kind: 'error', message: '`!` needs a command — try `!ls`' };
  }

  // `\meta`
  if (s.startsWith('\\')) {
    const [name, ...args] = splitArgs(s.slice(1));
    if (!name) return { kind: 'error', message: 'Missing command after `\\` — try `\\help`' };
    const spec = findMeta(name);
    if (!spec) {
      const hint = suggest(name, META_NAMES);
      return {
        kind: 'error',
        message: `Unknown command \`\\${name}\``
          + (hint ? ` — did you mean \`\\${hint}\`?` : ' — try `\\help`'),
      };
    }
    return { kind: 'meta', name: spec.name, args };
  }

  // `$name = value`
  const assign = /^\$([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(s);
  if (assign) return { kind: 'assign', name: assign[1], value: assign[2].trim() };

  // `@pattern SQL`
  if (s.startsWith('@')) {
    const m = /^@(\S+)(?:\s+([\s\S]+))?$/.exec(s);
    const pattern = m?.[1] ?? '';
    const sql = (m?.[2] ?? '').trim();
    if (!sql) {
      return {
        kind: 'error',
        message: `\`@${pattern}\` needs a statement — e.g. \`@prod-* SELECT 1\`. `
          + 'Nothing was run.',
      };
    }
    return { kind: 'fanout', pattern, sql };
  }

  // A source verb may start a line: `from orders.csv |> head 10`.
  const [first, ...rest] = splitArgs(s);
  const asSource = first ? findVerb(first) : undefined;
  if (asSource?.kind === 'source') {
    const bad = checkArity(asSource, rest);
    if (bad) return { kind: 'error', message: bad };
    return { kind: 'source', name: asSource.name, args: rest };
  }

  return { kind: 'sql', sql: s };
}

/**
 * Parse one command line into a head and its pipeline stages.
 *
 * Every failure is reported with what to type instead. A shell that answers
 * "syntax error" is a shell people stop using.
 */
export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { head: { kind: 'empty' }, stages: [] };

  // The OS gets its line untouched — splitting it would change its meaning.
  if (trimmed.startsWith('!')) return { head: dispatchHead(trimmed), stages: [] };

  const segments = splitPipeline(trimmed);
  const head = dispatchHead(segments[0]);
  if (head.kind === 'error') return { head, stages: [] };

  // Only worth mentioning the bare-pipe confusion when there is no real pipe.
  if (segments.length === 1 && (head.kind === 'sql' || head.kind === 'fanout')) {
    const hint = barePipeHint(segments[0]);
    if (hint) return { head, stages: [], error: hint };
  }

  const stages: PipelineStage[] = [];
  for (let i = 1; i < segments.length; i++) {
    const raw = segments[i].trim();
    if (!raw) {
      return {
        head: { kind: 'error', message: `Empty stage — a \`${PIPE}\` has nothing after it` },
        stages: [],
      };
    }
    const [name, ...args] = splitArgs(raw);
    const spec = findVerb(name);
    if (!spec) {
      const hint = suggest(name, VERB_NAMES);
      return {
        head: {
          kind: 'error',
          message: `Unknown verb \`${name}\``
            + (hint ? ` — did you mean \`${hint}\`?` : ` — try \`\\help\` for the list`),
        },
        stages: [],
      };
    }
    if (spec.kind === 'source') {
      return {
        head: {
          kind: 'error',
          message: `\`${spec.name}\` produces rows, so it starts a line rather than `
            + `following a \`${PIPE}\`. Try: \`${spec.name} … ${PIPE} head 10\``,
        },
        stages: [],
      };
    }
    const bad = checkArity(spec, args);
    if (bad) return { head: { kind: 'error', message: bad }, stages: [] };
    stages.push({ name: spec.name, args, raw });
  }

  // A sink consumes the rows, so nothing can follow it.
  for (let i = 0; i < stages.length - 1; i++) {
    const spec = findVerb(stages[i].name);
    if (spec?.kind === 'sink') {
      return {
        head: {
          kind: 'error',
          message: `\`${stages[i].name}\` consumes the rows, so it has to come last. `
            + `Move it to the end of the pipeline.`,
        },
        stages: [],
      };
    }
  }

  return { head, stages };
}

// ── variables ────────────────────────────────────────────────────────────────

/**
 * Substitute `$name` and `${name}`.
 *
 * An unset name is reported and left **as written**. Blanking it would turn
 * `DELETE FROM t WHERE id = $missing` into `DELETE FROM t WHERE id =` — or,
 * far worse, into something that still parses and matches every row. The caller
 * refuses to run a line with missing variables.
 *
 * `$$` is an escape for a literal `$`, so a dollar-quoted plpgsql body pasted
 * into the shell is not eaten by the substituter.
 */
export function substituteVars(
  text: string, vars: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\$\$|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (whole, braced, bare) => {
      if (whole === '$$') return '$$';
      const name = braced ?? bare;
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      if (!missing.includes(name)) missing.push(name);
      return whole;
    });
  return { text: out, missing };
}

// ── command substitution ─────────────────────────────────────────────────────

export const COMMAND_SUBSTITUTION_MAX_DEPTH = 4;
export const COMMAND_SUBSTITUTION_MAX_OUTPUT = 64 * 1024;

export interface CommandSubstitutionOptions {
  /** Depth of the line containing these substitutions (top level is zero). */
  depth?: number;
  maxDepth?: number;
  /** Combined cap for all substitutions on one line, in UTF-16 code units. */
  maxOutput?: number;
}

/** A stable scalar rendering; object keys are sorted rather than driver-ordered. */
function commandValue(value: unknown, nested = false): string {
  if (value === null || value === undefined) return nested ? 'null' : 'NULL';
  if (typeof value === 'string') return nested ? JSON.stringify(value) : value;
  if (typeof value === 'number') return nested && !Number.isFinite(value) ? 'null' : String(value);
  if (typeof value === 'bigint') return nested ? JSON.stringify(String(value)) : String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(v => commandValue(v, true)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      k => `${JSON.stringify(k)}:${commandValue(record[k], true)}`).join(',')}}`;
  }
  return String(value);
}

/**
 * Convert captured rows without locale-sensitive formatting. A single cell is a
 * scalar; otherwise rows are newline-separated and cells tab-separated. Tabs,
 * newlines, carriage returns and backslashes in structured output are escaped,
 * so one result row always remains one output line. There are no headers.
 */
export function resultToCommandText(result: Pick<QueryResult, 'rows'>): string {
  if (!result.rows.length) return '';
  if (result.rows.length === 1 && result.rows[0].length === 1) {
    return commandValue(result.rows[0][0]);
  }
  const cell = (value: unknown) => commandValue(value)
    .replace(/\\/g, '\\\\').replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return result.rows.map(row => row.map(cell).join('\t')).join('\n');
}

/**
 * Expand `$(…)` from left to right through a caller-supplied TxShell executor.
 * This function never calls an OS shell. SQL strings, quoted identifiers,
 * dollar-quoted bodies and comments are copied verbatim. Executor errors abort
 * the whole expansion, and nested execution is bounded by `depth` as well as by
 * the combined output cap.
 */
export async function substituteCommands(
  text: string,
  execute: (command: string, depth: number) => Promise<string>,
  options: CommandSubstitutionOptions = {},
): Promise<string> {
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? COMMAND_SUBSTITUTION_MAX_DEPTH;
  const maxOutput = options.maxOutput ?? COMMAND_SUBSTITUTION_MAX_OUTPUT;
  let out = '';
  let copied = 0;
  let produced = 0;
  let i = 0;

  while (i < text.length) {
    const skipped = skipShellQuoted(text, i);
    if (skipped > i) { i = skipped; continue; }
    if (!text.startsWith('$(', i)) { i++; continue; }
    if (depth >= maxDepth) {
      throw new Error(`Command substitution is nested more than ${maxDepth} levels deep.`);
    }

    out += text.slice(copied, i);
    const start = i + 2;
    let j = start;
    let parens = 1;
    while (j < text.length && parens > 0) {
      const quoted = skipShellQuoted(text, j);
      if (quoted > j) { j = quoted; continue; }
      if (text[j] === '(') parens++;
      else if (text[j] === ')') parens--;
      j++;
    }
    if (parens > 0) throw new Error('Unclosed `$(…)` command substitution.');
    const command = text.slice(start, j - 1).trim();
    if (!command) throw new Error('Empty `$()` command substitution.');

    const replacement = await execute(command, depth + 1);
    produced += replacement.length;
    if (produced > maxOutput) {
      throw new Error(`Command substitution output exceeded ${maxOutput} characters. Nothing was run.`);
    }
    out += replacement;
    i = j;
    copied = j;
  }
  return out + text.slice(copied);
}

// ── multi-line input ─────────────────────────────────────────────────────────

/**
 * Is the buffer a finished statement, or is the user still typing?
 *
 * The prompt stays open until a terminator, the way psql does it, so a
 * multi-line `CREATE FUNCTION` can be pasted without each line firing as its
 * own query. A pipeline also completes the line — `SELECT 1 |> head 5` needs
 * no `;`, because the `|>` already says the statement ended.
 */
export function isComplete(buffer: string, delimiter = ';'): boolean {
  const s = buffer.trim();
  if (!s) return true;
  // Meta, OS, fanout, assignment and comments are always single-line.
  if (/^[\\!@$#]/.test(s)) return true;

  const delim = delimiter.trim() || ';';
  let i = 0;
  let terminated = false;
  while (i < s.length) {
    const skipped = skipQuoted(s, i);
    if (skipped > i) {
      if (skipped >= s.length && isOpenQuote(s, i)) return false;
      i = skipped;
      continue;
    }
    if (s.startsWith(PIPE, i) && s[i - 1] !== '|') { terminated = true; i += PIPE.length; continue; }
    if (s.startsWith(delim, i)) { terminated = true; i += delim.length; continue; }
    i++;
  }
  return terminated;
}

/** Did a quote opening at `i` fail to close before the end of the buffer? */
function isOpenQuote(s: string, i: number): boolean {
  const ch = s[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    return !(s.length > i + 1 && s[s.length - 1] === ch);
  }
  if (ch === '$') {
    const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
    if (m) return s.indexOf(m[0], i + m[0].length) === -1;
  }
  return false;
}

/**
 * Are all quotes/dollar-quotes in the buffer closed? The shell uses this to
 * run a bare single line on Enter without demanding a terminator — a missing
 * `;` on `select 1` is fine, an open quote is not (the user is mid-literal).
 */
export function quotesClosed(buffer: string): boolean {
  let i = 0;
  while (i < buffer.length) {
    const skipped = skipQuoted(buffer, i);
    if (skipped > i) {
      if (skipped >= buffer.length && isOpenQuote(buffer, i)) return false;
      i = skipped;
      continue;
    }
    i++;
  }
  return true;
}

// ── history ──────────────────────────────────────────────────────────────────

export const HISTORY_CAP = 500;

/** Append to history, skipping blanks and consecutive duplicates. */
export function pushHistory(history: string[], line: string): string[] {
  const t = line.trim();
  if (!t) return history;
  if (history[history.length - 1] === t) return history;
  const next = [...history, t];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

// ── completion ───────────────────────────────────────────────────────────────

/**
 * Candidates for the token being typed.
 *
 * Position decides the vocabulary: after a `|>` only stages and sinks can
 * follow, at the start of a line a `\` offers meta commands, and everywhere
 * else the SQL completion the editor already has is the right answer — so this
 * returns nothing and lets that take over.
 */
export function completions(line: string, caret: number): string[] {
  const before = line.slice(0, caret);
  const seg = splitPipeline(before);
  const current = seg[seg.length - 1];
  const token = /(\S*)$/.exec(current)?.[1] ?? '';

  if (seg.length > 1) {
    const typedWords = current.trim().split(/\s+/).filter(Boolean);
    if (typedWords.length <= 1) {
      return VERB_NAMES
        .filter(n => findVerb(n)?.kind !== 'source')
        .filter(n => n.startsWith(token.toLowerCase()));
    }
    return [];
  }
  if (before.trimStart().startsWith('\\')) {
    const t = token.replace(/^\\/, '').toLowerCase();
    return META_NAMES.filter(n => n.startsWith(t)).map(n => `\\${n}`);
  }
  return [];
}
