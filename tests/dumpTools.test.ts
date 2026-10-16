import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_SPECS, specsFor, defaultOptions, splitExtraArgs, splitTables, previewCommand,
  type BuildInput, type ToolSpec,
} from '../src/utils/dumpTools.ts';

function spec(id: string): ToolSpec {
  const s = TOOL_SPECS.find(t => t.id === id);
  assert.ok(s, `spec ${id} exists`);
  return s;
}

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    user: 'backup', database: 'shop', tables: [], target: '/tmp/out',
    options: {}, extraArgs: '', ...over,
  };
}

/** Defaults applied, so a build reflects what the panel actually sends. */
function build(id: string, over: Partial<BuildInput> = {}) {
  const s = spec(id);
  return s.build(input({ options: defaultOptions(s), ...over }));
}

// ── splitExtraArgs ─────────────────────────────────────────────────────────

test('splitExtraArgs: plain whitespace splitting', () => {
  assert.deepEqual(splitExtraArgs('--quick  --force'), ['--quick', '--force']);
  assert.deepEqual(splitExtraArgs(''), []);
  assert.deepEqual(splitExtraArgs('   '), []);
  assert.deepEqual(splitExtraArgs('\t-x\n'), ['-x']);
});

test('splitExtraArgs: quotes group anywhere in a token and are stripped', () => {
  assert.deepEqual(splitExtraArgs('--where="id > 10"'), ['--where=id > 10']);
  assert.deepEqual(splitExtraArgs("--regex '^db\\.(a|b)$'"), ['--regex', '^db\\.(a|b)$']);
  assert.deepEqual(splitExtraArgs('pre"mid dle"post'), ['premid dlepost']);
});

test('splitExtraArgs: unterminated quote runs to end of string', () => {
  assert.deepEqual(splitExtraArgs("--where 'id > 10"), ['--where', 'id > 10']);
  assert.deepEqual(splitExtraArgs('"abc'), ['abc']);
});

test('splitExtraArgs: empty quoted segment still counts as a token', () => {
  assert.deepEqual(splitExtraArgs("--comment=''"), ['--comment=']);
});

// ── splitTables ─────────────────────────────────────────────────────────────

test('splitTables: space/comma separated, trimmed, empties dropped', () => {
  assert.deepEqual(splitTables('orders, customers'), ['orders', 'customers']);
  assert.deepEqual(splitTables('orders  customers\nitems'), ['orders', 'customers', 'items']);
  assert.deepEqual(splitTables(' , ,'), []);
});

// ── specsFor / defaults ─────────────────────────────────────────────────────

test('specsFor: engine × mode partitioning, incl. the MariaDB-named tools', () => {
  assert.deepEqual(
    specsFor('mysql', 'dump').map(s => s.id),
    ['mysqldump', 'mariadb-dump', 'mydumper']);
  assert.deepEqual(
    specsFor('mysql', 'restore').map(s => s.id),
    ['mysql', 'mariadb', 'myloader']);
  assert.deepEqual(
    specsFor('postgres', 'dump').map(s => s.id), ['pg_dump']);
  assert.deepEqual(
    specsFor('postgres', 'restore').map(s => s.id), ['pg_restore', 'psql']);
  assert.deepEqual(specsFor('redis', 'dump'), []);
});

test('defaultOptions: every option keyed to its declared default', () => {
  for (const s of TOOL_SPECS) {
    const d = defaultOptions(s);
    assert.deepEqual(Object.keys(d).sort(), s.options.map(o => o.key).sort(), s.id);
    for (const o of s.options) assert.deepEqual(d[o.key], o.def, `${s.id}.${o.key}`);
  }
});

// ── argv shapes ─────────────────────────────────────────────────────────────

test('mysqldump: conn flags first, options, extras, then result-file + db + tables', () => {
  const { args, stdinFile } = build('mysqldump', {
    tables: ['orders', 'customers'], extraArgs: '--hex-blob',
  });
  assert.equal(stdinFile, undefined);
  assert.deepEqual(args.slice(0, 6), ['--host', '{{host}}', '--port', '{{port}}', '--user', 'backup']);
  // defaults on: single-transaction, routines+triggers+events, quick
  const order = ['--single-transaction', '--routines', '--triggers', '--events', '--quick'];
  let at = 6;
  for (const f of order) assert.equal(args[at++], f);
  assert.equal(args[at++], '--hex-blob');                 // extras follow options
  assert.deepEqual(args.slice(at), ['--result-file', '/tmp/out', 'shop', 'orders', 'customers']);
});

test('mysqldump: unchecked options leave no flags', () => {
  const { args } = build('mysqldump', {
    options: { singleTx: false, routines: false, noData: false, quick: false },
  });
  assert.deepEqual(args.slice(6), ['--result-file', '/tmp/out', 'shop']);
});

test('mariadb-dump: identical argv shape to mysqldump', () => {
  const a = build('mariadb-dump', { tables: ['t1'] }).args;
  const b = build('mysqldump', { tables: ['t1'] }).args;
  assert.deepEqual(a, b);
});

