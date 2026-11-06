import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, can, enginesWith } from '../src/utils/engineCaps.ts';
import { safeOperationCapability, safeOperationUnavailableReason } from '../src/utils/operationSupport.ts';

test('safe operation capabilities name their initial engine surface', () => {
  assert.deepEqual(enginesWith('migrationCockpit'), ['mysql', 'postgres']);
  assert.deepEqual(enginesWith('environmentRefresh'), ['mysql']);
  assert.deepEqual(enginesWith('queryLab'), ['mysql', 'postgres']);
});

test('panel ids map to their real capabilities and every unsupported render explains itself', () => {
  for (const engine of ENGINES) {
    for (const panel of ['migration', 'refresh', 'querylab'] as const) {
      const reason = safeOperationUnavailableReason(engine, panel);
      if (can(engine, safeOperationCapability(panel))) assert.equal(reason, null, `${engine}.${panel}`);
      else assert.match(reason ?? '', /not available|currently/, `${engine}.${panel}`);
    }
  }
});

test('unknown engines fail closed without inventing a gap reason', () => {
  for (const cap of ['migrationCockpit', 'environmentRefresh', 'queryLab'] as const) {
    assert.equal(can('oracle', cap), false);
  }
});
