/**
 * PostgreSQL search_path resolution for editor hints (src/utils/searchPath.ts).
 *
 * The rule that matters: `search_path` is an ORDERED list, several schemas are
 * reachable unqualified at once, and the FIRST match wins. Getting this wrong
 * either hides objects that do resolve, or — worse — completes a bare name
 * that silently points at a different schema's object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolution, resolvesBare, isShadowed, pickCandidate } from '../src/utils/searchPath.ts';

const o = (schema: string, name: string) => ({ schema, name });

test('every schema on the path is reachable, not just the first', () => {
  // The bug this replaces: hinting from current_schema() alone hid `lookup`
  // in txui_other even though a bare `SELECT * FROM lookup` resolves.
  const objs = [o('app', 'orders'), o('shared', 'lookup'), o('public', 'audit')];
  const res = buildResolution(objs, ['app', 'shared', 'public']);
  for (const x of objs) assert.ok(resolvesBare(x, res), `${x.schema}.${x.name} must resolve bare`);
});

test('an object off the path never resolves bare', () => {
  const objs = [o('app', 'orders'), o('archive', 'orders_2019')];
  const res = buildResolution(objs, ['app']);
  assert.ok(resolvesBare(o('app', 'orders'), res));
  assert.ok(!resolvesBare(o('archive', 'orders_2019'), res));
  assert.ok(!isShadowed(o('archive', 'orders_2019'), res), 'off-path is not shadowing');
});

test('shadowing: only the earliest schema wins a duplicated name', () => {
  // Both hold `orders`; a bare reference means app.orders. Completing
  // shared.orders unqualified would point at the wrong table.
  const objs = [o('app', 'orders'), o('shared', 'orders')];
  const res = buildResolution(objs, ['app', 'shared']);
  assert.ok(resolvesBare(o('app', 'orders'), res));
  assert.ok(!resolvesBare(o('shared', 'orders'), res));
  assert.ok(isShadowed(o('shared', 'orders'), res), 'must be flagged as shadowed');
});

test('shadowing follows path ORDER, not declaration order', () => {
  const objs = [o('shared', 'orders'), o('app', 'orders')];
  // app is listed second in the object array but FIRST on the path.
  const res = buildResolution(objs, ['app', 'shared']);
  assert.ok(resolvesBare(o('app', 'orders'), res));
  assert.ok(!resolvesBare(o('shared', 'orders'), res));

  // Reverse the path and the winner flips.
  const res2 = buildResolution(objs, ['shared', 'app']);
  assert.ok(resolvesBare(o('shared', 'orders'), res2));
  assert.ok(!resolvesBare(o('app', 'orders'), res2));
});

test('a schema repeated on the path keeps its earliest position', () => {
  const objs = [o('a', 't'), o('b', 't')];
  const res = buildResolution(objs, ['a', 'b', 'a']);
  assert.equal(res.rank.get('a'), 0);
  assert.ok(resolvesBare(o('a', 't'), res));
  assert.ok(!resolvesBare(o('b', 't'), res));
});

test('resolution is case-insensitive on schema and object names', () => {
  const objs = [o('App', 'Orders')];
  const res = buildResolution(objs, ['app']);
  assert.ok(resolvesBare(o('App', 'Orders'), res));
});

test('an empty path means nothing resolves bare', () => {
  const objs = [o('app', 'orders')];
  const res = buildResolution(objs, []);
  assert.ok(!resolvesBare(o('app', 'orders'), res));
  assert.ok(!isShadowed(o('app', 'orders'), res));
});

// ── pickCandidate: which table does a bare reference mean? ────────────────

test('pickCandidate prefers the earliest search_path entry', () => {
  const cands = [o('archive', 'orders'), o('shared', 'orders'), o('app', 'orders')];
  assert.equal(pickCandidate(cands, ['app', 'shared'], '')?.schema, 'app');
  assert.equal(pickCandidate(cands, ['shared', 'app'], '')?.schema, 'shared');
});

test('pickCandidate falls back to the chosen schema, then to anything', () => {
  const cands = [o('archive', 'orders'), o('legacy', 'orders')];
  // Nothing on the path → the explicitly selected schema wins.
  assert.equal(pickCandidate(cands, ['app'], 'legacy')?.schema, 'legacy');
  // Neither → still return something, so columns can still be fetched.
  assert.equal(pickCandidate(cands, ['app'], 'nope')?.schema, 'archive');
  assert.equal(pickCandidate([], ['app'], 'x'), undefined);
});

test('pickCandidate ignores case when matching', () => {
  const cands = [o('App', 'orders')];
  assert.equal(pickCandidate(cands, ['APP'], '')?.schema, 'App');
  assert.equal(pickCandidate(cands, [], 'app')?.schema, 'App');
});

test('MySQL-shaped single-entry path behaves like a current database', () => {
  const objs = [o('shop', 'orders'), o('other', 'orders')];
  const res = buildResolution(objs, ['shop']);
  assert.ok(resolvesBare(o('shop', 'orders'), res));
  assert.ok(!resolvesBare(o('other', 'orders'), res));
});
