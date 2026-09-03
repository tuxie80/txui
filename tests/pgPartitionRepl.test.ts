import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pgCreatePartitionSql, pgAttachPartitionSql, pgDetachPartitionSql,
  pgCreatePublicationSql, pgDropPublicationSql, pgRefreshPublicationSql,
  pgCreateSubscriptionSql, pgCreateSlotSql, pgDropSlotSql,
} from '../src/utils/pgObjectSql.ts';

test('range/list/hash/default partitions', () => {
  assert.equal(pgCreatePartitionSql('sales', 'sales_2025', { kind: 'range', from: "'2025-01-01'", to: "'2026-01-01'" }),
    'CREATE TABLE "sales_2025" PARTITION OF "sales" FOR VALUES FROM (\'2025-01-01\') TO (\'2026-01-01\');');
  assert.match(pgCreatePartitionSql('t', 'app.t_eu', { kind: 'list', values: "'DE','FR'" }),
    /PARTITION OF "t" FOR VALUES IN \('DE','FR'\);/);
  assert.match(pgCreatePartitionSql('t', 't_h0', { kind: 'hash', modulus: 4, remainder: 0 }),
    /FOR VALUES WITH \(MODULUS 4, REMAINDER 0\);/);
  assert.match(pgCreatePartitionSql('t', 't_def', { kind: 'default' }), /PARTITION OF "t" DEFAULT;/);
});

test('attach / detach (incl. concurrently)', () => {
  assert.match(pgAttachPartitionSql('sales', 'sales_2025', { kind: 'range', from: '1', to: '2' }),
    /ALTER TABLE "sales" ATTACH PARTITION "sales_2025" FOR VALUES FROM \(1\) TO \(2\);/);
  assert.equal(pgDetachPartitionSql('sales', 'sales_2025', { concurrently: true }),
    'ALTER TABLE "sales" DETACH PARTITION "sales_2025" CONCURRENTLY;');
});

test('logical replication builders', () => {
  assert.equal(pgCreatePublicationSql('p', { allTables: true }), 'CREATE PUBLICATION "p" FOR ALL TABLES;');
  assert.match(pgCreatePublicationSql('p', { tables: ['a', 'b'] }), /FOR TABLE "a", "b";/);
  assert.equal(pgDropPublicationSql('p'), 'DROP PUBLICATION IF EXISTS "p";');
  assert.equal(pgRefreshPublicationSql('s'), 'ALTER SUBSCRIPTION "s" REFRESH PUBLICATION;');
  assert.match(pgCreateSubscriptionSql('s', "host=x dbname=y password=z", ['p']),
    /CREATE SUBSCRIPTION "s"\n {2}CONNECTION 'host=x dbname=y password=z'\n {2}PUBLICATION "p";/);
  assert.match(pgCreateSlotSql('slot1', { logical: true }), /pg_create_logical_replication_slot\('slot1', 'pgoutput'\);/);
  assert.equal(pgDropSlotSql('slot1'), "SELECT pg_drop_replication_slot('slot1');");
});
