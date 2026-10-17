/**
 * User schema-kit import (src/utils/userKits.ts): a valid kit round-trips, and
 * every error class is detected and reported — all at once, with locations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUserKit, parseStoredKits, MAX_KIT_BASE_ROWS, MAX_KIT_RATIO,
} from '../src/utils/userKits.ts';
import { resolveRowCounts, kitTableSpecs, buildKitTableDdl } from '../src/utils/schemaKits.ts';

/** The smallest kit that exercises every feature: base + ratio rows, an FK,
 *  a self-FK, params, an index. */
const VALID = {
  id: 'acme_shop',
  title: 'Acme shop',
  description: 'demo',
  defaultName: 'acme_demo',
  tables: [
    {
      name: 'customers', rows: { base: 100 },
      columns: [
        { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
        { name: 'email', type: 'VARCHAR(255)', unique: true, generator: 'email',
          params: { nullPct: 5 } },
      ],
    },
    {
      name: 'orders', rows: { per: 'customers', ratio: 4 }, indexes: [['customer_id']],
      columns: [
        { name: 'id', type: 'BIGINT', pk: true, generator: 'sequence' },
        { name: 'customer_id', type: 'BIGINT', generator: 'fk',
          fk: { table: 'customers', column: 'id', dist: 'zipf' } },
        // Self-reference, like the bundled HR kit's manager_id.
        { name: 'parent_order_id', type: 'BIGINT', nullable: true, generator: 'fk',
          fk: { table: 'orders', column: 'id' } },
      ],
    },
  ],
};

function kitWith(mutate: (k: Record<string, unknown>) => void): string {
  const k = JSON.parse(JSON.stringify(VALID));
  mutate(k);
  return JSON.stringify(k);
}

test('a valid kit parses, and the parse is idempotent (round-trip)', () => {
  const first = parseUserKit(JSON.stringify(VALID));
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.warnings.length, 0);
  const second = parseUserKit(JSON.stringify(first.kit));
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepEqual(second.kit, first.kit);
});

test('a parsed kit drives the kit machinery (row counts, specs, DDL)', () => {
  const r = parseUserKit(JSON.stringify(VALID));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(resolveRowCounts(r.kit, 1).get('orders'), 400);
  const specs = kitTableSpecs('acme_demo', r.kit.tables[1], 'mysql');
  const fkCol = specs.find(s => s.name === 'customer_id');
  assert.equal(fkCol?.params.fkTable, '`acme_demo`.`customers`');
  assert.equal(fkCol?.params.dist, 'zipf');
  const ddl = buildKitTableDdl('acme_demo', r.kit.tables[1], 'mysql').join('\n');
  assert.match(ddl, /FOREIGN KEY \(`customer_id`\) REFERENCES `acme_demo`\.`customers` \(`id`\)/);
});

test('not JSON / not an object', () => {
  assert.match(parseUserKit('{oops').ok === false ? (parseUserKit('{oops') as { errors: string[] }).errors[0] : '', /not valid JSON/);
  const r = parseUserKit('[1,2]');
  assert.ok(!r.ok);
  assert.match((r as { errors: string[] }).errors[0], /JSON object/);
});

test('identity errors: missing id, bad id, bundled-id collision, title, defaultName', () => {
  const cases: [string, RegExp][] = [
    [kitWith(k => { delete k.id; }), /\bid\b.*needs an id/],
    [kitWith(k => { k.id = 'Acme Shop!'; }), /lowercase letters/],
    [kitWith(k => { k.id = 'retail'; }), /taken by a bundled kit/],
    [kitWith(k => { k.title = ' '; }), /title/],
    [kitWith(k => { delete k.defaultName; }), /defaultName/],
    [kitWith(k => { k.defaultName = '1bad name'; }), /SQL identifier/],
  ];
  for (const [text, re] of cases) {
    const r = parseUserKit(text);
    assert.ok(!r.ok, `expected failure matching ${re}`);
    assert.ok((r as { errors: string[] }).errors.some(e => re.test(e)),
      `${re} not in ${(r as { errors: string[] }).errors.join(' | ')}`);
  }
});

