import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const compare = readFileSync('src/components/SchemaComparePanel.tsx', 'utf8');
const designer = readFileSync('src/components/TableDesigner.tsx', 'utf8');
const tabs = readFileSync('src/components/QueryTabs.tsx', 'utf8');
const panel = readFileSync('src/components/MigrationPanel.tsx', 'utf8');

test('Schema Compare sends both migration directions to the exact target through the strict event', () => {
  assert.ok(compare.includes("origin: 'schema-compare', targetConnectionId: migration.targetConnectionId"));
  assert.ok(compare.includes("reviewMigration('ltr')"));
  assert.ok(compare.includes("reviewMigration('rtl')"));
  assert.ok(compare.includes("window.dispatchEvent(new CustomEvent(OPEN_MIGRATION_EVENT"));
  assert.ok(!compare.includes('rehearsalProof'));
});

test('Table Designer handoff carries SQL metadata only and always mounts an unreviewed origin-aware panel', () => {
  assert.ok(designer.includes("origin: 'table-designer', targetConnectionId: session.connectionId"));
  assert.ok(!designer.includes('rehearsalProof'));
  assert.ok(tabs.includes("initialOrigin={c.migrationHandoff?.handoff.origin ?? 'editor'}"));
  assert.ok(tabs.includes("key={c.migrationHandoff?.id ?? 'manual'}"));
  assert.ok(panel.includes('origin: initialOrigin'));
  assert.ok(!tabs.includes('phase: \'done\''));
});
