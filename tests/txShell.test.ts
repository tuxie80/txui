/**
 * TxShell line parsing (src/utils/txShell.ts).
 *
 * The parser decides what a typed line *means*, so its failures are the
 * dangerous kind: a `>` read as a redirect instead of a comparison silently
 * truncates a WHERE clause, and a `|` inside a string literal chops a statement
 * in half. Both produce SQL that still runs. Most of what follows is about
 * telling those characters apart from their harmless twins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine, dispatchHead, splitPipeline, splitArgs, unquote,
  substituteVars, substituteCommands, resultToCommandText,
  isComplete, quotesClosed, pushHistory, HISTORY_CAP, completions,
} from '../src/utils/txShell.ts';
import { parseWhere, findVerb, findMeta, suggest, PIPE } from '../src/utils/txShellGrammar.ts';

// ── dispatch: nothing is guessed ────────────────────────────────────────────

test('a bare line is SQL', () => {
  assert.deepEqual(dispatchHead('SELECT 1'), { kind: 'sql', sql: 'SELECT 1' });
});

test('each prefix selects exactly one meaning', () => {
  assert.equal(dispatchHead('\\d orders').kind, 'meta');
  assert.equal(dispatchHead('!ls -la').kind, 'os');
  assert.equal(dispatchHead('@prod-* SELECT 1').kind, 'fanout');
  assert.equal(dispatchHead('$x = 5').kind, 'assign');
  assert.equal(dispatchHead('   ').kind, 'empty');
});

test('a meta command keeps its arguments, quoted ones intact', () => {
  const h = dispatchHead('\\d "my table"');
  assert.deepEqual(h, { kind: 'meta', name: 'd', args: ['my table'] });
});

test('command names are case-insensitive', () => {
  assert.equal((dispatchHead('\\HELP') as { name: string }).name, 'help');
});

test('a transposed verb is still recognised as a typo', () => {
  // The commonest typing mistake there is; plain Levenshtein scores it 2 and
  // would offer nothing.
  assert.equal(suggest('tial', ['head', 'tail']), 'tail');
  assert.equal(suggest('slect', ['select', 'sort']), 'select');
});

test('a fanout carries its pattern and its statement separately', () => {
  const h = dispatchHead('@prod-* SELECT COUNT(*) FROM orders');
  assert.deepEqual(h, { kind: 'fanout', pattern: 'prod-*', sql: 'SELECT COUNT(*) FROM orders' });
});

test('incomplete prefixes report what is missing rather than doing something', () => {
  // `@prod-*` alone must not run against every production server.
  const f = dispatchHead('@prod-*');
  assert.equal(f.kind, 'error');
  assert.match((f as { message: string }).message, /needs a statement/);
  assert.equal(dispatchHead('!').kind, 'error');
  assert.equal(dispatchHead('\\').kind, 'error');
});

test('an assignment captures the whole right-hand side', () => {
  assert.deepEqual(dispatchHead('$cutoff = 2026-01-01 00:00'),
    { kind: 'assign', name: 'cutoff', value: '2026-01-01 00:00' });
});

// ── the ambiguity, designed out ─────────────────────────────────────────────

test('a greater-than is ALWAYS a comparison — there is no `>` redirect', () => {
  // This is the line that forced the grammar. `> 100` cannot be a redirect to
  // a file named "100", because `>` is never shell punctuation here.
  const p = parseLine('SELECT * FROM orders WHERE total > 100');
  assert.equal(p.head.kind, 'sql');
  assert.equal((p.head as { sql: string }).sql, 'SELECT * FROM orders WHERE total > 100');
  assert.equal(p.stages.length, 0);
});

test('every comparison operator survives untouched', () => {
  for (const sql of [
    'SELECT * FROM t WHERE a > 5',
    'SELECT * FROM t WHERE a >= 5',
    'SELECT * FROM t WHERE a < 5',
    'SELECT * FROM t WHERE a <= 5',
    'SELECT * FROM t WHERE a <> 5',
    'SELECT * FROM t WHERE a != 5',
  ]) {
    const p = parseLine(sql);
    assert.equal((p.head as { sql: string }).sql, sql, sql);
  }
});

test('a bare | stays SQL bitwise-or', () => {
  const p = parseLine('SELECT flags | 4 AS f FROM t');
  assert.equal((p.head as { sql: string }).sql, 'SELECT flags | 4 AS f FROM t');
  assert.equal(p.stages.length, 0);
});

test('a bare | before a known verb is caught and explained', () => {
  // Reaching for a Unix pipe should not silently compute a bitwise-or.
  const p = parseLine('SELECT * FROM t | head 5');
  assert.equal(p.stages.length, 0);
  assert.match(p.error ?? '', /Use `\|>` for pipelines/);
});

test('PostgreSQL string concatenation is not a pipe', () => {
  const p = parseLine("SELECT a || b FROM t");
  assert.equal(p.stages.length, 0);
});

test('a pipe inside a string or a dollar-quoted body does not split', () => {
  assert.equal(parseLine("SELECT 'a|>b' AS x").stages.length, 0);
  assert.equal(parseLine('DO $$ BEGIN PERFORM 1; END $$').stages.length, 0);
});

// ── pipelines ───────────────────────────────────────────────────────────────

test('a pipeline splits into head and stages', () => {
  const p = parseLine('SELECT * FROM orders |> where total > 100 |> head 20');
  assert.equal((p.head as { sql: string }).sql, 'SELECT * FROM orders');
  assert.deepEqual(p.stages.map(s => s.name), ['where', 'head']);
  assert.deepEqual(p.stages[1].args, ['20']);
  // The comparison inside the stage is still a comparison.
  assert.deepEqual(p.stages[0].args, ['total', '>', '100']);
});

test('diff requires an explicit captured result id and accepts key columns', () => {
  const p = parseLine('SELECT id, value FROM new |> diff #12 key id tenant');
  assert.deepEqual(p.stages[0], {
    name: 'diff', args: ['#12', 'key', 'id', 'tenant'], raw: 'diff #12 key id tenant',
  });
  assert.equal(parseLine('SELECT 1 |> diff').head.kind, 'error');
  const followed = parseLine('SELECT 1 |> diff #12 |> head 5');
  assert.deepEqual(followed.stages.map(s => s.name), ['diff', 'head']);
  assert.equal(parseLine('SELECT 1 #123 |> head 5').stages.length, 0,
    'an ordinary numeric SQL comment still hides the pipe');
});

test('a sink ends the pipeline and takes the filename', () => {
  const p = parseLine('SELECT 1 |> save out.csv');
  assert.deepEqual(p.stages.map(s => s.name), ['save']);
  assert.deepEqual(p.stages[0].args, ['out.csv']);
});

test('a quoted filename keeps its spaces', () => {
  const p = parseLine('SELECT 1 |> save "my report.csv"');
  assert.deepEqual(p.stages[0].args, ['my report.csv']);
});

test('nothing may follow a sink', () => {
  const p = parseLine('SELECT 1 |> save out.csv |> head 5');
  assert.equal(p.head.kind, 'error');
  assert.match((p.head as { message: string }).message, /has to come last/);
});

test('an empty pipeline stage is an error, not a silent no-op', () => {
  assert.equal(parseLine('SELECT 1 |> |> head 2').head.kind, 'error');
});

test('an OS line is handed over verbatim, pipes and redirects included', () => {
  // `!ls | wc -l` must mean in TxShell exactly what it means in a terminal.
  const p = parseLine('!ls -la | wc -l > count.txt');
  assert.deepEqual(p.head, { kind: 'os', command: 'ls -la | wc -l > count.txt' });
  assert.equal(p.stages.length, 0);
});

// ── helpful failure ─────────────────────────────────────────────────────────

test('an unknown verb suggests the closest real one', () => {
  const p = parseLine('SELECT 1 |> hed 5');
  assert.match((p.head as { message: string }).message, /Unknown verb `hed`.*did you mean `head`/);
});

test('an unknown meta command suggests the closest real one', () => {
  const p = parseLine('\\halp');
  assert.match((p.head as { message: string }).message, /did you mean `\\help`/);
});

test('a wrong argument count states the usage', () => {
  const p = parseLine('SELECT 1 |> head');
  assert.match((p.head as { message: string }).message, /needs 1 argument.*usage: head <n>/);
});

test('a source verb used as a stage says where it belongs', () => {
  const p = parseLine('SELECT 1 |> from x.csv');
  assert.match((p.head as { message: string }).message, /starts a line/);
});

test('a source verb starts a line', () => {
  const p = parseLine('from orders.csv |> head 10');
  assert.deepEqual(p.head, { kind: 'source', name: 'from', args: ['orders.csv'] });
  assert.deepEqual(p.stages.map(s => s.name), ['head']);
});

test('a comment line does nothing', () => {
  assert.equal(parseLine('# just a note').head.kind, 'comment');
});

// ── where ───────────────────────────────────────────────────────────────────

test('where parses one typed comparison', () => {
  assert.deepEqual(parseWhere(['total', '>', '100']),
    { column: 'total', op: '>', value: '100' });
  assert.deepEqual(parseWhere(['email', 'like', '%@x.com']),
    { column: 'email', op: 'like', value: '%@x.com' });
});

test('where refuses AND/OR and says where they belong', () => {
  const r = parseWhere(['a', '>', '1', 'AND', 'b', '<', '2']) as { error: string };
  assert.match(r.error, /one comparison.*WHERE clause.*index/s);
});

test('where reports a bad operator with a suggestion', () => {
  const r = parseWhere(['a', 'lke', 'x']) as { error: string };
  assert.match(r.error, /did you mean `like`/);
});

test('where reports a missing value', () => {
  assert.match((parseWhere(['a', '>']) as { error: string }).error, /missing a value/);
});

// ── registry and completion ─────────────────────────────────────────────────

test('every verb documents itself', () => {
  for (const n of ['where', 'select', 'sort', 'head', 'diff', 'save', 'to', 'from']) {
    const v = findVerb(n);
    assert.ok(v, n);
    assert.ok(v.usage.length > 2 && v.summary.length > 10, `${n} is undocumented`);
  }
});

test('psql muscle memory works', () => {
  assert.equal(findMeta('d')?.name, 'd');
  assert.equal(findMeta('?')?.name, 'help', 'the ? alias should reach help');
  assert.equal(findMeta('connect')?.name, 'c');
});

test('suggestions do not fire on genuinely different words', () => {
  assert.equal(suggest('xyzzy', ['head', 'tail']), undefined);
  assert.equal(suggest('tial', ['head', 'tail']), 'tail');
});

test('completion offers stages after a pipe and meta commands after a backslash', () => {
  const afterPipe = completions('SELECT 1 |> he', 14);
  assert.ok(afterPipe.includes('head'), afterPipe.join(','));
  assert.ok(!afterPipe.includes('from'), 'a source cannot follow a pipe');
  assert.ok(completions('SELECT 1 |> di', 14).includes('diff'));
  assert.match(findVerb('diff')?.usage ?? '', /#<result-id>.*key/);

  const afterSlash = completions('\\d', 3);
  assert.ok(afterSlash.some(c => c.startsWith('\\d')), afterSlash.join(','));

  // Mid-SQL, the editor's own completion is the right answer.
  assert.deepEqual(completions('SELECT * FROM ord', 17), []);
});

test('PIPE is the two-character operator the grammar promises', () => {
  assert.equal(PIPE, '|>');
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('splitPipeline ignores the operator inside quotes and parens', () => {
  assert.deepEqual(splitPipeline('a |> b'), ['a ', ' b']);
  assert.deepEqual(splitPipeline("a |> 'b |> c'"), ['a ', " 'b |> c'"]);
  assert.deepEqual(splitPipeline('f(a |> b) |> c'), ['f(a |> b) ', ' c']);
});

test('splitArgs respects quotes and collapses whitespace', () => {
  assert.deepEqual(splitArgs('a  b   c'), ['a', 'b', 'c']);
  assert.deepEqual(splitArgs('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepEqual(splitArgs(''), []);
});

test('unquote removes only one surrounding layer', () => {
  assert.equal(unquote('"a"'), 'a');
  assert.equal(unquote("'a'"), 'a');
  assert.equal(unquote('a'), 'a');
  assert.equal(unquote('"a'), '"a', 'an unbalanced quote is left alone');
});

// ── variables ───────────────────────────────────────────────────────────────

test('variables substitute in both forms', () => {
  const r = substituteVars('SELECT * FROM $tbl WHERE id = ${id}', { tbl: 'orders', id: '7' });
  assert.equal(r.text, 'SELECT * FROM orders WHERE id = 7');
  assert.deepEqual(r.missing, []);
});

test('an unset variable is REPORTED and left as written', () => {
  // Blanking it would turn `WHERE id = $missing` into `WHERE id =` — or worse,
  // into a statement that still parses and matches every row.
  const r = substituteVars('DELETE FROM t WHERE id = $nope', {});
  assert.equal(r.text, 'DELETE FROM t WHERE id = $nope');
  assert.deepEqual(r.missing, ['nope']);
});

test('a variable set to an empty string is not "missing"', () => {
  const r = substituteVars('x=$e', { e: '' });
  assert.equal(r.text, 'x=');
  assert.deepEqual(r.missing, []);
});

test('each missing name is reported once', () => {
  const r = substituteVars('$a $a $b', {});
  assert.deepEqual(r.missing, ['a', 'b']);
});

// ── command substitution ────────────────────────────────────────────────────

test('command substitution expands through the supplied TxShell executor', async () => {
  const calls: Array<[string, number]> = [];
  const out = await substituteCommands('SELECT $(SELECT 41 + 1) AS n', async (command, depth) => {
    calls.push([command, depth]);
    return '42';
  });
  assert.equal(out, 'SELECT 42 AS n');
  assert.deepEqual(calls, [['SELECT 41 + 1', 1]]);
});

test('multiple substitutions run deterministically from left to right', async () => {
  const calls: string[] = [];
  const out = await substituteCommands('$(one) / $(two) / $(three)', async command => {
    calls.push(command);
    return command.toUpperCase();
  });
  assert.equal(out, 'ONE / TWO / THREE');
  assert.deepEqual(calls, ['one', 'two', 'three']);
});

test('SQL strings, identifiers, dollar quotes and comments are preserved', async () => {
  let calls = 0;
  const execute = async () => { calls++; return 'BAD'; };
  const input = "SELECT '$(literal)', \"$(identifier)\", `$(tick)`, $$ $(body) $$ "
    + '-- $(line comment)\n/* $(block comment) */ 1';
  assert.equal(await substituteCommands(input, execute), input);
  assert.equal(calls, 0);
  assert.equal(await substituteCommands('SELECT 1 -- note\n + $(SELECT 2)', async () => '2'),
    'SELECT 1 -- note\n + 2');
});

