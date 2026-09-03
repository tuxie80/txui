/**
 * Postfix completion (src/utils/sqlPostfix.ts wired into sqlComplete.ts),
 * driven exactly as CodeMirror drives it: real documents, real caret positions,
 * and the ACCEPT path exercised through a real EditorState so the snippet
 * machinery (tab-stops, whole-span replacement) runs for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { buildCompletionSource } from '../src/utils/sqlComplete.ts';
import type { CompletionProviders } from '../src/utils/sqlComplete.ts';
import { postfixCompletions } from '../src/utils/sqlPostfix.ts';
import type { SchemaCompletion } from '../src/components/SqlEditor.ts';

// ── the same minimal CompletionContext stand-in the completion tests use ─────

class FakeContext {
  readonly pos: number;
  readonly explicit: boolean;
  readonly state: { doc: { toString(): string }; sliceDoc(from: number, to: number): string };
  private doc: string;

  constructor(doc: string, pos = doc.length, explicit = false) {
    this.doc = doc;
    this.pos = pos;
    this.explicit = explicit;
    this.state = {
      doc: { toString: () => doc },
      sliceDoc: (from: number, to: number) => doc.slice(from, to),
    };
  }

  matchBefore(re: RegExp): { from: number; to: number; text: string } | null {
    const lineStart = this.doc.lastIndexOf('\n', this.pos - 1) + 1;
    const text = this.doc.slice(lineStart, this.pos);
    const anchored = new RegExp(`(?:${re.source})$`, re.flags.replace('g', ''));
    const m = anchored.exec(text);
    if (!m) return null;
    return { from: lineStart + m.index, to: this.pos, text: m[0] };
  }
}

const OBJECTS: SchemaCompletion[] = [
  { label: 'orders', type: 'table', kind: 'table', apply: 'shop.orders', detail: 'shop' },
  { label: 'customers', type: 'table', kind: 'table', apply: 'shop.customers', detail: 'shop' },
  { label: 'shop', type: 'database', kind: 'schema' },
];

const COLUMNS: Record<string, SchemaCompletion[]> = {
  'shop.orders': [
    { label: 'id', type: 'column', detail: 'int', pk: true },
    { label: 'state', type: 'column', detail: "enum('new','paid')" },
  ],
};

const providers: CompletionProviders = {
  getColumns: async t => COLUMNS[t.replace(/[`"]/g, '').toLowerCase()] ?? [],
  getSchemaTables: async s => (s.toLowerCase() === 'shop'
    ? OBJECTS.filter(o => o.kind === 'table')
    : []),
};

const source = buildCompletionSource('mysql', OBJECTS, providers);

async function offerOptions(doc: string, src = source) {
  const res = await src(new FakeContext(doc) as never);
  return { res, options: (res?.options ?? []) as { label: unknown; apply?: unknown; detail?: unknown }[] };
}
const labels = (opts: { label: unknown }[]) => opts.map(o => String(o.label));

/**
 * Accept a completion the way CodeMirror would: build a real EditorState with
 * the caret where the user left it, call the option's apply, read back the new
 * document and caret. Returns null when the option has no apply function.
 */
function accept(doc: string, opt: { apply?: unknown }, from: number, to: number)
  : { text: string; caret: number } | null {
  if (typeof opt.apply !== 'function') return null;
  const state = EditorState.create({ doc, selection: { anchor: to } });
  let tr: { state: EditorState } | null = null;
  const view = { state, dispatch: (t: { state: EditorState }) => { tr = t; } };
  (opt.apply as (v: unknown, c: unknown, f: number, t: number) => void)(view, opt, from, to);
  if (!tr) return null;
  const done = tr as unknown as { state: EditorState };
  return { text: done.state.doc.toString(), caret: done.state.selection.main.head };
}

// ── presence: postfixes appear after a chain + dot ───────────────────────────

test('a table name followed by a dot offers every postfix for the engine', async () => {
  const { options } = await offerOptions('orders.');
  const ls = labels(options);
  for (const p of ['sel', 'where', 'count', 'orderby', 'join', 'ins', 'desc']) {
    assert.ok(ls.includes(p), `postfix "${p}" missing — got: ${ls.join(', ')}`);
  }
});

test('fuzzy trigger: typing `orders.se` still offers `sel`', async () => {
  const { res, options } = await offerOptions('orders.se');
  assert.ok(labels(options).includes('sel'), `got: ${labels(options).join(', ')}`);
  // the result spans the text after the dot, so CodeMirror's filter sees "se"…
  assert.equal(res?.from, 'orders.'.length);
  // …while accepting replaces the whole chain
  const sel = options.find(o => String(o.label) === 'sel')!;
  const applied = accept('orders.se', sel, res!.from, 'orders.se'.length)!;
  assert.equal(applied.text, 'SELECT * FROM orders');
});

