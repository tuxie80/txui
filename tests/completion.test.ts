/**
 * The completion source, driven exactly as CodeMirror drives it.
 *
 * These tests type real character sequences and assert what appears — the only
 * way to catch "I typed `insert into shop.` and nothing happened", which no
 * amount of reading the switch statement reveals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterStatementEnd, buildCompletionSource } from '../src/utils/sqlComplete.ts';
import type { CompletionProviders } from '../src/utils/sqlComplete.ts';
import type { SchemaCompletion } from '../src/components/SqlEditor.ts';

// ── a minimal stand-in for CodeMirror's CompletionContext ────────────────────

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

  /** Same contract as CodeMirror: match must end at the cursor, line-local. */
  matchBefore(re: RegExp): { from: number; to: number; text: string } | null {
    const lineStart = this.doc.lastIndexOf('\n', this.pos - 1) + 1;
    const text = this.doc.slice(lineStart, this.pos);
    const anchored = new RegExp(`(?:${re.source})$`, re.flags.replace('g', ''));
    const m = anchored.exec(text);
    if (!m) return null;
    return { from: lineStart + m.index, to: this.pos, text: m[0] };
  }
}

// ── a small but realistic schema ─────────────────────────────────────────────

const OBJECTS: SchemaCompletion[] = [
  { label: 'orders', type: 'table', kind: 'table', apply: 'shop.orders', detail: 'shop' },
  { label: 'order_items', type: 'table', kind: 'table', apply: 'shop.order_items', detail: 'shop' },
  { label: 'customers', type: 'table', kind: 'table', apply: 'shop.customers', detail: 'shop' },
  { label: 'v_daily', type: 'view', kind: 'view', apply: 'shop.v_daily', detail: 'shop' },
  { label: 'recalc_totals', type: 'keyword', kind: 'procedure', apply: 'shop.recalc_totals', detail: 'procedure' },
  { label: 'fn_tax', type: 'keyword', kind: 'function', apply: 'shop.fn_tax', detail: 'function' },
  { label: 'shop', type: 'database', kind: 'schema' },
  { label: 'analytics', type: 'database', kind: 'schema' },
];

const COLUMNS: Record<string, SchemaCompletion[]> = {
  'shop.orders': [
    { label: 'id', type: 'column', detail: 'int', pk: true },
    { label: 'customer_id', type: 'column', detail: 'int' },
    { label: 'state', type: 'column', detail: "enum('new','paid')" },
    { label: 'total', type: 'column', detail: 'decimal(10,2)' },
  ],
  'shop.customers': [
    { label: 'id', type: 'column', detail: 'int', pk: true },
    { label: 'email', type: 'column', detail: 'varchar(255)' },
  ],
};