test('table errors: empty, duplicate, bad name', () => {
  const r1 = parseUserKit(kitWith(k => { k.tables = []; }));
  assert.ok(!r1.ok && r1.errors.some(e => /at least one table/.test(e)));
  const r2 = parseUserKit(kitWith(k => {
    (k.tables as unknown[]).push(JSON.parse(JSON.stringify((k.tables as unknown[])[0])));
  }));
  assert.ok(!r2.ok && r2.errors.some(e => /duplicate table name/.test(e)));
  const r3 = parseUserKit(kitWith(k => {
    ((k.tables as Record<string, unknown>[])[0]).name = 'bad name';
  }));
  assert.ok(!r3.ok && r3.errors.some(e => /table name must be a SQL identifier/.test(e)));
});

test('row counts: errors on bad shape, clamps out-of-range with a warning', () => {
  const bad = parseUserKit(kitWith(k => {
    (k.tables as Record<string, unknown>[])[0].rows = { base: 'many' };
  }));
  assert.ok(!bad.ok && bad.errors.some(e => /rows\.base must be a number/.test(e)));

  const clamped = parseUserKit(kitWith(k => {
    (k.tables as Record<string, unknown>[])[0].rows = { base: 1e18 };
    (k.tables as Record<string, unknown>[])[1].rows = { per: 'customers', ratio: 99999 };
  }));
  assert.ok(clamped.ok);
  if (!clamped.ok) return;
  assert.equal((clamped.kit.tables[0].rows as { base: number }).base, MAX_KIT_BASE_ROWS);
  assert.equal((clamped.kit.tables[1].rows as { per: string; ratio: number }).ratio, MAX_KIT_RATIO);
  assert.equal(clamped.warnings.length, 2);
  assert.ok(clamped.warnings.every(w => /clamped/.test(w)));
});

test('rows.per must name an earlier table — not itself, not a later one, not a stranger', () => {
  const self = parseUserKit(kitWith(k => {
    (k.tables as Record<string, unknown>[])[0].rows = { per: 'customers', ratio: 2 };
  }));
  assert.ok(!self.ok && self.errors.some(e => /cannot be the table itself/.test(e)));

  const stranger = parseUserKit(kitWith(k => {
    (k.tables as Record<string, unknown>[])[1].rows = { per: 'nope', ratio: 2 };
  }));
  assert.ok(!stranger.ok && stranger.errors.some(e => /rows\.per references "nope"/.test(e)));

  // A later table: customers is parsed first, so per: 'orders' points at a
  // table whose count does not exist yet.
  const later = parseUserKit(kitWith(k => {
    (k.tables as Record<string, unknown>[])[0].rows = { per: 'orders', ratio: 2 };
  }));
  assert.ok(!later.ok && later.errors.some(e => /rows\.per references "orders" — it must name an EARLIER table/.test(e)));
});