test('mydumper: outputdir/threads/verbose, optional database/rows/compress/regex', () => {
  const { args } = build('mydumper', {
    options: { threads: 8, rows: 1000, compress: true, trxOnly: true, regex: '^shop\\.' },
  });
  assert.deepEqual(args.slice(0, 6), ['--host', '{{host}}', '--port', '{{port}}', '--user', 'backup']);
  assert.deepEqual(args.slice(6, 12), ['--outputdir', '/tmp/out', '--threads', '8', '--verbose', '3']);
  assert.ok(args.includes('--database') && args.includes('shop'));
  assert.ok(args.includes('--rows') && args.includes('1000'));
  assert.ok(args.includes('--compress') && args.includes('--trx-consistency-only'));
  const ri = args.indexOf('--regex');
  assert.equal(args[ri + 1], '^shop\\.');
});

test('mydumper: rows 0 = chunking off, no --database when blank', () => {
  const { args } = build('mydumper', {
    database: '', options: { threads: 0, rows: 0, compress: false, trxOnly: false, regex: '' },
  });
  assert.ok(!args.includes('--rows'));
  assert.ok(!args.includes('--database'));
  assert.equal(args[args.indexOf('--threads') + 1], '4'); // 0 falls back to the default
});

test('mysql restore: stdinFile carries the dump, db is positional', () => {
  const { args, stdinFile } = build('mysql', { options: { force: true }, extraArgs: '--binary-mode' });
  assert.equal(stdinFile, '/tmp/out');
  assert.deepEqual(args, [
    '--host', '{{host}}', '--port', '{{port}}', '--user', 'backup',
    '--force', '--binary-mode', 'shop',
  ]);
});

test('mariadb restore: identical argv shape to mysql', () => {
  const a = build('mariadb');
  const b = build('mysql');
  assert.deepEqual(a.args, b.args);
  assert.equal(a.stdinFile, b.stdinFile);
});

test('myloader: directory restore with optional overwrite/new database', () => {
  const { args, stdinFile } = build('myloader', {
    options: { threads: 2, overwrite: true, newDb: 'shop2' },
  });
  assert.equal(stdinFile, undefined);
  assert.deepEqual(args.slice(6, 12), ['--directory', '/tmp/out', '--threads', '2', '--verbose', '3']);
  assert.ok(args.includes('--overwrite-tables'));
  assert.equal(args[args.indexOf('--database') + 1], 'shop2');
});

test('pg_dump: format, jobs only for directory format, tables repeat --table', () => {
  const { args } = build('pg_dump', { tables: ['public.orders', 'public.items'] });
  assert.deepEqual(args.slice(0, 7),
    ['--host', '{{host}}', '--port', '{{port}}', '--username', 'backup', '--no-password']);
  assert.deepEqual(args.slice(7, 9), ['--format', 'custom']);
  assert.ok(!args.includes('--jobs'), 'jobs only apply to directory format');
  const tables = args.reduce<string[]>((acc, a, i) => (a === '--table' ? [...acc, args[i + 1]] : acc), []);
  assert.deepEqual(tables, ['public.orders', 'public.items']);
  assert.deepEqual(args.slice(-3), ['--file', '/tmp/out', 'shop']);

  const dir = build('pg_dump', { options: { format: 'directory', jobs: 8, schemaOnly: true, noOwner: false } }).args;
  assert.equal(dir[dir.indexOf('--jobs') + 1], '8');
  assert.ok(dir.includes('--schema-only'));
  assert.ok(!dir.includes('--no-owner'));
});

test('pg_restore: dbname + jobs + archive positional last', () => {
  const { args } = build('pg_restore', { options: { jobs: 4, clean: true, noOwner: true } });
  assert.equal(args[args.indexOf('--dbname') + 1], 'shop');
  assert.ok(args.includes('--clean') && args.includes('--if-exists') && args.includes('--no-owner'));
  assert.equal(args[args.length - 1], '/tmp/out');
});

test('psql: ON_ERROR_STOP default on, --file last, no stdinFile', () => {
  const { args, stdinFile } = build('psql');
  assert.equal(stdinFile, undefined);
  const vi = args.indexOf('-v');
  assert.equal(args[vi + 1], 'ON_ERROR_STOP=1');
  assert.deepEqual(args.slice(-2), ['--file', '/tmp/out']);
});

// ── placeholders + preview ─────────────────────────────────────────────────

test('every built command keeps {{host}}/{{port}} placeholders for backend resolution', () => {
  for (const s of TOOL_SPECS) {
    const { args } = build(s.id);
    assert.ok(args.includes('{{host}}'), s.id);
    assert.ok(args.includes('{{port}}'), s.id);
    // The password travels via env only; argv must never carry a password flag
    // (--no-password is the opposite — it suppresses the prompt).
    assert.ok(!args.some(a => /^-p$|^--password/.test(a)), `${s.id}: no password flag in argv`);
  }
});

test('previewCommand: quotes args needing it, escapes single quotes, shows stdin redirect', () => {
  const s = previewCommand('mysql', {
    args: ['--host', 'db.internal', "--where=a'b", '--comment', 'two words'],
    stdinFile: '/tmp/my dump.sql',
  });
  assert.equal(s, `mysql --host db.internal '--where=a'\\''b' --comment 'two words' < '/tmp/my dump.sql'`);
});

test('previewCommand: plain args pass through unquoted', () => {
  assert.equal(previewCommand('mysqldump', { args: ['--quick', 'shop'] }), 'mysqldump --quick shop');
});
