/**
 * TxShell grammar — the rules, and why they are these rules.
 *
 * A shell that mixes SQL with shell punctuation has one hard problem, and
 * everything else follows from how it is answered:
 *
 *     SELECT * FROM orders WHERE total > 100
 *
 * Is `> 100` a comparison or a redirect to a file named `100`? Unix shells
 * never face this because they have no SQL; FluidShell faces it and answers
 * with *modes* — you tell it in advance whether you are speaking SQL or shell,
 * and in the mode that guesses, SQL does not even run until you type `go`.
 *
 * TxShell answers it by construction instead:
 *
 *   **No shell operator may be a character that is also valid SQL.**
 *
 * That single rule kills the whole class of ambiguity:
 *
 *   - The pipe is `|>`, not `|`. A bare `|` is bitwise-or and stays SQL's.
 *   - There is no `>` redirect at all. Sinks are verbs — `save`, `append` —
 *     so `>` is only ever a comparison.
 *   - There is no `<` redirect. Sources are verbs — `from`.
 *
 * The cost is one unfamiliar operator. The benefit is that no line can ever be
 * read two ways, so no mode is needed to disambiguate, so no buffer is needed
 * to defer execution, so SQL just runs when you type it.
 *
 * Pure and dependency-free — driven by `node --test`.
 */

export type VerbKind = 'stage' | 'sink' | 'source' | 'meta';

export interface VerbSpec {
  name: string;
  kind: VerbKind;
  /** Minimum positional arguments. */
  minArgs: number;
  /** Maximum, or null for unlimited. */
  maxArgs: number | null;
  usage: string;
  summary: string;
  /** Shown in `\help <verb>`; the paragraph that stops a wrong guess. */
  detail?: string;
}

/**
 * The pipeline operator.
 *
 * `|>` cannot occur in any SQL dialect: `|` is bitwise-or and `>` is
 * greater-than, but no expression puts them adjacent. It also reads as "pipe"
 * to anyone who has met F#, Elixir or R.
 */
export const PIPE = '|>';

/**
 * Stages transform a result set. Sinks consume one. Sources produce one.
 *
 * Keeping the registry data rather than a switch is what lets `\help`,
 * completion and argument validation all come from one place — a verb cannot
 * exist without documentation, because the documentation is the definition.
 */
export const VERBS: VerbSpec[] = [
  // ── stages ──
  { name: 'where', kind: 'stage', minArgs: 1, maxArgs: null,
    usage: 'where <column> <op> <value>',
    summary: 'Keep rows matching a typed comparison.',
    detail: 'Comparisons are typed: on a numeric column `where total > 100` compares '
      + 'numbers, not rendered text. Operators: = != < <= > >= like ilike in is. '
      + 'For anything more complex, put it in the SQL WHERE clause — that is what it is for.' },
  { name: 'select', kind: 'stage', minArgs: 1, maxArgs: null,
    usage: 'select <col> [col…]',
    summary: 'Keep only these columns, in this order.' },
  { name: 'sort', kind: 'stage', minArgs: 1, maxArgs: 2,
    usage: 'sort <column> [desc]',
    summary: 'Order rows by a column.' },
  { name: 'head', kind: 'stage', minArgs: 1, maxArgs: 1,
    usage: 'head <n>', summary: 'Keep the first n rows.' },
  { name: 'tail', kind: 'stage', minArgs: 1, maxArgs: 1,
    usage: 'tail <n>', summary: 'Keep the last n rows.' },
  { name: 'count', kind: 'stage', minArgs: 0, maxArgs: 0,
    usage: 'count', summary: 'Replace the rows with their count.' },
  { name: 'stats', kind: 'stage', minArgs: 0, maxArgs: 1,
    usage: 'stats [column]',
    summary: 'Count / sum / avg / min / max over numeric columns.' },
  { name: 'distinct', kind: 'stage', minArgs: 0, maxArgs: null,
    usage: 'distinct [col…]', summary: 'Drop duplicate rows.' },

  // ── sinks ──
  { name: 'save', kind: 'sink', minArgs: 1, maxArgs: 1,
    usage: 'save <file>',
    summary: 'Write the rows to a file, overwriting it.',
    detail: 'The format comes from the extension: .csv .tsv .json .md .sql .xlsx. '
      + 'This is why there is no `>` redirect — `>` stays a comparison operator.' },
  { name: 'append', kind: 'sink', minArgs: 1, maxArgs: 1,
    usage: 'append <file>', summary: 'Write the rows to a file, appending.' },
  { name: 'to', kind: 'sink', minArgs: 1, maxArgs: 1,
    usage: 'to <csv|tsv|json|md|ascii|inserts|html|xml|latex>',
    summary: 'Render the rows in a format, into the shell.' },
  { name: 'insert', kind: 'sink', minArgs: 2, maxArgs: 3,
    usage: 'insert into <table> [@connection]',
    summary: 'Write the rows into a table, on this session or another one.',
    detail: 'Generates INSERT statements from the columns as named and runs them in a '
      + 'transaction, so a failure part-way leaves nothing behind. With a @connection '
      + 'the rows go to a DIFFERENT server than the one that produced them — read from '
      + 'prod, write to dev, with the values typed the whole way rather than round-'
      + 'tripped through a dump file.' },
  { name: 'chart', kind: 'sink', minArgs: 0, maxArgs: 2,
    usage: 'chart [type]', summary: 'Hand the rows to the chart view.' },
  { name: 'grid', kind: 'sink', minArgs: 0, maxArgs: 0,
    usage: 'grid', summary: 'Show the rows in the full result grid (the default).' },

  // ── sources ──
  { name: 'from', kind: 'source', minArgs: 1, maxArgs: 1,
    usage: 'from <file>',
    summary: 'Read a .csv / .tsv / .json file as a result set.',
    detail: 'The same pipeline then works on files and on queries alike.' },
];

