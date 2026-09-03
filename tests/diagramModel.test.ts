import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDiagram, growSelection, matchTables, parseDiagramFile, prefixColors,
  serializeDiagrams, tableColor, tablePrefix,
} from '../src/utils/diagramModel.ts';
import type { ErEdge } from '../src/utils/erLayout.ts';

const edge = (from: string, to: string): ErEdge =>
  ({ fromTable: from, fromCol: 'x', toTable: to, toCol: 'id' });

describe('parseDiagramFile', () => {
  test('reads back what serializeDiagrams wrote', () => {
    const d = emptyDiagram('Orders', 'shop', 'id-1', '2026-08-11T00:00:00Z');
    d.tables = [{ name: 'orders', x: 10, y: 20, color: null, density: null }];
    const back = parseDiagramFile(serializeDiagrams([d]));
    assert.deepEqual(back, [d]);
  });

  // Everything below is a file that exists on someone's disk. The only
  // acceptable failure is "no saved diagrams", never a crash.
  test('garbage in any form yields no diagrams rather than throwing', () => {
    for (const bad of ['', null, undefined, 'not json', '[]', '{}', '{"diagrams":null}', '{"diagrams":{}}']) {
      assert.deepEqual(parseDiagramFile(bad as string), []);
    }
  });

  test('a truncated file does not throw', () => {
    assert.deepEqual(parseDiagramFile('{"version":1,"diagrams":[{"id":"a","na'), []);
  });

  test('one broken diagram does not take the good ones with it', () => {
    const text = JSON.stringify({
      version: 1,
      diagrams: [
        { id: 'a', name: 'Good', schema: 's', tables: [], notes: [] },
        { name: 'No id', schema: 's' },
        null,
        42,
        { id: 'b', name: 'Also good', schema: 's', tables: [], notes: [] },
      ],
    });
    assert.deepEqual(parseDiagramFile(text).map(d => d.id), ['a', 'b']);
  });

  test('a table entry without a name is dropped, the rest survive', () => {
    const text = JSON.stringify({ version: 1, diagrams: [
      { id: 'a', name: 'D', schema: 's', tables: [{ x: 1 }, { name: 'ok', x: 5, y: 6 }] },
    ]});
    const [d] = parseDiagramFile(text);
    assert.deepEqual(d.tables, [{ name: 'ok', x: 5, y: 6, color: null, density: null }]);
  });

  test('non-numeric coordinates fall back to the origin instead of NaN', () => {
    const text = JSON.stringify({ version: 1, diagrams: [
      { id: 'a', name: 'D', schema: 's', tables: [{ name: 't', x: 'left', y: null }] },
    ]});
    const [d] = parseDiagramFile(text);
    assert.equal(d.tables[0].x, 0);
    assert.equal(d.tables[0].y, 0);
  });

  test('an unknown density or colour mode falls back to the default', () => {
    const text = JSON.stringify({ version: 1, diagrams: [
      { id: 'a', name: 'D', schema: 's', density: 'tiny', colorMode: 'rainbow' },
    ]});
    const [d] = parseDiagramFile(text);
    assert.equal(d.density, 'all');
    assert.equal(d.colorMode, 'none');
  });

  /// A scale of 0 renders nothing and cannot be zoomed back out of.
  test('an unusable saved zoom is clamped back to 1', () => {
    for (const s of [0, -1, 1e9]) {
      const text = JSON.stringify({ version: 1, diagrams: [
        { id: 'a', name: 'D', schema: 's', view: { x: 0, y: 0, s } },
      ]});
      assert.equal(parseDiagramFile(text)[0].view?.s, 1);
    }
    const okay = JSON.stringify({ version: 1, diagrams: [
      { id: 'a', name: 'D', schema: 's', view: { x: 3, y: 4, s: 0.5 } },
    ]});
    assert.deepEqual(parseDiagramFile(okay)[0].view, { x: 3, y: 4, s: 0.5 });
  });
});