test('nested parens, quoted close parens and nested substitutions are scanned correctly', async () => {
  const commands: string[] = [];
  await substituteCommands('x $(SELECT fn(\')\', (1 + 2), $(SELECT 3))) y', async command => {
    commands.push(command);
    return 'ok';
  });
  assert.deepEqual(commands, ["SELECT fn(')', (1 + 2), $(SELECT 3))"]);
  assert.equal(await substituteCommands('$(SELECT 1 |> diff #12)', async () => 'same'), 'same');
});

test('nested execution is bounded and cannot recurse without limit', async () => {
  const run: (command: string, depth: number) => Promise<string> = async (command, depth) =>
    substituteCommands(command, run, { depth });
  let nested = 'SELECT 1';
  for (let i = 0; i < 4; i++) nested = `$(${nested})`;
  assert.equal(await run(nested, 0), 'SELECT 1');
  await assert.rejects(run(`$(${nested})`, 0), /nested more than 4 levels/);
});

test('combined substitution output is capped across one line', async () => {
  await assert.rejects(substituteCommands('$(a) $(b)', async () => '123456', { maxOutput: 10 }),
    /output exceeded 10 characters.*Nothing was run/);
  await assert.rejects(substituteCommands('$(a)', async () => '12345', { maxOutput: 4 }),
    /output exceeded/);
});