const BY_NAME = new Map(VERBS.map(v => [v.name, v]));

export function findVerb(name: string): VerbSpec | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/** Every verb name, for completion and for "did you mean". */
export const VERB_NAMES = VERBS.map(v => v.name);

// ── meta verbs (`\name`) ─────────────────────────────────────────────────────

export interface MetaSpec {
  name: string;
  /** Aliases, e.g. `?` for `help`. */
  alias?: string[];
  usage: string;
  summary: string;
  detail?: string;
}

/**
 * Backslash verbs, deliberately shaped like psql's.
 *
 * A DBA already has `\d` and `\l` in their fingers. Inventing different names
 * for the same operations would buy nothing and cost every user a re-learn.
 */
export const METAS: MetaSpec[] = [
  { name: 'help', alias: ['?', 'h'], usage: '\\help [verb]',
    summary: 'List commands, or explain one.' },
  { name: 'c', alias: ['connect'], usage: '\\c [session]',
    summary: 'Switch session; with no argument, list the open ones.' },
  { name: 'd', alias: ['describe'], usage: '\\d [object]',
    summary: 'Describe a table, view or routine; with no argument, list them.' },
  { name: 'l', alias: ['list'], usage: '\\l',
    summary: 'List databases or schemas.' },
  { name: 'dt', usage: '\\dt [pattern]', summary: 'List tables.' },
  { name: 'df', usage: '\\df [pattern]', summary: 'List functions and procedures.' },
  { name: 'dv', usage: '\\dv [pattern]', summary: 'List views.' },
  { name: 'di', usage: '\\di [pattern]', summary: 'List indexes.' },
  { name: 'dn', usage: '\\dn [pattern]', summary: 'List schemas.' },
  { name: 'dp', alias: ['z'], usage: '\\dp [pattern]', summary: 'List table access privileges.' },
  { name: 'du', alias: ['dg'], usage: '\\du [pattern]', summary: 'List roles.' },
  { name: 'x', usage: '\\x [on|off]', summary: 'Toggle expanded (record-per-line) display.' },
  { name: 'explain', alias: ['e'], usage: '\\explain <sql>',
    summary: 'Run EXPLAIN and open the plan graph.' },
  { name: 'watch', usage: '\\watch <seconds> <command>',
    summary: 'Re-run a command on an interval until stopped.',
    detail: 'The shell keeps the latest result in place rather than scrolling, so a '
      + 'counter or a queue depth can be watched without flooding the transcript.' },
  { name: 'ps', alias: ['top'], usage: '\\ps',
    summary: 'Server processes — the same view as the ⚡ panel.' },
  { name: 'kill', usage: '\\kill <id>',
    summary: 'Kill a server thread. Audited, like every other kill.' },
  { name: 'tx', usage: '\\tx begin|commit|rollback',
    summary: 'Manual transaction control on the current session.' },
  { name: 'timing', usage: '\\timing [on|off]',
    summary: 'Show how long each statement took.' },
  { name: 'vars', usage: '\\vars', summary: 'List the variables you have set.' },
  { name: 'unset', usage: '\\unset <name>', summary: 'Remove a variable.' },
  { name: 'history', usage: '\\history [n]', summary: 'Recent command lines.' },
  { name: 'source', alias: ['i'], usage: '\\source <file>',
    summary: 'Run a TxShell script.' },
  { name: 'edit', usage: '\\edit', summary: 'Open the last statement in the SQL editor.' },
  { name: 'clear', usage: '\\clear', summary: 'Clear the transcript.' },
];

