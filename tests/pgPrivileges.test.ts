/**
 * PostgreSQL Grant Wizard (src/utils/privileges.ts, PG section).
 *
 * Three things have to hold. **Decoding** must read a real `aclitem[]` the way
 * Postgres writes it — single-letter privileges, a trailing `*` for grant
 * option, and the empty grantee that means PUBLIC. **The matrix** must reflect
 * the true effective state, including that a NULL relacl is the owner-holds-all
 * default rather than "no access". And **the diffs** must say nothing when
 * nothing changed, so a no-op never fires a stray REVOKE, while still splitting
 * a grant-option change into the separate statement Postgres requires.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAclArray, parseAclItem, parseAcl,
  buildAclMatrix, privMapForGrantee,
  pgObjectClause, pgGrantDiffSql, pgDefaultPrivDiffSql,
  type PgPrivMap,
} from '../src/utils/privileges.ts';

const pm = (...entries: [string, boolean][]): PgPrivMap =>
  new Map(entries as [import('../src/utils/privileges.ts').PgPrivilege, boolean][]);

// ── array splitting ─────────────────────────────────────────────────────────

test('an empty / null acl array is no elements', () => {
  assert.deepEqual(parseAclArray('{}'), []);
  assert.deepEqual(parseAclArray(null), []);
  assert.deepEqual(parseAclArray(''), []);
});

test('a plain acl array splits on commas', () => {
  assert.deepEqual(
    parseAclArray('{postgres=arwdDxt/postgres,alice=r/postgres,=r/postgres}'),
    ['postgres=arwdDxt/postgres', 'alice=r/postgres', '=r/postgres'],
  );
});

test('a quoted array element keeps its embedded comma', () => {
  // A role literally named `a,b` — Postgres quotes the whole element.
  assert.deepEqual(
    parseAclArray('{"\\"a,b\\"=r/postgres",alice=w/postgres}'),
    ['"a,b"=r/postgres', 'alice=w/postgres'],
  );
});

// ── decoding a single aclitem ────────────────────────────────────────────────

test('a table aclitem decodes every privilege letter', () => {
  const it = parseAclItem('alice=arwdDxt/postgres')!;
  assert.equal(it.grantee, 'alice');
  assert.equal(it.isPublic, false);
  assert.equal(it.grantor, 'postgres');
  assert.deepEqual(
    [...it.privileges.keys()].sort(),
    ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  );
  // No `*` anywhere, so nothing carries grant option.
  assert.ok([...it.privileges.values()].every(go => go === false));
});

test('an empty grantee decodes as PUBLIC', () => {
  const it = parseAclItem('=r/postgres')!;
  assert.equal(it.grantee, 'PUBLIC');
  assert.equal(it.isPublic, true);
  assert.deepEqual([...it.privileges.keys()], ['SELECT']);
});

test('a trailing * marks WITH GRANT OPTION on that privilege only', () => {
  const it = parseAclItem('bob=r*w/postgres')!;
  assert.equal(it.privileges.get('SELECT'), true);  // r* → SELECT with grant option
  assert.equal(it.privileges.get('UPDATE'), false); // w  → UPDATE without
});

test('case distinguishes the colliding letters', () => {
  // d/D and c/C and t/T are different privileges.
  const it = parseAclItem('carol=dDcCtT/postgres')!;
  assert.deepEqual(
    [...it.privileges.keys()].sort(),
    ['CONNECT', 'CREATE', 'DELETE', 'TEMPORARY', 'TRIGGER', 'TRUNCATE'],
  );
});

test('a quoted grantee name is unwrapped', () => {
  const it = parseAclItem('"weird=role"=r/postgres')!;
  assert.equal(it.grantee, 'weird=role');
});

test('a token with no = is not an aclitem', () => {
  assert.equal(parseAclItem('not-an-acl'), null);
});

test('parseAcl decodes a whole relacl string', () => {
  const items = parseAcl('{postgres=arwdDxt/postgres,=r/postgres}');
  assert.equal(items.length, 2);
  assert.equal(items[1].isPublic, true);
});

// ── effective matrix ─────────────────────────────────────────────────────────

test('a NULL relacl is the owner-holds-all default, not empty', () => {
  const rows = buildAclMatrix(null, 'table', 'app_owner');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grantee, 'app_owner');
  // Owner has every table privilege, each with grant option.
  for (const [, cell] of rows[0].privileges) {
    assert.equal(cell.granted, true);
    assert.equal(cell.grantOption, true);
  }
});

test('a decoded relacl yields one row per grantee, ungranted cells false', () => {
  const rows = buildAclMatrix('{alice=arw/postgres,=r/postgres}', 'table', 'postgres');
  const alice = rows.find(r => r.grantee === 'alice')!;
  assert.equal(alice.privileges.get('SELECT')!.granted, true);
  assert.equal(alice.privileges.get('INSERT')!.granted, true);
  assert.equal(alice.privileges.get('DELETE')!.granted, false);   // not in `arw`
  const pub = rows.find(r => r.isPublic)!;
  assert.equal(pub.privileges.get('SELECT')!.granted, true);
  assert.equal(pub.privileges.get('UPDATE')!.granted, false);
});

test('a schema nspacl decodes USAGE/CREATE', () => {
  const rows = buildAclMatrix('{alice=UC/postgres}', 'schema', 'postgres');
  const alice = rows[0];
  assert.equal(alice.privileges.get('USAGE')!.granted, true);
  assert.equal(alice.privileges.get('CREATE')!.granted, true);
});

test('privMapForGrantee pulls one role out of the matrix, PUBLIC too', () => {
  const rows = buildAclMatrix('{alice=r*w/postgres,=r/postgres}', 'table', 'postgres');
  const alice = privMapForGrantee(rows, 'alice', false);
  assert.equal(alice.get('SELECT'), true);   // r* → grant option
  assert.equal(alice.get('UPDATE'), false);
  assert.equal(alice.has('DELETE'), false);
  const pub = privMapForGrantee(rows, '', true);
  assert.deepEqual([...pub.keys()], ['SELECT']);
  // A grantee with no row is an empty map, never a throw.
  assert.equal(privMapForGrantee(rows, 'nobody', false).size, 0);
});

// ── object clause ─────────────────────────────────────────────────────────────

test('object clauses quote and qualify per kind', () => {
  assert.equal(pgObjectClause({ kind: 'table', schema: 'public', name: 'orders' }),
    'TABLE "public"."orders"');
  assert.equal(pgObjectClause({ kind: 'schema', name: 'reporting' }),
    'SCHEMA "reporting"');
  // A mixed-case identifier must survive quoting (PG folds bare names).
  assert.equal(pgObjectClause({ kind: 'table', schema: 'public', name: 'OrderItems' }),
    'TABLE "public"."OrderItems"');
});

// ── GRANT / REVOKE diff ────────────────────────────────────────────────────────

const ORDERS = { kind: 'table' as const, schema: 'public', name: 'orders' };

test('no change produces no SQL', () => {
  const cur = pm(['SELECT', false]);
  assert.equal(
    pgGrantDiffSql({ target: ORDERS, grantee: 'alice', desired: cur, current: cur }),
    '',
  );
});

test('added privileges become a GRANT, removed ones a REVOKE', () => {
  const sql = pgGrantDiffSql({
    target: ORDERS,
    grantee: 'alice',
    current: pm(['SELECT', false], ['DELETE', false]),
    desired: pm(['SELECT', false], ['INSERT', false], ['UPDATE', false]),
  });
  assert.equal(sql,
    'GRANT INSERT, UPDATE ON TABLE "public"."orders" TO "alice";\n'
    + 'REVOKE DELETE ON TABLE "public"."orders" FROM "alice";');
});

test('a privilege gaining grant option rides its own WITH GRANT OPTION statement', () => {
  const sql = pgGrantDiffSql({
    target: ORDERS,
    grantee: 'alice',
    current: pm(['SELECT', false]),
    desired: pm(['SELECT', true], ['INSERT', false]),
  });
  assert.equal(sql,
    'GRANT INSERT ON TABLE "public"."orders" TO "alice";\n'
    + 'GRANT SELECT ON TABLE "public"."orders" TO "alice" WITH GRANT OPTION;');
});

test('dropping only the grant option is REVOKE GRANT OPTION FOR, not a full revoke', () => {
  const sql = pgGrantDiffSql({
    target: ORDERS,
    grantee: 'alice',
    current: pm(['SELECT', true]),
    desired: pm(['SELECT', false]),
  });
  assert.equal(sql,
    'REVOKE GRANT OPTION FOR SELECT ON TABLE "public"."orders" FROM "alice";');
});

test('PUBLIC is emitted unquoted as the recipient', () => {
  const sql = pgGrantDiffSql({
    target: ORDERS,
    grantee: 'PUBLIC',
    isPublic: true,
    current: new Map(),
    desired: pm(['SELECT', false]),
  });
  assert.equal(sql, 'GRANT SELECT ON TABLE "public"."orders" TO PUBLIC;');
});

test('a schema grant diffs USAGE and CREATE', () => {
  const sql = pgGrantDiffSql({
    target: { kind: 'schema', name: 'reporting' },
    grantee: 'alice',
    current: pm(['USAGE', false]),
    desired: pm(['USAGE', false], ['CREATE', false]),
  });
  assert.equal(sql, 'GRANT CREATE ON SCHEMA "reporting" TO "alice";');
});

// ── ALTER DEFAULT PRIVILEGES ───────────────────────────────────────────────────

test('default privileges emit ALTER DEFAULT PRIVILEGES for future tables', () => {
  const sql = pgDefaultPrivDiffSql({
    forRole: 'app_owner',
    inSchema: 'public',
    objType: 'TABLES',
    grantee: 'readers',
    current: new Map(),
    desired: pm(['SELECT', false]),
  });
  assert.equal(sql,
    'ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "public" '
    + 'GRANT SELECT ON TABLES TO "readers";');
});

test('default privileges without FOR ROLE / IN SCHEMA drop those clauses', () => {
  const sql = pgDefaultPrivDiffSql({
    objType: 'SEQUENCES',
    grantee: 'PUBLIC',
    isPublic: true,
    current: pm(['USAGE', false]),
    desired: new Map(),
  });
  assert.equal(sql, 'ALTER DEFAULT PRIVILEGES REVOKE USAGE ON SEQUENCES FROM PUBLIC;');
});

test('default privileges no-op is empty', () => {
  const same = pm(['SELECT', false]);
  assert.equal(
    pgDefaultPrivDiffSql({ objType: 'TABLES', grantee: 'readers', current: same, desired: same }),
    '',
  );
});