const providers: CompletionProviders = {
  getColumns: async t => COLUMNS[t.replace(/[`"]/g, '').toLowerCase()] ?? [],
  getFks: async () => [],
  getSchemaTables: async s => (s.toLowerCase() === 'shop'
    ? OBJECTS.filter(o => o.kind === 'table' || o.kind === 'view')
    : []),
  getServerVariables: async () => [{ name: 'max_connections', value: '151' }],
  getHistory: async () => ['SELECT * FROM shop.orders WHERE state = 1'],
};

const source = buildCompletionSource('mysql', OBJECTS, providers);

/** Labels offered for a document whose caret sits at the end. */
async function offer(doc: string, explicit = false): Promise<string[]> {
  const res = await source(new FakeContext(doc, doc.length, explicit) as never);
  return (res?.options ?? []).map(o => String(o.label));
}
const has = (labels: string[], needle: string) =>
  labels.some(l => l.toLowerCase() === needle.toLowerCase());

// ── the INSERT flow, exactly as a DBA types it ───────────────────────────────

test('`INSERT INTO ` with nothing typed already offers tables AND schemas', async () => {
  const labels = await offer('INSERT INTO ');
  assert.ok(labels.length > 0, 'a popup must appear before you type a letter');
  assert.ok(has(labels, 'orders'), 'tables');
  assert.ok(has(labels, 'shop'), 'schemas — you may not know which one you want yet');
});

test('`INSERT INTO shop.` offers that schema’s tables', async () => {
  const labels = await offer('INSERT INTO shop.');
  assert.ok(has(labels, 'orders'), `expected shop's tables, got: ${labels.slice(0, 8).join(', ')}`);
  assert.ok(has(labels, 'v_daily'), 'views too');
});

test('`INSERT INTO shop.orders (` offers the columns', async () => {
  const labels = await offer('INSERT INTO shop.orders (');
  assert.ok(has(labels, 'id'));
  assert.ok(has(labels, 'customer_id'));
});

test('`INSERT INTO shop.orders (id, ` hides the column already listed', async () => {
  const labels = await offer('INSERT INTO shop.orders (id, ');
  assert.ok(!has(labels, 'id'), 'already in the list');
  assert.ok(has(labels, 'state'));
});

test('`INSERT INTO shop.orders ` offers the whole column-list + VALUES skeleton', async () => {
  const labels = await offer('INSERT INTO shop.orders ');
  assert.ok(labels.some(l => l.startsWith('(id, customer_id, state, total) VALUES')),
    `expected an INSERT skeleton, got: ${labels.slice(0, 5).join(' | ')}`);
});

test('`INSERT INTO shop.orders VALUES (` says what belongs in each position', async () => {
  const labels = await offer('INSERT INTO shop.orders VALUES (');
  assert.ok(labels.length > 0, 'a VALUES list must not be a dead end');
  assert.ok(has(labels, 'NULL') || has(labels, 'DEFAULT'),
    `expected value literals, got: ${labels.slice(0, 8).join(', ')}`);
});

test('`INSERT INTO shop.orders (state) VALUES (` offers that column’s enum values', async () => {
  const labels = await offer("INSERT INTO shop.orders (state) VALUES (");
  assert.ok(labels.some(l => l.includes("'paid'")),
    `expected the enum literals of shop.orders.state, got: ${labels.slice(0, 8).join(', ')}`);
});

// ── UPDATE / DELETE, the same way ────────────────────────────────────────────

test('`UPDATE ` offers tables and schemas with nothing typed', async () => {
  const labels = await offer('UPDATE ');
  assert.ok(has(labels, 'orders'));
  assert.ok(has(labels, 'shop'));
});

test('`UPDATE shop.orders SET ` offers that table’s columns', async () => {
  const labels = await offer('UPDATE shop.orders SET ');
  assert.ok(has(labels, 'state'), `got: ${labels.slice(0, 8).join(', ')}`);
  assert.ok(has(labels, 'total'));
});

test('`UPDATE shop.orders SET state = ` offers values for that column', async () => {
  const labels = await offer('UPDATE shop.orders SET state = ');
  assert.ok(labels.some(l => l.includes("'paid'")) || has(labels, 'NULL'),
    `got: ${labels.slice(0, 8).join(', ')}`);
});

test('`UPDATE shop.orders SET total = 1 WHERE ` offers columns', async () => {
  const labels = await offer('UPDATE shop.orders SET total = 1 WHERE ');
  assert.ok(has(labels, 'id'));
});

test('`DELETE FROM ` offers tables and schemas; then columns after WHERE', async () => {
  assert.ok(has(await offer('DELETE FROM '), 'orders'));
  assert.ok(has(await offer('DELETE FROM '), 'shop'));
  assert.ok(has(await offer('DELETE FROM shop.orders WHERE '), 'state'));
});

test('MySQL’s `INSERT … SET` and `ON DUPLICATE KEY UPDATE` offer columns', async () => {
  assert.ok(has(await offer('INSERT INTO shop.orders SET '), 'state'));
  assert.ok(has(await offer('INSERT INTO shop.orders (id) VALUES (1) ON DUPLICATE KEY UPDATE '), 'state'));
});

// ── zero-character completion everywhere it is structural ────────────────────

test('`CALL ` offers routines', async () => {
  const labels = await offer('CALL ');
  assert.ok(has(labels, 'recalc_totals'), `got: ${labels.slice(0, 6).join(', ')}`);
  assert.ok(has(labels, 'fn_tax'));
});

test('every structural position hints with nothing typed', async () => {
  for (const doc of [
    'SELECT * FROM ',
    'SELECT * FROM shop.orders o JOIN ',
    'SELECT * FROM shop.orders o WHERE ',
    'SELECT ',
    'USE ',
    'CALL ',
    'INSERT INTO ',
    'UPDATE ',
    'DELETE FROM ',
    'TRUNCATE TABLE ',
  ]) {
    const labels = await offer(doc);
    assert.ok(labels.length > 0, `no hint after "${doc}"`);
  }
});

test('a dot always resolves, whatever comes before it', async () => {
  for (const doc of [
    'SELECT * FROM shop.',
    'INSERT INTO shop.',
    'UPDATE shop.',
    'DELETE FROM shop.',
    'SELECT * FROM shop.orders o WHERE o.',
  ]) {
    const labels = await offer(doc);
    assert.ok(labels.length > 0, `nothing after "${doc}"`);
  }
});

// ── the INSERT model that drives both completion and the inline hint ─────────

test('insertContext knows the target, the column list and the position', async () => {
  const { insertContext } = await import('../src/utils/sqlContext.ts');
  assert.deepEqual(insertContext('INSERT INTO shop.orders '),
    { table: 'shop.orders', columns: null, index: 0, where: 'after-target' });
  assert.equal(insertContext('INSERT INTO shop.ord')?.where, 'target');
  assert.equal(insertContext('INSERT INTO shop.orders (id, sta')?.where, 'cols');

  const v = insertContext('INSERT INTO shop.orders (id, state) VALUES (1, ')!;
  assert.equal(v.where, 'values');
  assert.deepEqual(v.columns, ['id', 'state']);
  assert.equal(v.index, 1, 'the caret is in the second value');

  // commas inside a nested call must not shift the position
  const n = insertContext("INSERT INTO shop.orders VALUES (1, CONCAT('a', 'b'), ")!;
  assert.equal(n.index, 2);

  // a second tuple starts counting again
  const t2 = insertContext('INSERT INTO shop.orders VALUES (1, 2, 3, 4), (1, ')!;
  assert.equal(t2.index, 1);

  assert.equal(insertContext('INSERT INTO shop.orders SET state = ')?.where, 'set');
  assert.equal(insertContext('SELECT * FROM orders'), null);
  assert.equal(insertContext("SELECT 'INSERT INTO x VALUES ('"), null, 'literals are blanked');
});

test('REPLACE INTO behaves like INSERT INTO', async () => {
  const { insertContext } = await import('../src/utils/sqlContext.ts');
  assert.equal(insertContext('REPLACE INTO shop.orders VALUES (')?.where, 'values');
  assert.ok(has(await offer('REPLACE INTO '), 'orders'));
});

// ── statement shortcuts: "pro" → SHOW FULL PROCESSLIST ───────────────────────

async function offerOptions(doc: string, src = source) {
  const res = await src(new FakeContext(doc, doc.length, false) as never);
  return (res?.options ?? []) as { label: unknown; apply?: unknown; detail?: unknown }[];
}

test('typing `pro` mid-word (generic ctx) offers `processlist`', async () => {
  const labels = await offer('pro');
  assert.ok(has(labels, 'processlist'), `got: ${labels.slice(0, 10).join(', ')}`);
});

test('typing `inno` offers the InnoDB status shortcut', async () => {
  assert.ok(has(await offer('inno'), 'innodb'));
});

test('accepting a shortcut applies the whole statement (no semicolon)', async () => {
  const opts = await offerOptions('pro');
  const pl = opts.find(o => String(o.label) === 'processlist');
  assert.ok(pl, 'processlist must be offered');
  assert.equal(pl.apply, 'SHOW FULL PROCESSLIST');
  const innodb = (await offerOptions('innodb')).find(o => String(o.label) === 'innodb');
  assert.equal(innodb?.apply, 'SHOW ENGINE INNODB STATUS');
});

test('statement start also offers the shortcuts (next to sel/ins/…)', async () => {
  const labels = await offer('');
  assert.ok(has(labels, 'sel'), 'templates still there');
  assert.ok(has(labels, 'processlist'), `got: ${labels.slice(0, 10).join(', ')}`);
  assert.ok(has(labels, 'tablestatus'));
});

test('shortcuts are filtered by engine', async () => {
  const pg = buildCompletionSource('postgres', OBJECTS, providers);
  const offerPg = async (doc: string) => {
    const res = await pg(new FakeContext(doc, doc.length, false) as never);
    return (res?.options ?? []).map(o => String(o.label));
  };
  // PG shortcuts present on postgres…
  assert.ok(has(await offerPg('act'), 'activity'));
  assert.ok(has(await offerPg('vac'), 'vacuum'));
  // …and MySQL ones must not leak into postgres, nor PG ones into mysql
  assert.ok(!has(await offerPg('pro'), 'processlist'));
  assert.ok(!has(await offerPg('inno'), 'innodb'));
  assert.ok(!has(await offer('act'), 'activity'));
  assert.ok(!has(await offer('vac'), 'vacuum'));
  // Redis: no shortcuts at all
  const redis = buildCompletionSource('redis', OBJECTS, providers);
  const resRedis = await redis(new FakeContext('pro', 3, false) as never);
  assert.ok(!(resRedis?.options ?? []).some(o => String(o.label) === 'processlist'));
});

test('shortcuts do not interfere with column/table completion', async () => {
  assert.ok(has(await offer('SELECT * FROM shop.orders WHERE sta'), 'state'));
  assert.ok(has(await offer('SELECT * FROM shop.orders WHERE total > '), 'NULL'));
  assert.ok(has(await offer('SELECT * FROM ord'), 'orders'), 'tables still hint on the same prefix');
});

// ── stored SQL templates: `?name` snippet expansion ─────────────────────────

const TEMPLATE_BODY = "SELECT * FROM information_schema.PROCESSLIST WHERE USER = '${1}' ORDER BY TIME DESC;";

const templateProviders: CompletionProviders = {
  ...providers,
  getTemplates: async () => [
    { name: 'processlist', engine: 'mysql', description: 'Sessions by user', body: TEMPLATE_BODY },
    { name: 'activity', engine: 'postgres', description: 'Active queries', body: 'SELECT * FROM pg_stat_activity;' },
    { name: 'whatever', engine: null, description: 'Any engine', body: 'SELECT ${1:1};' },
  ],
};
const tsource = buildCompletionSource('mysql', OBJECTS, templateProviders);

test('typing `?pro` offers `?processlist`', async () => {
  const labels = await (async () => {
    const res = await tsource(new FakeContext('?pro', 4, false) as never);
    return (res?.options ?? []).map(o => String(o.label));
  })();
  assert.ok(has(labels, '?processlist'), `got: ${labels.join(', ')}`);
});

test('a bare `?` lists every template valid for the engine', async () => {
  const res = await tsource(new FakeContext('?', 1, false) as never);
  const labels = (res?.options ?? []).map(o => String(o.label));
  assert.ok(has(labels, '?processlist'));
  assert.ok(has(labels, '?whatever'), 'engine-less templates match any engine');
  assert.ok(!has(labels, '?activity'), 'postgres template must not leak into a mysql session');
});

test('accepting a template applies it as a snippet (tabstops live)', async () => {
  const res = await tsource(new FakeContext('?pro', 4, false) as never);
  const opt = (res?.options ?? []).find(o => String(o.label) === '?processlist') as
    { apply?: unknown; info?: unknown; detail?: unknown } | undefined;
  assert.ok(opt, '?processlist must be offered');
  // snippetCompletion: apply is a function that drives the snippet field —
  // the raw body (with ${1} tabstop) rides along as the info preview.
  assert.equal(typeof opt.apply, 'function', 'apply must be a snippet, not a plain string');
  assert.equal(opt.info, TEMPLATE_BODY);
  assert.equal(opt.detail, 'Sessions by user');
});

test('`?` completion starts at the question mark, so the whole token is replaced', async () => {
  const res = await tsource(new FakeContext('?pro', 4, false) as never);
  assert.equal(res?.from, 0, '`from` must cover the `?` itself');
});

// ── ClickHouse object classification ─────────────────────────────────────────

test('clickhouse: the whole View family counts as a view, everything else as a table', async () => {
  const { clickhouseObjectKind } = await import('../src/utils/clickhouseMeta.ts');
  // Four distinct engines end in "View" — matching only "View" or only
  // "MaterializedView" would mislabel the rest.
  for (const e of ['View', 'MaterializedView', 'LiveView', 'WindowView']) {
    assert.equal(clickhouseObjectKind(e), 'view', e);
  }
  // A Dictionary is queried exactly like a table, so it must hint like one.
  for (const e of ['MergeTree', 'ReplacingMergeTree', 'ReplicatedMergeTree',
                   'Distributed', 'Dictionary', 'Memory', 'Null', 'Kafka']) {
    assert.equal(clickhouseObjectKind(e), 'table', e);
  }
});

// ── `j` → a whole JOIN clause (dbForge-style) ────────────────────────────────

/** Same schema, but with a declared foreign key orders.customer_id → customers.id. */
const fkProviders: CompletionProviders = {
  ...providers,
  getFks: async t => (t.replace(/[`"]/g, '').toLowerCase() === 'shop.orders'
    ? [{
        fromTable: 'shop.orders', fromCols: ['customer_id'],
        toTable: 'shop.customers', toCols: ['id'],
      }]
    : []),
};
const fkSource = buildCompletionSource('mysql', OBJECTS, fkProviders);

async function offerFrom(src: typeof source, doc: string): Promise<string[]> {
  const res = await src(new FakeContext(doc) as never);
  return res ? res.options.map(o => o.label) : [];
}

test('typing `j` after a FROM offers the whole JOIN clause, both sides resolved', async () => {
  const labels = await offerFrom(fkSource, 'SELECT * FROM shop.orders o j');
  const join = labels.find(l => l.startsWith('JOIN '));
  assert.ok(join, `no JOIN clause offered — got ${JSON.stringify(labels.slice(0, 6))}`);
  // The point of the feature: the ON clause is already written.
  assert.match(join, /^JOIN \S*customers\S* \w+ ON \w+\.id = o\.customer_id$/);
});

test('a LEFT JOIN variant is offered alongside the inner join', async () => {
  const labels = await offerFrom(fkSource, 'SELECT * FROM shop.orders o j');
  assert.ok(labels.some(l => l.startsWith('LEFT JOIN ')), 'no LEFT JOIN variant');
});

test('the join hint does not fire with no table in scope', async () => {
  // "SELECT j" has nothing to join to; offering a join clause would be noise.
  const labels = await offerFrom(fkSource, 'SELECT j');
  assert.equal(labels.filter(l => l.startsWith('JOIN ')).length, 0);
});

test('an unrelated prefix does not pull in join clauses', async () => {
  const labels = await offerFrom(fkSource, 'SELECT * FROM shop.orders o WHERE sta');
  assert.equal(labels.filter(l => l.startsWith('JOIN ')).length, 0,
    'join clauses leaked into a WHERE-column completion');
});

test('an already-joined table is not offered again', async () => {
  const doc = 'SELECT * FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id j';
  const labels = await offerFrom(fkSource, doc);
  assert.equal(labels.filter(l => /^JOIN \S*customers/.test(l)).length, 0,
    'customers was offered a second time');
});

test('with no declared FKs the hint falls back to name inference, labelled as a guess', async () => {
  const res = await source(new FakeContext('SELECT * FROM shop.orders o j') as never);
  const joins = (res?.options ?? []).filter(o => o.label.startsWith('JOIN '));
  assert.ok(joins.length > 0, 'no inferred join offered for an FK-less schema');
  assert.ok(joins.some(o => /customers/.test(o.label)), 'customers not inferred');
  // A guess must never be presented as a declared relationship.
  for (const o of joins) {
    assert.match(String(o.detail), /inferred|verify/i, `guess not labelled: ${o.detail}`);
  }
});

test('a declared foreign key outranks an inferred one', async () => {
  const res = await fkSource(new FakeContext('SELECT * FROM shop.orders o j') as never);
  const join = (res?.options ?? []).find(o => o.label.startsWith('JOIN '));
  assert.equal(join?.detail, 'foreign key');
});

// ── GROUP BY / ORDER BY / HAVING: the select list's own aliases ─────────────
// `SELECT price * qty AS gross … ORDER BY t…` — `gross` completes. The names
// come from the document itself (same parser as CTE column discovery), so they
// work even where the catalog has nothing to say about the tables.

test('ORDER BY offers select-list aliases alongside ordinary columns', async () => {
  const labels = await offer('SELECT price * qty AS gross FROM shop.orders ORDER BY ');
  assert.ok(has(labels, 'gross'), `alias missing — got: ${labels.slice(0, 10).join(', ')}`);
  assert.ok(has(labels, 'id'), 'ordinary columns must still complete');
});

test('the alias completes from its first letters, not just with nothing typed', async () => {
  const labels = await offer('SELECT price * qty AS gross FROM shop.orders ORDER BY t');
  assert.ok(has(labels, 'gross'), `got: ${labels.slice(0, 10).join(', ')}`);
});

test('GROUP BY — including after a comma — and HAVING offer the aliases', async () => {
  const grouped = 'SELECT state, COUNT(*) AS n FROM shop.orders GROUP BY ';
  assert.ok(has(await offer(grouped), 'n'), 'after GROUP BY');
  assert.ok(has(await offer(grouped + 'state, '), 'n'), 'after a comma in GROUP BY');
  assert.ok(has(await offer(grouped + 'state HAVING '), 'n'), 'after HAVING');
  assert.ok(has(await offer(grouped + 'state HAVING '), 'state'));
});

test('aliases complete even when the catalog knows nothing about the table', async () => {
  const labels = await offer('SELECT price * qty AS gross FROM nowhere ORDER BY ');
  assert.ok(has(labels, 'gross'), `got: ${labels.slice(0, 10).join(', ')}`);
});

test('select-list names are not offered in a plain WHERE', async () => {
  const labels = await offer('SELECT price * qty AS gross FROM shop.orders WHERE ');
  assert.ok(!has(labels, 'gross'), 'a select-list alias is not valid in WHERE');
});

// ── resolution-schema scoping in table contexts ─────────────────────────────
// The hook tags every object with its position in the unqualified-name
// resolution order (scopeRank: the default database on MySQL/ClickHouse, each
// search_path schema in order on PostgreSQL — utils/searchPath.ts). Table
// contexts then hint only tagged objects; everything else spells its schema.
// These fixtures mirror exactly what useSchemaCompletions emits.

const SCOPED_OBJECTS: SchemaCompletion[] = [
  { label: 'orders', type: 'table', kind: 'table', detail: 'public', scopeRank: 0 },
  { label: 'customers', type: 'table', kind: 'table', detail: 'public', scopeRank: 0 },
  { label: 'daily_totals', type: 'table', kind: 'table', detail: 'analytics', scopeRank: 1 },
  // off the path: inserted qualified when accepted from a non-table context
  { label: 'audit_log', type: 'table', kind: 'table', detail: 'audit', apply: 'audit.audit_log' },
  { label: 'public', type: 'database', kind: 'schema' },
  { label: 'analytics', type: 'database', kind: 'schema' },
  { label: 'audit', type: 'database', kind: 'schema' },
  { label: 'information_schema', type: 'database', kind: 'schema' },
];

const scopedProviders: CompletionProviders = {
  getColumns: async t => (t.replace(/[`"]/g, '').toLowerCase() === 'public.orders'
    ? COLUMNS['shop.orders']
    : []),
  getFks: async () => [],
  getSchemaTables: async s => {
    if (s.toLowerCase() === 'information_schema') {
      return [
        { label: 'tables', type: 'table', kind: 'table' },
        { label: 'columns', type: 'table', kind: 'table' },
      ];
    }
    if (s.toLowerCase() === 'audit') {
      return [{ label: 'audit_log', type: 'table', kind: 'table' }];
    }
    return [];
  },
};

const pgScoped = buildCompletionSource('postgres', SCOPED_OBJECTS, scopedProviders);
const myScoped = buildCompletionSource('mysql', SCOPED_OBJECTS, scopedProviders);
/** Same catalog without the tags — resolution unknown (not loaded / no default DB). */
const unscoped = buildCompletionSource('postgres',
  SCOPED_OBJECTS.map(({ scopeRank: _drop, ...rest }) => rest), scopedProviders);

const boostOf = async (src: typeof source, doc: string, label: string) =>
  (await src(new FakeContext(doc) as never))?.options.find(o => o.label === label)?.boost;

test('FROM hints only the resolution schemas’ tables (PostgreSQL search_path)', async () => {
  const labels = await offerFrom(pgScoped, 'SELECT * FROM ');
  assert.ok(has(labels, 'orders') && has(labels, 'customers'), 'public tables');
  assert.ok(has(labels, 'daily_totals'), 'the second search_path schema is in scope too');
  assert.ok(!has(labels, 'audit_log'), 'off-path tables drop out of FROM');
  // …but cross-schema work is never blocked: the schema names remain,
  // so `audit.` / `information_schema.` still dot in.
  assert.ok(has(labels, 'audit') && has(labels, 'information_schema'), 'schemas stay offered');
});

test('the same scoping applies with a chosen default database (MySQL/ClickHouse)', async () => {
  const labels = await offerFrom(myScoped, 'SELECT * FROM ');
  assert.ok(has(labels, 'orders') && has(labels, 'daily_totals'));
  assert.ok(!has(labels, 'audit_log'));
});

test('JOIN and UPDATE contexts are scoped the same way', async () => {
  const join = await offerFrom(pgScoped, 'SELECT * FROM public.orders o JOIN ');
  assert.ok(has(join, 'daily_totals') && !has(join, 'audit_log'), `JOIN got: ${join.slice(0, 8).join(', ')}`);
  const upd = await offerFrom(pgScoped, 'UPDATE ');
  assert.ok(has(upd, 'orders') && !has(upd, 'audit_log'), 'UPDATE targets scope identically');
});

test('in-scope tables rank in resolution order, and usage boost composes on top', async () => {
  const orders = await boostOf(pgScoped, 'SELECT * FROM ', 'orders');
  const totals = await boostOf(pgScoped, 'SELECT * FROM ', 'daily_totals');
  assert.ok(orders !== undefined && totals !== undefined && orders > totals,
    `path order must outrank: orders=${orders} daily_totals=${totals}`);
  const boosted = buildCompletionSource('postgres', SCOPED_OBJECTS, scopedProviders,
    { usageBoost: l => (l === 'daily_totals' ? 10 : 0) });
  const bOrders = await boostOf(boosted, 'SELECT * FROM ', 'orders');
  const bTotals = await boostOf(boosted, 'SELECT * FROM ', 'daily_totals');
  assert.ok(bTotals !== undefined && bOrders !== undefined && bTotals > bOrders,
    'a table you run all the time outranks an earlier path entry you never touch');
});

test('no resolution tags (metadata still loading, or no default chosen) → everything shows', async () => {
  const labels = await offerFrom(unscoped, 'SELECT * FROM ');
  assert.ok(has(labels, 'audit_log'), 'unknown means allowed — never hide objects');
  assert.ok(has(labels, 'orders'));
});

test('CTEs and derived tables of the document survive the scoping', async () => {
  const labels = await offerFrom(pgScoped, 'WITH recent AS (SELECT 1 AS a) SELECT * FROM ');
  assert.ok(has(labels, 'recent'), 'the document’s own CTE is always in scope');
  assert.ok(!has(labels, 'audit_log'));
});

test('`information_schema.` hints exactly that schema’s tables (lazy provider)', async () => {
  const labels = await offerFrom(pgScoped, 'SELECT * FROM information_schema.');
  assert.ok(has(labels, 'tables') && has(labels, 'columns'), `got: ${labels.join(', ')}`);
  assert.ok(!has(labels, 'orders') && !has(labels, 'audit_log'), 'other schemas must not leak in');
});

test('an off-path schema still completes its tables when spelled out', async () => {
  const labels = await offerFrom(pgScoped, 'SELECT * FROM audit.');
  assert.ok(has(labels, 'audit_log'));
});

test('scoping changes nothing for column, postfix and statement-start completion', async () => {
  // alias. → columns, as before
  assert.ok(has(await offerFrom(pgScoped, 'SELECT * FROM public.orders o WHERE o.'), 'id'));
  // postfix templates still ride alongside dot-completion
  assert.ok(has(await offerFrom(pgScoped, 'orders.'), 'sel'));
  // statement start is not a table context — off-path objects remain listed
  assert.ok(has(await offerFrom(pgScoped, ''), 'audit_log'));
});

// ── after a statement terminator, stay silent ────────────────────────────────
// Typing `;` finishes the statement. If a popup opened there, Enter would
// accept its first hint instead of inserting a newline — so the source returns
// nothing until a NEW statement is started on the next line.

test('caret right after `;` gets no completions', async () => {
  assert.deepEqual(await offer('SELECT * FROM shop.orders;'), []);
});

test('trailing whitespace after the `;` still suppresses', async () => {
  assert.deepEqual(await offer('SELECT * FROM shop.orders;  '), []);
});

test('a new statement on the NEXT line completes normally', async () => {
  const labels = await offer('SELECT * FROM shop.orders;\nSEL');
  assert.ok(has(labels, 'SELECT'), `expected keywords, got: ${labels.slice(0, 8).join(', ')}`);
});

test('an empty line after the `;` completes normally (new statement position)', async () => {
  const res = await source(new FakeContext('SELECT * FROM shop.orders;\n') as never);
  assert.notEqual(res, null, 'the `;` is on the previous line — the guard must not fire');
});

test('a `;` mid-line does not suppress what follows it', async () => {
  const labels = await offer('SELECT * FROM shop.orders; SEL');
  assert.ok(has(labels, 'SELECT'), 'a second statement on the same line is a fresh start');
});

// ── custom statement delimiter (Settings → sqlDelimiter) ────────────────────

const goSource = buildCompletionSource('mysql', OBJECTS, providers, { delimiter: 'GO' });

async function offerGo(doc: string): Promise<string[] | null> {
  const res = await goSource(new FakeContext(doc) as never);
  return res ? res.options.map(o => String(o.label)) : null;
}

test('custom delimiter: caret after `GO` gets no completions', async () => {
  assert.equal(await offerGo('SELECT 1\nGO'), null);
});

test('custom delimiter: next line completes normally', async () => {
  const labels = await offerGo('SELECT 1\nGO\nSEL');
  assert.ok(labels && has(labels, 'SELECT'));
});

test('custom delimiter: a word ending in GO (`GOODS`) is NOT a terminator', async () => {
  // Same boundary rule the splitter uses — a wordish delimiter must stand alone.
  const res = await goSource(new FakeContext('INSERT INTO GOODS ') as never);
  assert.notEqual(res, null, 'GOODS is an identifier, not the GO delimiter');
});

// ── the pure guard itself ────────────────────────────────────────────────────

test('afterStatementEnd: unit cases', () => {
  assert.equal(afterStatementEnd('SELECT 1;'), true);
  assert.equal(afterStatementEnd('SELECT 1;   '), true);
  assert.equal(afterStatementEnd('SELECT 1'), false);
  assert.equal(afterStatementEnd(''), false);
  assert.equal(afterStatementEnd('   '), false);
  assert.equal(afterStatementEnd('SELECT 1; SELECT'), false);
  // custom delimiters
  assert.equal(afterStatementEnd('SELECT 1 GO', 'GO'), true);
  assert.equal(afterStatementEnd('GO', 'GO'), true);
  assert.equal(afterStatementEnd('GOODS', 'GO'), false);
  assert.equal(afterStatementEnd('SELECT 1;', 'GO'), false,
    'with GO configured, a semicolon is just punctuation');
  // an empty/blank delimiter falls back to `;`, like the splitter
  assert.equal(afterStatementEnd('SELECT 1;', ''), true);
});