describe('growSelection', () => {
  // customers <- orders <- order_lines,  orders -> couriers
  const edges = [edge('orders', 'customers'), edge('order_lines', 'orders'), edge('orders', 'couriers')];

  test('zero hops changes nothing', () => {
    assert.deepEqual([...growSelection(['orders'], edges, 0, 'both')], ['orders']);
  });

  test('referenced walks to what the table depends on', () => {
    const got = growSelection(['orders'], edges, 1, 'referenced');
    assert.deepEqual([...got].sort(), ['couriers', 'customers', 'orders']);
  });

  test('referencing walks to what depends on the table', () => {
    const got = growSelection(['orders'], edges, 1, 'referencing');
    assert.deepEqual([...got].sort(), ['order_lines', 'orders']);
  });

  test('both directions reach everything one hop away', () => {
    const got = growSelection(['orders'], edges, 1, 'both');
    assert.deepEqual([...got].sort(), ['couriers', 'customers', 'order_lines', 'orders']);
  });

  test('a second hop reaches further', () => {
    const got = growSelection(['order_lines'], edges, 2, 'referenced');
    assert.deepEqual([...got].sort(), ['couriers', 'customers', 'order_lines', 'orders']);
  });

  /// A cycle must terminate rather than loop forever.
  test('a cycle converges instead of spinning', () => {
    const cyc = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    assert.deepEqual([...growSelection(['a'], cyc, 99, 'both')].sort(), ['a', 'b', 'c']);
  });

  /// A self-reference would otherwise consume a hop and reach nothing.
  test('a self-reference does not waste a hop', () => {
    const withSelf = [edge('t', 't'), edge('t', 'parent')];
    assert.deepEqual([...growSelection(['t'], withSelf, 1, 'referenced')].sort(), ['parent', 't']);
  });

  test('an unknown seed simply stays alone', () => {
    assert.deepEqual([...growSelection(['nope'], edges, 3, 'both')], ['nope']);
  });
});

describe('matchTables', () => {
  const tables = [
    { name: 'orders', columns: [{ name: 'id' }, { name: 'customer_id' }] },
    { name: 'customers', columns: [{ name: 'id' }, { name: 'vat_id' }] },
  ];

  test('matches on table name, case-insensitively', () => {
    assert.deepEqual([...matchTables('ORD', tables)], ['orders']);
  });

  /// The half that earns its keep: you rarely remember which table a column is on.
  test('matches on column name', () => {
    assert.deepEqual([...matchTables('vat', tables)], ['customers']);
  });

  test('an empty or blank query matches nothing, not everything', () => {
    assert.equal(matchTables('', tables).size, 0);
    assert.equal(matchTables('   ', tables).size, 0);
  });

  test('a query matching both returns both', () => {
    assert.deepEqual([...matchTables('id', tables)].sort(), ['customers', 'orders']);
  });
});

describe('prefix grouping', () => {
  test('takes the leading segment before the first underscore', () => {
    assert.equal(tablePrefix('wapi_orders'), 'wapi');
    assert.equal(tablePrefix('billing_invoice_lines'), 'billing');
  });

  test('a schema qualifier is ignored', () => {
    assert.equal(tablePrefix('shop.wapi_orders'), 'wapi');
  });

  test('a name with no usable prefix is left ungrouped', () => {
    for (const n of ['orders', '_leading', 'trailing_', 'x']) {
      assert.equal(tablePrefix(n), null, n);
    }
  });

  /// Stability is the point: the same prefix must be the same colour
  /// tomorrow, and in a colleague's copy of the diagram.
  test('a prefix gets the same colour regardless of table order', () => {
    const palette = ['#a', '#b', '#c', '#d'];
    const one = prefixColors(['wapi_a', 'billing_b'], palette);
    const two = prefixColors(['billing_b', 'wapi_a', 'wapi_c'], palette);
    assert.equal(one.get('wapi'), two.get('wapi'));
    assert.equal(one.get('billing'), two.get('billing'));
  });

  test('an empty palette yields no colours rather than dividing by zero', () => {
    assert.equal(prefixColors(['wapi_a'], []).size, 0);
  });
});

describe('tableColor', () => {
  const byPrefix = new Map([['wapi', '#123456']]);

  test('an explicit colour wins over the mode', () => {
    assert.equal(tableColor({ name: 'wapi_a', color: '#fff' }, 'prefix', byPrefix), '#fff');
    assert.equal(tableColor({ name: 'wapi_a', color: '#fff' }, 'none', byPrefix), '#fff');
  });

  test('prefix mode colours by prefix', () => {
    assert.equal(tableColor({ name: 'wapi_a', color: null }, 'prefix', byPrefix), '#123456');
  });

  test('none means no colour at all', () => {
    assert.equal(tableColor({ name: 'wapi_a', color: null }, 'none', byPrefix), null);
  });

  test('an unknown prefix falls back to the default rather than a wrong colour', () => {
    assert.equal(tableColor({ name: 'other_a', color: null }, 'prefix', byPrefix), null);
  });
});
