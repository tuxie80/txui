/**
 * Grant matrix (src/utils/grantMatrix.ts) — the checkbox grid in 👤 Users.
 *
 * Two things must hold. **Parsing** has to read `SHOW GRANTS` the way MySQL
 * actually writes it (back-ticked scopes, `ALL PRIVILEGES`, a trailing `WITH
 * GRANT OPTION`), and **the diff** has to say nothing when nothing changed —
 * a no-op that emits a stray REVOKE would quietly strip a privilege the DBA
 * never meant to touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVILEGES, DATA_PRIVILEGES, parseGrants, scopeKey, privsForScope, grantDiffSql,
  type Scope,
} from '../src/utils/grantMatrix.ts';

const GLOBAL: Scope = { kind: 'global' };
const SHOP: Scope = { kind: 'database', db: 'shop' };
const ORDERS: Scope = { kind: 'table', db: 'shop', table: 'orders' };

// ── scope keys ────────────────────────────────────────────────────────────────

test('scope keys are the canonical, back-ticked object', () => {
  assert.equal(scopeKey(GLOBAL), '*.*');
  assert.equal(scopeKey(SHOP), '`shop`.*');
  assert.equal(scopeKey(ORDERS), '`shop`.`orders`');
});

// ── parsing ───────────────────────────────────────────────────────────────────

test('a global grant list is read at *.*', () => {
  const p = parseGrants(['GRANT SELECT, INSERT, UPDATE ON *.* TO `u`@`%`']);
  const g = privsForScope(p, GLOBAL);
  assert.deepEqual([...g].sort(), ['INSERT', 'SELECT', 'UPDATE']);
});

test('ALL PRIVILEGES expands to every data privilege, but not GRANT OPTION', () => {
  const p = parseGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`']);
  const g = privsForScope(p, GLOBAL);
  for (const priv of DATA_PRIVILEGES) assert.ok(g.has(priv), `expected ${priv}`);
  assert.ok(!g.has('GRANT OPTION'), 'ALL PRIVILEGES does not include GRANT OPTION');
});

test('WITH GRANT OPTION becomes the GRANT OPTION member', () => {
  const p = parseGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION']);
  assert.ok(privsForScope(p, GLOBAL).has('GRANT OPTION'));
});

test('back-tick quoted db and table scopes are keyed correctly', () => {
  const p = parseGrants([
    'GRANT SELECT ON `shop`.* TO `u`@`%`',
    'GRANT SELECT, INSERT ON `shop`.`orders` TO `u`@`%`',
  ]);
  assert.deepEqual([...privsForScope(p, SHOP)], ['SELECT']);
  assert.deepEqual([...privsForScope(p, ORDERS)].sort(), ['INSERT', 'SELECT']);
  // The two scopes are distinct buckets.
  assert.equal(privsForScope(p, SHOP).has('INSERT'), false);
});

test('USAGE means no privileges and role / proxy lines are ignored', () => {
  const p = parseGrants([
    'GRANT USAGE ON *.* TO `report`@`%`',
    'GRANT `app_role` TO `report`@`%`',
  ]);
  assert.equal(privsForScope(p, GLOBAL).size, 0);
});

test('column-level SELECT (col) parses as plain SELECT', () => {
  const p = parseGrants(['GRANT SELECT (id, name), UPDATE (name) ON `shop`.`orders` TO `u`@`%`']);
  assert.deepEqual([...privsForScope(p, ORDERS)].sort(), ['SELECT', 'UPDATE']);
});

test('a bare (unquoted) database name canonicalises to the same key', () => {
  const p = parseGrants(['GRANT SELECT ON shop.* TO `u`@`%`']);
  assert.deepEqual([...privsForScope(p, SHOP)], ['SELECT']);
});

// ── diff → SQL ────────────────────────────────────────────────────────────────

const ACC = "'u'@'%'";

test('adding privileges emits a single GRANT', () => {
  const sql = grantDiffSql({
    account: ACC, scope: SHOP,
    current: ['SELECT'], desired: ['SELECT', 'INSERT', 'UPDATE'],
  });
  assert.equal(sql, "GRANT INSERT, UPDATE ON `shop`.* TO 'u'@'%';");
});

test('removing privileges emits a single REVOKE', () => {
  const sql = grantDiffSql({
    account: ACC, scope: SHOP,
    current: ['SELECT', 'INSERT', 'DELETE'], desired: ['SELECT'],
  });
  assert.equal(sql, "REVOKE INSERT, DELETE ON `shop`.* FROM 'u'@'%';");
});

test('adding and removing at once emits GRANT then REVOKE', () => {
  const sql = grantDiffSql({
    account: ACC, scope: ORDERS,
    current: ['SELECT', 'DELETE'], desired: ['SELECT', 'INSERT'],
  });
  assert.equal(sql,
    "GRANT INSERT ON `shop`.`orders` TO 'u'@'%';\n"
    + "REVOKE DELETE ON `shop`.`orders` FROM 'u'@'%';");
});

test('no change produces no SQL', () => {
  assert.equal(grantDiffSql({
    account: ACC, scope: GLOBAL,
    current: ['SELECT', 'INSERT'], desired: ['INSERT', 'SELECT'],
  }), '');
});

test('GRANT OPTION rides the WITH clause, never the privilege list', () => {
  const sql = grantDiffSql({
    account: ACC, scope: SHOP,
    current: ['SELECT'], desired: ['SELECT', 'INSERT', 'GRANT OPTION'],
  });
  assert.equal(sql, "GRANT INSERT ON `shop`.* TO 'u'@'%' WITH GRANT OPTION;");
});

test('granting only GRANT OPTION falls back to USAGE as the placeholder', () => {
  const sql = grantDiffSql({
    account: ACC, scope: SHOP,
    current: ['SELECT'], desired: ['SELECT', 'GRANT OPTION'],
  });
  assert.equal(sql, "GRANT USAGE ON `shop`.* TO 'u'@'%' WITH GRANT OPTION;");
});

test('revoking GRANT OPTION goes in the REVOKE list as a named privilege', () => {
  const sql = grantDiffSql({
    account: ACC, scope: SHOP,
    current: ['SELECT', 'GRANT OPTION'], desired: ['SELECT'],
  });
  assert.equal(sql, "REVOKE GRANT OPTION ON `shop`.* FROM 'u'@'%';");
});

test('privileges come out in matrix-column order regardless of input order', () => {
  const sql = grantDiffSql({
    account: ACC, scope: GLOBAL,
    current: [], desired: ['DELETE', 'SELECT', 'INSERT'],
  });
  assert.equal(sql, "GRANT SELECT, INSERT, DELETE ON *.* TO 'u'@'%';");
});

test('global scope renders as *.* unquoted', () => {
  const sql = grantDiffSql({
    account: ACC, scope: GLOBAL, current: [], desired: ['SELECT'],
  });
  assert.equal(sql, "GRANT SELECT ON *.* TO 'u'@'%';");
});

test('round-trip: parsed grants diffed against themselves are a no-op', () => {
  const lines = ['GRANT SELECT, INSERT ON `shop`.* TO `u`@`%` WITH GRANT OPTION'];
  const p = parseGrants(lines);
  const cur = privsForScope(p, SHOP);
  assert.equal(grantDiffSql({ account: ACC, scope: SHOP, current: cur, desired: cur }), '');
});

test('PRIVILEGES lists GRANT OPTION last and DATA_PRIVILEGES omits it', () => {
  assert.equal(PRIVILEGES[PRIVILEGES.length - 1], 'GRANT OPTION');
  assert.ok(!DATA_PRIVILEGES.includes('GRANT OPTION' as never));
});
