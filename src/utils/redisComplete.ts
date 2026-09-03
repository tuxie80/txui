/**
 * Redis editor completion.
 *
 * Redis is not SQL, so the SQL completion engine has nothing useful to say
 * about it — it was offering SELECT/FROM/JOIN keywords on a Redis connection.
 * This source is position-aware in the way a Redis line actually works:
 *
 *   position 0        → the command (or a container's subcommand)
 *   after a container → its subcommands only ("CONFIG " → GET/SET/…)
 *   a key argument    → live key names from the server
 *   a token argument  → the literal tokens that command accepts (NX, XX, EX…)
 *
 * The catalog in redisCommands.ts is generated from a live server's own
 * `COMMAND DOCS`, so the syntax shown is the real syntax for the real version,
 * including container subcommands most tools omit entirely.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { REDIS_COMMANDS, REDIS_BY_NAME, type RedisCommand } from './redisCommands.ts';

export type KeyProvider = (prefix: string) => Promise<string[]>;

/** Container commands: the first word is meaningless without its subcommand. */
const CONTAINERS = new Set(
  REDIS_COMMANDS
    .filter(c => c.name.includes(' '))
    .map(c => c.name.split(' ')[0]),
);

/** Commands whose FIRST argument is a key — drives key-name completion. */
function firstArgIsKey(c: RedisCommand): boolean {
  return /^key\b/.test(c.syntax) || /^\[?key/.test(c.syntax);
}

/** Literal tokens a command accepts, pulled out of its rendered syntax. */
function tokensOf(c: RedisCommand): string[] {
  // Uppercase words in the syntax are literal tokens (NX, XX, MATCH, COUNT…).
  // Lowercase words are placeholders for user values.
  const out = new Set<string>();
  for (const m of c.syntax.matchAll(/\b([A-Z][A-Z0-9_-]{1,})\b/g)) out.add(m[1]);
  return [...out];
}

/** One-line detail shown to the right of a completion. */
function detailOf(c: RedisCommand): string {
  return c.syntax ? c.syntax.slice(0, 60) : c.group;
}

/** Rich hover/info panel for a command. */
function infoOf(c: RedisCommand): () => HTMLElement {
  return () => {
    const wrap = document.createElement('div');
    wrap.className = 'rc-info';
    const sig = document.createElement('div');
    sig.className = 'rc-info-sig';
    sig.textContent = `${c.name}${c.syntax ? ' ' + c.syntax : ''}`;
    wrap.appendChild(sig);

    if (c.summary) {
      const s = document.createElement('div');
      s.className = 'rc-info-summary';
      s.textContent = c.summary;
      wrap.appendChild(s);
    }
    const meta: string[] = [];
    if (c.complexity) meta.push(c.complexity);
    if (c.since) meta.push(`since ${c.since}`);
    if (c.arity) {
      meta.push(c.arity > 0
        ? `exactly ${c.arity - 1} arg${c.arity - 1 === 1 ? '' : 's'}`
        : `${-c.arity - 1}+ args`);
    }
    if (c.flags.length) meta.push(c.flags.join(' · '));
    if (meta.length) {
      const m = document.createElement('div');
      m.className = 'rc-info-meta';
      m.textContent = meta.join('  ·  ');
      wrap.appendChild(m);
    }
    return wrap;
  };
}

function toCompletion(c: RedisCommand, boost = 0): Completion {
  return {
    label: c.name,
    type: c.flags.includes('write') ? 'keyword' : 'function',
    detail: detailOf(c),
    info: infoOf(c),
    boost,
  };
}

/** Tokenise the line up to the cursor, tracking whether we are mid-word. */
export interface LineContext {
  /** Completed words before the cursor. */
  words: string[];
  /** The partial word under the cursor ('' when just after a space). */
  partial: string;
  /** Document offset where `partial` starts. */
  from: number;
}

export function lineContext(line: string, lineStart: number, cursor: number): LineContext {
  const upto = line.slice(0, cursor - lineStart);
  // Simple split is enough for POSITION tracking; full quoting is handled by
  // the backend tokeniser at execution time.
  const parts = upto.split(/\s+/);
  const endsWithSpace = /\s$/.test(upto) || upto === '';
  const partial = endsWithSpace ? '' : (parts[parts.length - 1] ?? '');
  const words = (endsWithSpace ? parts : parts.slice(0, -1)).filter(Boolean);
  return { words, partial, from: cursor - partial.length };
}

/** Resolve which catalog entry the line is currently invoking. */
export function resolveCommand(words: string[]): RedisCommand | undefined {
  if (words.length === 0) return undefined;
  const head = words[0].toUpperCase();
  if (CONTAINERS.has(head) && words.length > 1) {
    return REDIS_BY_NAME.get(`${head} ${words[1].toUpperCase()}`);
  }
  return REDIS_BY_NAME.get(head);
}

export interface RedisCompletionOptions {
  /** Live key names for key-position completion. */
  getKeys?: KeyProvider;
  /** Extra commands reported by the connected server (modules). */
  extra?: RedisCommand[];
}

export function buildRedisCompletionSource(options: RedisCompletionOptions = {}) {
  const all = options.extra?.length
    ? [...REDIS_COMMANDS, ...options.extra]
    : REDIS_COMMANDS;
  const topLevel = all.filter(c => !c.name.includes(' '));

  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const { words, partial, from } = lineContext(line.text, line.from, ctx.pos);

    // ── position 0: the command itself ───────────────────────────────
    if (words.length === 0) {
      if (!partial && !ctx.explicit) return null;
      return {
        from,
        options: topLevel.map(c => toCompletion(c)),
        validFor: /^[\w.]*$/,
      };
    }

    const head = words[0].toUpperCase();

    // ── position 1 of a container: subcommands only ──────────────────
    if (words.length === 1 && CONTAINERS.has(head)) {
      const subs = all.filter(c => c.name.startsWith(`${head} `));
      return {
        from,
        options: subs.map(c => ({
          ...toCompletion(c),
          // Show just the subcommand as the label — the container is typed.
          label: c.name.slice(head.length + 1),
        })),
        validFor: /^[\w-]*$/,
      };
    }

    const cmd = resolveCommand(words);
    if (!cmd) return null;

    // How many arguments have been typed after the command name.
    const consumed = cmd.name.includes(' ') ? 2 : 1;
    const argIndex = words.length - consumed;

    const opts: Completion[] = [];

    // ── key names, when the command takes a key first ────────────────
    if (argIndex === 0 && firstArgIsKey(cmd) && options.getKeys) {
      const keys = await options.getKeys(partial);
      for (const k of keys) {
        opts.push({ label: k, type: 'variable', detail: 'key', boost: 50 });
      }
    }

    // ── literal tokens this command accepts ──────────────────────────
    for (const t of tokensOf(cmd)) {
      opts.push({ label: t, type: 'enum', detail: 'option' });
    }

    if (opts.length === 0) return null;
    return { from, options: opts, validFor: /^[\w:*.-]*$/ };
  };
}

/**
 * Inline signature for the status bar: the command's syntax with the argument
 * under the cursor marked. Mirrors the SQL editor's signature help.
 */
export function redisSignature(line: string, lineStart: number, cursor: number): string | null {
  const { words } = lineContext(line, lineStart, cursor);
  const cmd = resolveCommand(words);
  if (!cmd) return null;
  const bits = [cmd.name];
  if (cmd.syntax) bits.push(cmd.syntax);
  const tail = cmd.summary ? ` — ${cmd.summary}` : '';
  return bits.join(' ') + tail;
}