const META_BY_NAME = new Map<string, MetaSpec>();
for (const m of METAS) {
  META_BY_NAME.set(m.name, m);
  for (const a of m.alias ?? []) META_BY_NAME.set(a, m);
}

export function findMeta(name: string): MetaSpec | undefined {
  const key = name.toLowerCase();
  // psql's `+` verbosity suffix (`\d+`, `\dt+`) selects the same command, so a
  // trailing `+` is stripped before the lookup rather than registered per verb.
  return META_BY_NAME.get(key)
    ?? (key.endsWith('+') ? META_BY_NAME.get(key.slice(0, -1)) : undefined);
}

export const META_NAMES = [...META_BY_NAME.keys()];

// ── suggestions ──────────────────────────────────────────────────────────────

/**
 * Damerau-Levenshtein distance — Levenshtein plus transposition.
 *
 * Transposing two letters (`tial` for `tail`, `slect` for `select`) is the
 * single commonest typing mistake, and plain Levenshtein scores it as two
 * edits — the same as two unrelated wrong letters. That is enough to push it
 * past any threshold tight enough to be useful, so the most common typo would
 * be the one that got no suggestion. Counting a swap as one edit fixes it.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  // Three rows: two back is what a transposition needs to see.
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/**
 * The closest known name, when there is one worth offering.
 *
 * "Unknown verb: hed" is a dead end; "Unknown verb `hed` — did you mean
 * `head`?" is the difference between a shell that helps and one that scolds.
 */
export function suggest(name: string, candidates: string[]): string | undefined {
  const q = name.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(q, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  // Two edits on a short word is already a different word.
  const limit = q.length <= 4 ? 1 : 2;
  return bestD <= limit ? best : undefined;
}

/** Validate a verb's argument count against its spec. */
export function checkArity(spec: VerbSpec, args: string[]): string | null {
  if (args.length < spec.minArgs) {
    return `\`${spec.name}\` needs ${spec.minArgs} argument${spec.minArgs === 1 ? '' : 's'}`
      + ` — usage: ${spec.usage}`;
  }
  if (spec.maxArgs !== null && args.length > spec.maxArgs) {
    return `\`${spec.name}\` takes at most ${spec.maxArgs} argument${spec.maxArgs === 1 ? '' : 's'}`
      + ` — usage: ${spec.usage}`;
  }
  return null;
}

// ── the `where` expression ───────────────────────────────────────────────────

export const WHERE_OPS = ['>=', '<=', '!=', '<>', '=', '>', '<',
  'like', 'ilike', 'in', 'is'] as const;
export type WhereOp = typeof WHERE_OPS[number];

export interface WhereClause {
  column: string;
  op: WhereOp;
  /** Raw right-hand side, still to be coerced against the column's type. */
  value: string;
}

/**
 * Parse `where` arguments into a single comparison.
 *
 * Deliberately one comparison, not an expression language. A shell filter that
 * grows AND/OR/parentheses becomes a second, worse SQL — and the answer to "my
 * filter is complicated" is to put it in the WHERE clause, where the database
 * can use an index for it. The error message says exactly that.
 */
export function parseWhere(args: string[]): WhereClause | { error: string } {
  if (args.length < 2) {
    return { error: 'where needs a column, an operator and a value — e.g. `where total > 100`' };
  }
  if (args.some(a => /^(and|or)$/i.test(a))) {
    return {
      error: 'where takes one comparison. Combine conditions in the SQL WHERE clause '
        + 'instead — the database can use an index there, and this cannot.',
    };
  }
  const [column, rawOp, ...rest] = args;
  const op = rawOp.toLowerCase();
  if (!(WHERE_OPS as readonly string[]).includes(op)) {
    const hint = suggest(op, [...WHERE_OPS]);
    return {
      error: `Unknown operator \`${rawOp}\`${hint ? ` — did you mean \`${hint}\`?` : ''}`
        + ` Operators: ${WHERE_OPS.join(' ')}`,
    };
  }
  if (rest.length === 0) {
    return { error: `\`where ${column} ${rawOp}\` is missing a value` };
  }
  return { column, op: op as WhereOp, value: rest.join(' ') };
}