test('empty, unclosed and failed substitutions propagate errors', async () => {
  await assert.rejects(substituteCommands('$()', async () => ''), /Empty/);
  await assert.rejects(substituteCommands('$(SELECT 1', async () => ''), /Unclosed/);
  const failure = new Error('database said no');
  await assert.rejects(substituteCommands('$(SELECT broken)', async () => { throw failure; }),
    e => e === failure);
});

test('single-cell results become deterministic scalars', () => {
  assert.equal(resultToCommandText({ rows: [] }), '');
  assert.equal(resultToCommandText({ rows: [[42]] }), '42');
  assert.equal(resultToCommandText({ rows: [[null]] }), 'NULL');
  assert.equal(resultToCommandText({ rows: [[true]] }), 'true');
  assert.equal(resultToCommandText({ rows: [[{ z: 1, a: { d: 2, c: 3 } }]] }),
    '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(resultToCommandText({ rows: [[{ text: 'a"b', nil: null, list: ['x', 2] }]] }),
    '{"list":["x",2],"nil":null,"text":"a\\"b"}');
});

test('structured results become headerless TSV with unambiguous whitespace', () => {
  const text = resultToCommandText({ rows: [
    [1, 'a\tb', 'line\nbreak'],
    [2, null, 'c:\\d'],
  ] });
  assert.equal(text, '1\ta\\tb\tline\\nbreak\n2\tNULL\tc:\\\\d');
});

