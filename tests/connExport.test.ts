/**
 * Encrypted-export detection (src/utils/connExport.ts, W5.2).
 *
 * The behaviour this locks in: import decides whether to ask for a passphrase
 * from the file's SHAPE alone — the encrypted envelope (`{v:1, kdf…}`) vs the
 * plain one (`{version:1, connections:[…]}`) — and a malformed file is a plain
 * import attempt (which then fails with the importer's own error), never a
 * spurious passphrase prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEncryptedExport } from '../src/utils/connExport.ts';

test('the encrypted envelope is detected by v + kdf', () => {
  assert.equal(isEncryptedExport(JSON.stringify({
    v: 1, kdf: { algo: 'argon2id', salt: 'AA==' }, data: 'BB==',
  })), true);
});

test('the plain export envelope is NOT encrypted', () => {
  assert.equal(isEncryptedExport(JSON.stringify({
    version: 1, connections: [{ id: 'x', name: 'local' }],
  })), false);
});

test('a kdf without v:1 is not our envelope (future versions prompt no passphrase)', () => {
  assert.equal(isEncryptedExport(JSON.stringify({ v: 2, kdf: {} })), false);
  assert.equal(isEncryptedExport(JSON.stringify({ kdf: {} })), false);
});

test('garbage, arrays and scalars are not encrypted exports', () => {
  assert.equal(isEncryptedExport('not json at all'), false);
  assert.equal(isEncryptedExport('[]'), false);
  assert.equal(isEncryptedExport('"v:1"'), false);
  assert.equal(isEncryptedExport(''), false);
  assert.equal(isEncryptedExport(JSON.stringify({ v: 1, kdf: 'argon2id' })), false);
});
