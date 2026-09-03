/**
 * DDL audit (src/utils/ddlAudit.ts) — D4 reserved-word column names.
 * The rule used to carry a 16-word hardcoded list; it now checks the full
 * MySQL ∪ PostgreSQL reserved set shared with identifier quoting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditDdl } from '../src/utils/ddlAudit.ts';

const DDL = (cols: string) => `CREATE TABLE \`t\` (
${cols}
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const d4 = (ddl: string) => auditDdl('t', ddl).filter(f => f.id === 'D4');

test('reserved-word column is flagged', () => {
  const findings = d4(DDL('  `id` int unsigned NOT NULL,\n  `order` int NOT NULL,\n  PRIMARY KEY (`id`)'));
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /`order`/);
  assert.match(findings[0].title, /reserved SQL word/);
});

test('words beyond the old hardcoded list are now caught', () => {
  // `condition`, `cursor`, `analyze` were not in the old 16-word list
  const findings = d4(DDL('  `id` int unsigned NOT NULL,\n  `condition` varchar(50) DEFAULT NULL,\n  `cursor` int NOT NULL,\n  `analyze` datetime DEFAULT NULL,\n  PRIMARY KEY (`id`)'));
  assert.equal(findings.length, 3);
});

test('ordinary column names are left alone', () => {
  const findings = d4(DDL('  `id` int unsigned NOT NULL,\n  `order_status` varchar(20) NOT NULL,\n  `delivery_date` date DEFAULT NULL,\n  PRIMARY KEY (`id`)'));
  assert.equal(findings.length, 0);
});

test('a column named after a constraint introducer is caught', () => {
  // `key`/`index` used to be filtered out as supposed constraint lines
  const findings = d4(DDL('  `id` int unsigned NOT NULL,\n  `key` int NOT NULL,\n  `index` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`id`)'));
  assert.equal(findings.length, 2);
});