// ── multi-line input ────────────────────────────────────────────────────────

test('the prompt stays open until the statement is terminated', () => {
  assert.equal(isComplete('SELECT 1'), false);
  assert.equal(isComplete('SELECT 1;'), true);
  assert.equal(isComplete('SELECT 1;\nSELECT 2;'), true);
});

test('a semicolon inside a string does not end the statement', () => {
  assert.equal(isComplete("SELECT 'a;b'"), false);
  assert.equal(isComplete("SELECT 'a;b';"), true);
});

test('an unclosed quote keeps the prompt open', () => {
  assert.equal(isComplete("SELECT 'unterminated"), false);
});

test('an unclosed dollar-quoted body keeps the prompt open', () => {
  // Pasting a CREATE FUNCTION line by line must not fire on the first `;`.
  assert.equal(isComplete('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1;'), false);
  assert.equal(isComplete('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$;'), true);
});

test('verbs, OS lines and assignments are always single-line', () => {
  for (const s of ['\\d orders', '!ls', '@prod-* SELECT 1', '$x = 5']) {
    assert.equal(isComplete(s), true, s);
  }
});

test('a custom delimiter terminates the statement', () => {
  assert.equal(isComplete('SELECT 1', 'GO'), false);
  assert.equal(isComplete('SELECT 1 GO', 'GO'), true);
  // An empty delimiter falls back to `;` rather than matching everywhere.
  assert.equal(isComplete('SELECT 1;', ''), true);
});