test('postfixes are ADDITIONAL: the normal column completion survives intact', async () => {
  const { options } = await offerOptions('SELECT * FROM shop.orders o WHERE o.');
  const ls = labels(options);
  assert.ok(ls.includes('id') && ls.includes('state'), `columns missing — got: ${ls.join(', ')}`);
  assert.ok(ls.includes('sel') && ls.includes('count'), 'postfixes must ride alongside');
});

test('an unknown qualifier still gets postfixes (the chain needs no catalog)', async () => {
  const { options } = await offerOptions('mystery.');
  assert.ok(labels(options).includes('sel'));
});

// ── the expansions themselves ────────────────────────────────────────────────

test('every postfix expands to its statement, chain verbatim, whole span replaced', () => {
  const expected: Record<string, string> = {
    sel: 'SELECT * FROM orders',
    where: 'SELECT * FROM orders WHERE ',
    count: 'SELECT COUNT(*) FROM orders',
    orderby: 'SELECT * FROM orders ORDER BY ',
    join: 'SELECT * FROM orders t1 JOIN table2 t2 ON t2.col = t1.col',
    ins: 'INSERT INTO orders (cols) VALUES (vals)',
    desc: 'DESCRIBE orders',
  };
  const opts = postfixCompletions('orders', 0, 'mysql');
  assert.equal(opts.length, Object.keys(expected).length);
  for (const opt of opts) {
    const doc = `orders.${String(opt.label)}`;
    // from/to as CodeMirror passes them (result.from after the dot) — the
    // apply must ignore it and reach back to the chain start (offset 0 here).
    const applied = accept(doc, opt, 'orders.'.length, doc.length);
    assert.ok(applied, `${String(opt.label)} has no snippet apply`);
    assert.equal(applied!.text, expected[String(opt.label)], String(opt.label));
  }
});

test('a qualified chain is inserted verbatim', () => {
  const opt = postfixCompletions('shop.orders', 0, 'mysql')
    .find(o => String(o.label) === 'count')!;
  const doc = 'shop.orders.cou';
  const applied = accept(doc, opt, 'shop.orders.'.length, doc.length)!;
  assert.equal(applied.text, 'SELECT COUNT(*) FROM shop.orders');
});

test('the caret lands where typing continues (tab-stops live)', () => {
  const sel = postfixCompletions('orders', 0, 'mysql').find(o => String(o.label) === 'sel')!;
  // `${1:*}` — the column list is selected, so typing replaces the star
  const a = accept('orders.sel', sel, 0, 'orders.sel'.length)!;
  assert.equal(a.caret, 'SELECT *'.length, 'caret after the selected `*`');

  const where = postfixCompletions('orders', 0, 'mysql').find(o => String(o.label) === 'where')!;
  const b = accept('orders.where', where, 0, 'orders.where'.length)!;
  assert.equal(b.caret, b.text.length, 'caret right after WHERE');
});

// ── gating ───────────────────────────────────────────────────────────────────

test('`desc` exists only where DESCRIBE is valid syntax', () => {
  for (const engine of ['mysql', 'clickhouse'] as const) {
    assert.ok(postfixCompletions('orders', 0, engine).some(o => String(o.label) === 'desc'),
      `desc must be offered on ${engine}`);
  }
  for (const engine of ['postgres', 'sqlite', 'duckdb', 'parquet'] as const) {
    assert.ok(!postfixCompletions('orders', 0, engine).some(o => String(o.label) === 'desc'),
      `desc must NOT be offered on ${engine}`);
  }
});

test('`ins` is not offered on read-only Parquet', () => {
  assert.ok(!postfixCompletions('orders', 0, 'parquet').some(o => String(o.label) === 'ins'));
  assert.ok(postfixCompletions('orders', 0, 'duckdb').some(o => String(o.label) === 'ins'));
});

test('Redis gets no postfixes at all — through the SQL source either', async () => {
  assert.deepEqual(postfixCompletions('orders', 0, 'redis'), []);
  const redis = buildCompletionSource('redis', OBJECTS, providers);
  const { options } = await offerOptions('orders.se', redis);
  assert.ok(!labels(options).includes('sel'), 'a postfix leaked into Redis mode');
});

test('no postfix inside a string literal or a comment', async () => {
  const inString = await source(new FakeContext("SELECT * FROM shop.orders WHERE note = 'orders.se") as never);
  assert.equal(inString, null, 'completion inside a string must stay silent');
  const inComment = await source(new FakeContext('-- orders.se') as never);
  assert.equal(inComment, null, 'completion inside a comment must stay silent');
});