test('column errors: duplicates, missing type, unknown generator', () => {
  const dup = parseUserKit(kitWith(k => {
    const cols = ((k.tables as Record<string, unknown>[])[0]).columns as unknown[];
    cols.push(JSON.parse(JSON.stringify(cols[0])));
  }));
  assert.ok(!dup.ok && dup.errors.some(e => /duplicate column name/.test(e)));

  const noType = parseUserKit(kitWith(k => {
    delete (((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[0].type;
  }));
  assert.ok(!noType.ok && noType.errors.some(e => /missing type/.test(e)));

  const noGen = parseUserKit(kitWith(k => {
    (((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[0].generator = 'randoom';
  }));
  assert.ok(!noGen.ok && noGen.errors.some(e => /unknown generator "randoom"/.test(e)));
});

test('params: wrong types are errors, ranges clamp with warnings, unknown keys drop with warnings', () => {
  const r = parseUserKit(kitWith(k => {
    (((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[1].params = {
      nullPct: 250, min: 'lots', dist: 'zipfian', frobnicate: 1,
    };
  }));
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.errors.some(e => /param "min" must be a finite number/.test(e)));
  assert.ok(r.errors.some(e => /param "dist" must be one of/.test(e)));
  // The errors kill the import, so clamps/drops never surface here — check
  // them in isolation.
  const r2 = parseUserKit(kitWith(k => {
    (((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[1].params = {
      nullPct: 250, frobnicate: 1,
    };
  }));
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.kit.tables[0].columns[1].params?.nullPct, 100);
  assert.equal((r2.kit.tables[0].columns[1].params as Record<string, unknown>).frobnicate, undefined);
  assert.ok(r2.warnings.some(w => /nullPct 250 clamped to 100/.test(w)));
  assert.ok(r2.warnings.some(w => /unknown param "frobnicate"/.test(w)));
});

test('fk errors: unknown table, later table, missing column, bad dist, group mixing', () => {
  const unknown = parseUserKit(kitWith(k => {
    ((((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1])
      .fk = { table: 'strangers', column: 'id' };
  }));
  assert.ok(!unknown.ok && unknown.errors.some(e => /unknown table "strangers"/.test(e)));

  const later = parseUserKit(kitWith(k => {
    ((((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[1])
      .generator = 'fk';
    ((((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[1])
      .fk = { table: 'orders', column: 'id' };
  }));
  assert.ok(!later.ok && later.errors.some(e => /comes later in the kit/.test(e)));

  const noCol = parseUserKit(kitWith(k => {
    ((((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1])
      .fk = { table: 'customers', column: 'nope' };
  }));
  assert.ok(!noCol.ok && noCol.errors.some(e => /fk column "nope" does not exist/.test(e)));

  const badDist = parseUserKit(kitWith(k => {
    ((((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1])
      .fk = { table: 'customers', column: 'id', dist: 'gaussian' };
  }));
  assert.ok(!badDist.ok && badDist.errors.some(e => /fk\.dist must be/.test(e)));

  const mixing = parseUserKit(kitWith(k => {
    ((((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1])
      .fk = { table: 'customers', column: 'id', group: 'g' };
    ((((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[2])
      .fk = { table: 'orders', column: 'id', group: 'g' };
  }));
  assert.ok(!mixing.ok && mixing.errors.some(e => /mixes targets/.test(e)));
});

test('fk block and generator must agree', () => {
  const noBlock = parseUserKit(kitWith(k => {
    const col = (((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1];
    col.generator = 'fk';
    delete col.fk;
  }));
  assert.ok(!noBlock.ok && noBlock.errors.some(e => /needs an fk block/.test(e)));

  const wrongGen = parseUserKit(kitWith(k => {
    const col = (((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1];
    col.generator = 'int';
  }));
  assert.ok(!wrongGen.ok && wrongGen.errors.some(e => /generator must be "fk"/.test(e)));
});

test('generated columns need all three dialects; indexes must name real columns', () => {
  const gen = parseUserKit(kitWith(k => {
    (((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[]).push({
      name: 'geom', type: 'POINT', generator: 'constant',
      generated: { mysql: 'POINT GENERATED ALWAYS AS (POINT(1,1)) STORED' },
    });
  }));
  assert.ok(!gen.ok && gen.errors.some(e => /all three dialects/.test(e)));

  const idx = parseUserKit(kitWith(k => {
    (k.tables as Record<string, unknown>[])[0].indexes = [['nope']];
  }));
  assert.ok(!idx.ok && idx.errors.some(e => /unknown column "nope"/.test(e)));
});

test('every problem is listed, not just the first', () => {
  const r = parseUserKit(kitWith(k => {
    delete k.title;
    delete k.defaultName;
    (k.tables as Record<string, unknown>[])[0].rows = { base: 'many' };
    (((k.tables as Record<string, unknown>[])[1]).columns as Record<string, unknown>[])[1]
      .fk = { table: 'strangers', column: 'id' };
    (((k.tables as Record<string, unknown>[])[0]).columns as Record<string, unknown>[])[1]
      .generator = 'randoom';
  }));
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.errors.length >= 5, `expected ≥5 errors, got ${r.errors.length}: ${r.errors.join(' | ')}`);
});

test('parseStoredKits keeps kit-shaped entries and drops junk', () => {
  const r = parseUserKit(JSON.stringify(VALID));
  assert.ok(r.ok);
  if (!r.ok) return;
  const stored = parseStoredKits(JSON.parse(JSON.stringify([r.kit, null, 42, { id: 'x' }])));
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], r.kit);
  assert.equal(parseStoredKits('nope').length, 0);
});