test('a pipeline completes the line without a semicolon', () => {
  // The `|>` already says the statement ended.
  assert.equal(isComplete('SELECT 1 |> head 5'), true);
});

test('an empty buffer is complete', () => {
  assert.equal(isComplete(''), true);
  assert.equal(isComplete('   \n '), true);
});

// ── bare-line Enter (the shell runs a single unterminated line) ─────────────
// The submit path runs a single-line buffer when isComplete OR quotesClosed —
// this is the difference between "Enter runs my query" and "Enter ate my
// query into an invisible pending buffer".

test('quotesClosed: a bare line is runnable, an open quote is not', () => {
  assert.equal(quotesClosed('SELECT 1'), true);
  assert.equal(quotesClosed('select * from t where x = 1'), true);
  assert.equal(quotesClosed("SELECT 'a;b'"), true, 'closed quote, missing terminator — run it');
  assert.equal(quotesClosed("SELECT 'unterminated"), false, 'open quote — the user is mid-literal');
  assert.equal(quotesClosed('SELECT `backtick'), false);
  assert.equal(quotesClosed('CREATE FUNCTION f() AS $$ BEGIN'), false, 'open dollar-quote');
  assert.equal(quotesClosed('CREATE FUNCTION f() AS $$ BEGIN RETURN 1; END $$'), true);
  assert.equal(quotesClosed(''), true);
});

// ── history ─────────────────────────────────────────────────────────────────

test('history skips consecutive duplicates and blank lines', () => {
  let h: string[] = [];
  h = pushHistory(h, 'SELECT 1');
  h = pushHistory(h, 'SELECT 1');
  h = pushHistory(h, '   ');
  h = pushHistory(h, 'SELECT 2');
  assert.deepEqual(h, ['SELECT 1', 'SELECT 2']);
});

test('a repeat that is not consecutive is kept', () => {
  const h = pushHistory(pushHistory(pushHistory([], 'a'), 'b'), 'a');
  assert.deepEqual(h, ['a', 'b', 'a']);
});

test('history is capped from the front', () => {
  let h: string[] = [];
  for (let i = 0; i < HISTORY_CAP + 30; i++) h = pushHistory(h, `q${i}`);
  assert.equal(h.length, HISTORY_CAP);
  assert.equal(h[h.length - 1], `q${HISTORY_CAP + 29}`);
  assert.ok(!h.includes('q0'), 'the oldest entries should have been shed');
});

// ── \\generate (datagen Phase 5) ─────────────────────────────────────────────

test('\\generate is a registered meta and keeps a quoted JSON spec as one argument', () => {
  const spec = findMeta('generate');
  assert.ok(spec, '\\generate must be in the meta registry');
  assert.match(spec!.summary, /headless/);
  const h = dispatchHead('\\generate \'{"table":"t","rowCount":10,"specs":[]}\'');
  assert.deepEqual(h, {
    kind: 'meta', name: 'generate',
    args: ['{"table":"t","rowCount":10,"specs":[]}'],
  });
  const f = dispatchHead('\\generate spec.json');
  assert.deepEqual(f, { kind: 'meta', name: 'generate', args: ['spec.json'] });
});
