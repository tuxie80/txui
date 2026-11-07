import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REFRESH_SPEC_BYTES, createDefaultRefreshSpec, parseRefreshSpec,
  parseRefreshSpecText, refreshSpecHints, serializeRefreshSpec,
} from '../src/utils/refreshSpec.ts';

const base = createDefaultRefreshSpec({
  source: { connectionId: 'source-connection', sessionId: 'source-session' },
  schema: 'shop', cutoffUtc: '2026-11-06T12:00:00.000Z',
});

function targeted() {
  return {
    ...structuredClone(base),
    target: { connectionId: 'target-connection', sessionId: 'target-session' },
  };
}

test('default policies are independent and deterministic across serialization', () => {
  const spec = targeted();
  assert.deepEqual(spec.tables.map(table => table.policy), ['full', 'time_window', 'time_window']);
  assert.deepEqual(spec.tables.map(table => table.policy === 'time_window' ? table.amount : null), [null, 7, 1]);
  const first = serializeRefreshSpec(spec);
  assert.equal(first, serializeRefreshSpec(parseRefreshSpecText(first)));
  assert.equal(parseRefreshSpecText(first).tables[1].cutoffUtc, '2026-11-06T12:00:00.000Z');
});

test('strictly rejects version, unknown fields, secrets, rows and malformed endpoints', () => {
  for (const value of [
    { ...targeted(), version: 2 },
    { ...targeted(), engine: 'postgres' },
    { ...targeted(), password: 'secret' },
    { ...targeted(), connectionUrl: 'mysql://user:pass@host' },
    { ...targeted(), rows: [[1, 'private']] },
    { ...targeted(), queryResult: { rows: [] } },
    { ...targeted(), maskingKey: 'derived-from-password' },
    { ...targeted(), source: { connectionId: 'source', sessionId: 'same' }, target: { connectionId: 'target', sessionId: 'same' } },
  ]) assert.throws(() => parseRefreshSpec(value));
  assert.throws(() => parseRefreshSpec({ ...targeted(), extra: true }), /unexpected fields/);
  assert.throws(() => parseRefreshSpec({ ...targeted(), limits: { ...base.limits, nestedSecret: 'x' } }), /unexpected fields/);
});

test('rejects malformed JSON, non-objects and oversized specs', () => {
  assert.throws(() => parseRefreshSpecText('{broken'), /not valid JSON/);
  assert.throws(() => parseRefreshSpecText('[]'), /must be an object/);
  assert.throws(() => parseRefreshSpecText(`{"x":"${'a'.repeat(MAX_REFRESH_SPEC_BYTES)}"}`), /2 MiB limit/);
});

test('time windows require exact frozen UTC, named zone, NULL policy and explicit column', () => {
  for (const cutoffUtc of ['2026-11-06', '2026-11-06 12:00:00', '2026-11-06T12:00:00Z', 'not-a-date']) {
    const spec = targeted();
    spec.tables[1] = { ...spec.tables[1], cutoffUtc };
    assert.throws(() => parseRefreshSpec(spec), /cutoffUtc/);
  }
  const spec = targeted();
  spec.tables[1] = { ...spec.tables[1], column: '' };
  assert.throws(() => parseRefreshSpec(spec), /column/);
  spec.tables[1] = { ...spec.tables[1], column: 'created_at', nullPolicy: 'include' };
  assert.equal(parseRefreshSpec(spec).tables[1].nullPolicy, 'include');
});

test('row limits, samples, predicates and generators validate deterministic inputs', () => {
  const spec = targeted();
  spec.tables = [
    { table: 'a', policy: 'row_limit', rows: 20, orderBy: ['created_at'], direction: 'desc', tieBreaker: ['id'] },
    { table: 'b', policy: 'sample', rows: 10, sampleSeed: 42, tieBreaker: ['id'] },
    { table: 'c', policy: 'predicate', where: 'tenant_id = 7 AND deleted_at IS NULL' },
    { table: 'd', policy: 'generate', rows: 100, seedOffset: 3 },
    { table: 'e', policy: 'exclude' },
  ];
  const parsed = parseRefreshSpecText(serializeRefreshSpec(spec));
  assert.equal(parsed.tables.length, 5);
  assert.deepEqual(parsed.tables.slice(0, 2).map(table => table.policy === 'row_limit' || table.policy === 'sample' ? table.limitKind : null), ['soft', 'soft']);
  spec.tables[1] = { table: 'b', policy: 'sample', rows: 10, sampleSeed: 42, tieBreaker: ['id'], limitKind: 'hard' };
  const hard = parseRefreshSpecText(serializeRefreshSpec(spec));
  assert.equal(hard.tables[1].policy === 'sample' ? hard.tables[1].limitKind : null, 'hard');
  assert.throws(() => parseRefreshSpec({ ...spec, tables: [{ table: 'x', policy: 'sample', rows: 5, sampleSeed: 1, tieBreaker: ['id'], limitKind: 'unlimited' }] }), /limitKind/);
  assert.throws(() => parseRefreshSpec({ ...spec, tables: [{ table: 'x', policy: 'row_limit', rows: 5, orderBy: [], direction: 'desc', tieBreaker: ['id'] }] }), /orderBy/);
  assert.throws(() => parseRefreshSpec({ ...spec, tables: [{ table: 'x', policy: 'predicate', where: 'x = 1; DROP TABLE x' }] }), /terminator/);
});

test('masks accept only primitive constants and strict generators without secret key material', () => {
  const spec = targeted();
  spec.masks = [
    { table: 'customers', column: 'id', rule: 'preserve' },
    { table: 'customers', column: 'email', rule: 'hash' },
    { table: 'customers', column: 'name', rule: 'fake', generator: 'person.full_name' },
    { table: 'customers', column: 'enabled', rule: 'constant', value: false },
    { table: 'customers', column: 'deleted_at', rule: 'constant', value: null },
  ];
  assert.equal(parseRefreshSpecText(serializeRefreshSpec(spec)).masks.length, 5);
  assert.throws(() => parseRefreshSpec({ ...spec, masks: [{ table: 'c', column: 'x', rule: 'constant', value: { nested: true } }] }), /value/);
  assert.throws(() => parseRefreshSpec({ ...spec, masks: [{ table: 'c', column: 'x', rule: 'hash', salt: 'password' }] }), /unexpected fields/);
});

test('imports expose connection hints but clear both session selections', () => {
  const hints = refreshSpecHints(targeted());
  assert.equal(hints.source.connectionId, 'source-connection');
  assert.equal(hints.target.connectionId, 'target-connection');
  assert.equal(hints.source.sessionId, null);
  assert.equal(hints.target.sessionId, null);
  assert.equal('confirmed' in hints, false);
});

test('sensitive acknowledgment defaults to false and round-trips explicitly', () => {
  const spec = targeted();
  delete spec.acknowledgeUnmaskedSensitive;
  assert.equal(parseRefreshSpec(spec).acknowledgeUnmaskedSensitive, false);
  spec.acknowledgeUnmaskedSensitive = true;
  assert.equal(parseRefreshSpecText(serializeRefreshSpec(spec)).acknowledgeUnmaskedSensitive, true);
  assert.throws(() => parseRefreshSpec({ ...spec, acknowledgeUnmaskedSensitive: 'yes' }), /must be boolean/);
});
