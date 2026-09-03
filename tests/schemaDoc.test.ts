/**
 * Schema documentation (src/utils/schemaDoc.ts).
 *
 * The requirement that decides everything: the output must be committable, so
 * regenerating it against an unchanged schema must produce a byte-identical
 * file. A documenter that reorders its own output produces a diff on every run
 * and gets deleted from the repository within a week.
 *
 * So the tests that matter are about determinism, not about formatting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseDoc, toMarkdown, toMermaid, toHtmlDoc, docFileName,
} from '../src/utils/schemaDoc.ts';
import type { SchemaDoc, DocTable } from '../src/utils/schemaDoc.ts';

const table = (over: Partial<DocTable> = {}): DocTable => ({
  schema: 'shop', name: 'orders', columns: [], indexes: [], foreignKeys: [], ...over,
});

const doc = (over: Partial<SchemaDoc> = {}): SchemaDoc => ({
  schema: 'shop', engine: 'mysql', tables: [], routines: [], ...over,
});

// ── determinism, which is the whole point ───────────────────────────────────

test('the same schema in a different order documents identically', () => {
  const a = doc({ tables: [table({ name: 'a' }), table({ name: 'b' })] });
  const b = doc({ tables: [table({ name: 'b' }), table({ name: 'a' })] });
  assert.equal(toMarkdown(a), toMarkdown(b));
});

test('indexes and foreign keys are sorted too', () => {
  const t = table({
    indexes: [
      { name: 'z_idx', unique: false, columns: ['z'] },
      { name: 'a_idx', unique: true, columns: ['a'] },
    ],
    foreignKeys: [
      { name: 'fk_z', columns: ['z'], refTable: 'zz', refColumns: ['id'] },
      { name: 'fk_a', columns: ['a'], refTable: 'aa', refColumns: ['id'] },
    ],
  });
  const n = normaliseDoc(doc({ tables: [t] })).tables[0];
  assert.deepEqual(n.indexes.map(i => i.name), ['a_idx', 'z_idx']);
  assert.deepEqual(n.foreignKeys.map(f => f.name), ['fk_a', 'fk_z']);
});

test('columns keep their DECLARED order', () => {
  // Column order is information — the physical layout of the row. Sorting it
  // alphabetically would be tidier and would destroy that.
  const t = table({ columns: [
    { name: 'z', type: 'int', nullable: false },
    { name: 'a', type: 'int', nullable: false },
  ] });
  assert.deepEqual(
    normaliseDoc(doc({ tables: [t] })).tables[0].columns.map(c => c.name),
    ['z', 'a']);
});

test('normalising does not mutate the input', () => {
  const input = doc({ tables: [table({ name: 'b' }), table({ name: 'a' })] });
  normaliseDoc(input);
  assert.deepEqual(input.tables.map(t => t.name), ['b', 'a']);
});

test('no timestamp appears in the output', () => {
  // "Generated at 14:03" makes every regeneration a non-empty diff.
  const md = toMarkdown(doc({ tables: [table()] }));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(md), md);
  assert.ok(!/generated/i.test(md), md);
});

test('row counts are opt-in', () => {
  // TABLE_ROWS is an estimate that drifts on every write, so including it by
  // default would make the document diff constantly for no schema change.
  const d = doc({ tables: [table({ rows: 1234 })] });
  assert.ok(!toMarkdown(d).includes('1,234'));
  assert.ok(toMarkdown(d, { includeRowCounts: true }).includes('1,234'));
});

// ── markdown content ────────────────────────────────────────────────────────

test('a table renders its columns with nullability and defaults', () => {
  const md = toMarkdown(doc({ tables: [table({
    columns: [
      { name: 'id', type: 'bigint', nullable: false, key: 'PRI' },
      { name: 'note', type: 'text', nullable: true, default: null },
    ],
  }) ] }));
  assert.match(md, /### orders/);
  assert.match(md, /\| `id` \| `bigint` \| no \| PRI \|/);
  assert.match(md, /\| `note` \| `text` \| yes \|/);
});

test('the comment column appears only when some column has one', () => {
  const bare = toMarkdown(doc({ tables: [table({
    columns: [{ name: 'id', type: 'int', nullable: false }] }) ] }));
  assert.ok(!bare.includes('Comment'));
  const withIt = toMarkdown(doc({ tables: [table({
    columns: [{ name: 'id', type: 'int', nullable: false, comment: 'the id' }] }) ] }));
  assert.match(withIt, /Comment/);
  assert.match(withIt, /the id/);
});

test('a pipe in a value cannot break the markdown table', () => {
  const md = toMarkdown(doc({ tables: [table({
    columns: [{ name: 'x', type: "enum('a|b')", nullable: false }] }) ] }));
  assert.match(md, /enum\('a\\\|b'\)/);
});

test('a newline in a comment cannot break the row', () => {
  const md = toMarkdown(doc({ tables: [table({
    columns: [{ name: 'x', type: 'int', nullable: false, comment: 'one\ntwo' }] }) ] }));
  const rows = md.split('\n').filter(l => l.startsWith('| `x`'));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /one two/);
});

test('indexes and references are listed', () => {
  const md = toMarkdown(doc({ tables: [table({
    indexes: [{ name: 'uq_email', unique: true, columns: ['email'] }],
    foreignKeys: [{ name: 'fk_c', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
  })] }));
  assert.match(md, /`uq_email`.*unique.*`email`/);
  assert.match(md, /`customer_id`.*→.*`customers`.*`id`/);
});

test('an index states its method and predicate when they are not the default', () => {
  // A GIN index and a btree on the same column answer different queries, and a
  // partial index that documents as total is a wrong conclusion waiting to
  // happen. Both are facts about the schema, not decoration.
  const md = toMarkdown(doc({ tables: [table({ indexes: [
    { name: 'i_meta', unique: false, columns: ['meta'], method: 'gin' },
    { name: 'i_open', unique: false, columns: ['placed_at'], where: "status <> 'x'" },
    { name: 'i_plain', unique: false, columns: ['id'] },
  ] })] }));
  assert.match(md, /`i_meta` \*\(gin\)\* — `meta`/);
  assert.match(md, /`i_open` — `placed_at` WHERE `status <> 'x'`/);
  // The default btree carries no marker — noise on every index would bury the
  // two that matter.
  assert.match(md, /`i_plain` — `id`\n/);
});

test('html carries the method and predicate too', () => {
  const html = toHtmlDoc(doc({ tables: [table({ indexes: [
    { name: 'i', unique: true, columns: ['a'], method: 'gist', where: 'a > 0' },
  ] })] }));
  assert.match(html, /\(unique\)/);
  assert.match(html, /\(gist\)/);
  assert.match(html, /WHERE <code>a &gt; 0<\/code>/);
});

test('an empty schema still produces a valid document', () => {
  const md = toMarkdown(doc({ schema: 'empty' }));
  assert.match(md, /^# empty/);
  assert.match(md, /0 tables/);
});

test('routines are grouped by kind then name', () => {
  const d = doc({ routines: [
    { schema: 's', name: 'z_proc', kind: 'PROCEDURE' },
    { schema: 's', name: 'a_func', kind: 'FUNCTION', returns: 'int' },
    { schema: 's', name: 'a_proc', kind: 'PROCEDURE' },
  ] });
  const md = toMarkdown(d);
  const order = ['a_func', 'a_proc', 'z_proc'].map(n => md.indexOf(n));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

// ── diagram ─────────────────────────────────────────────────────────────────

test('the diagram draws one edge per foreign key', () => {
  const m = toMermaid(doc({ tables: [table({
    name: 'orders',
    foreignKeys: [{ name: 'fk', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
  })] }));
  assert.match(m, /^erDiagram/);
  assert.match(m, /customers \|\|--o\{ orders/);
});

test('a schema-qualified reference uses just the table name', () => {
  // Mermaid identifiers cannot contain a dot.
  const m = toMermaid(doc({ tables: [table({
    foreignKeys: [{ name: 'fk', columns: ['c'], refTable: 'other.customers', refColumns: ['id'] }],
  })] }));
  assert.ok(!m.includes('other.customers'));
  assert.match(m, /customers/);
});

test('no foreign keys produces no diagram rather than an empty one', () => {
  assert.equal(toMermaid(doc({ tables: [table()] })), '');
  assert.ok(!toMarkdown(doc({ tables: [table()] }), { includeDiagram: true })
    .includes('```mermaid'));
});

test('the diagram is included only when asked for', () => {
  const d = doc({ tables: [table({
    foreignKeys: [{ name: 'fk', columns: ['c'], refTable: 'customers', refColumns: ['id'] }] })] });
  assert.ok(!toMarkdown(d).includes('mermaid'));
  assert.ok(toMarkdown(d, { includeDiagram: true }).includes('```mermaid'));
});

// ── html ────────────────────────────────────────────────────────────────────

test('html escapes angle brackets in types', () => {
  const html = toHtmlDoc(doc({ tables: [table({
    columns: [{ name: 'x', type: 'int<unsigned>', nullable: false }] })] }));
  assert.ok(!html.includes('<unsigned>'));
  assert.match(html, /int&lt;unsigned&gt;/);
});

test('html links every table from the sidebar', () => {
  const html = toHtmlDoc(doc({ tables: [table({ name: 'a' }), table({ name: 'b' })] }));
  assert.match(html, /href="#t-a"/);
  assert.match(html, /id="t-b"/);
});

test('html is a complete standalone document', () => {
  const html = toHtmlDoc(doc({ tables: [table()] }));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  assert.ok(!html.includes('http'), 'must not reference anything external');
});

// ── filenames ───────────────────────────────────────────────────────────────

test('the filename is safe for a schema with punctuation', () => {
  assert.equal(docFileName('my db/prod', 'md'), 'my_db_prod-schema.md');
  assert.equal(docFileName('', 'html'), 'schema-schema.html');
});
