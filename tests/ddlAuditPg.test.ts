/**
 * DDL audit, PostgreSQL dialect (src/utils/ddlAuditPg.ts).
 *
 * The shape being defended: the audit reads the CREATE TABLE the backend
 * assembles (quote_ident'd names, format_type() types, CONSTRAINT lines,
 * trailing CREATE INDEX statements) and a bare pasted definition with equal
 * success — and each rule is PG's own judgement, never a MySQL one with the
 * quotes changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPgDdl } from '../src/utils/ddlAuditPg.ts';

/** The assembled shape, as db/postgres.rs table_ddl emits it. */
const DDL = (cols: string, extra = '') => `CREATE TABLE shop.t (
${cols}
);
${extra}`;

const byId = (ddl: string, id: string) => auditPgDdl('t', ddl).filter(f => f.id === id);

// ── parsing ─────────────────────────────────────────────────────────────────

test('bare and quoted column names both parse, one-line bodies too', () => {
  const multi = byId(DDL('    id integer NOT NULL,\n    "select" text'), 'D0');
  assert.equal(multi.length, 0, 'two parseable columns — no parser warning');
  const oneLine = byId('CREATE TABLE t (id integer NOT NULL, name text, PRIMARY KEY (id));', 'D0');
  assert.equal(oneLine.length, 0, 'a one-line CREATE TABLE parses');
});

test('an unparseable definition says so instead of staying silent', () => {
  const f = byId('CREATE TABLE t () ;', 'D0');
  assert.equal(f.length, 1);
});

test('constraint lines are not mistaken for columns', () => {
  const f = auditPgDdl('t', DDL(`    id integer NOT NULL,
    CONSTRAINT t_pkey PRIMARY KEY (id),
    CONSTRAINT chk CHECK (id > 0),
    FOREIGN KEY (id) REFERENCES shop.p (id)`));
  assert.equal(f.filter(x => x.id === 'D0').length, 0);
  // `check`, `foreign` are reserved; if parsed as columns they would fire D4.
  assert.equal(f.filter(x => x.id === 'D4').length, 0);
});

// ── D4 reserved words, graded by PG's own strictness ────────────────────────

test('a PG-reserved column name is orange', () => {
  const f = byId(DDL('    id integer,\n    "user" text,\n    PRIMARY KEY (id)'), 'D4');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'orange');
  assert.match(f[0].title, /"user"/);
  assert.match(f[0].title, /reserved word in PostgreSQL/);
});

test('a name reserved only on MySQL is the yellow cross-engine warning', () => {
  // `rank` is a plain function name on PG, reserved on MySQL 8.
  const f = byId(DDL('    id integer,\n    rank integer,\n    PRIMARY KEY (id)'), 'D4');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'yellow');
  assert.match(f[0].title, /reserved on MySQL/);
});

test('ordinary names are left alone', () => {
  const f = byId(DDL('    id integer,\n    order_status text,\n    delivery_date date,\n    PRIMARY KEY (id)'), 'D4');
  assert.equal(f.length, 0);
});

// ── PG's own type rules ─────────────────────────────────────────────────────

test('timestamp without time zone is the classic finding', () => {
  for (const t of ['timestamp without time zone', 'timestamp']) {
    const f = byId(DDL(`    id integer,\n    created_at ${t} DEFAULT now() NOT NULL,\n    PRIMARY KEY (id)`), 'D20');
    assert.equal(f.length, 1, t);
    assert.match(f[0].detail, /timestamptz/);
  }
});

test('timestamptz and date are not flagged', () => {
  const f = byId(DDL('    id integer,\n    created_at timestamp with time zone NOT NULL,\n    opens_on date,\n    PRIMARY KEY (id)'), 'D20');
  assert.equal(f.length, 0);
});

test('serial and nextval both raise the identity-column note', () => {
  const a = byId(DDL('    id serial,\n    PRIMARY KEY (id)'), 'D21');
  assert.equal(a.length, 1);
  const b = byId(DDL("    id bigint DEFAULT nextval('t_id_seq'::regclass) NOT NULL,\n    PRIMARY KEY (id)"), 'D21');
  assert.equal(b.length, 1);
  // …and a real identity column does not.
  const c = byId(DDL('    id bigint GENERATED ALWAYS AS IDENTITY,\n    PRIMARY KEY (id)'), 'D21');
  assert.equal(c.length, 0);
});

test('the money type is flagged, numeric is not', () => {
  assert.equal(byId(DDL('    id integer,\n    price money,\n    PRIMARY KEY (id)'), 'D22').length, 1);
  assert.equal(byId(DDL('    id integer,\n    price numeric(12,2),\n    PRIMARY KEY (id)'), 'D22').length, 0);
});

test('blank-padded char(n) is flagged, varchar is not', () => {
  const f = byId(DDL('    id integer,\n    code character(8) NOT NULL,\n    PRIMARY KEY (id)'), 'D23');
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /blank/);
  assert.equal(byId(DDL('    id integer,\n    code character varying(8),\n    PRIMARY KEY (id)'), 'D23').length, 0);
});

test('money-like names in binary floats are red', () => {
  const f = byId(DDL('    id integer,\n    total_amount double precision,\n    PRIMARY KEY (id)'), 'D5');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'red');
});

test('date-like data in text is red', () => {
  const f = byId(DDL('    id integer,\n    delivery_date text,\n    PRIMARY KEY (id)'), 'D3');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'red');
});

// ── keys, FKs, indexes ──────────────────────────────────────────────────────

test('no PRIMARY KEY is red, with the PG consequence', () => {
  const f = byId(DDL('    id integer NOT NULL'), 'D7');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'red');
  assert.match(f[0].detail, /REPLICA IDENTITY/);
  assert.equal(byId(DDL('    id integer,\n    CONSTRAINT t_pkey PRIMARY KEY (id)'), 'D7').length, 0);
  assert.equal(byId(DDL('    id integer PRIMARY KEY'), 'D7').length, 0);
});

test('an unindexed FK column is orange — PG creates no child-side index', () => {
  const f = byId(DDL(`    id integer NOT NULL,
    order_id bigint NOT NULL,
    CONSTRAINT t_pkey PRIMARY KEY (id),
    CONSTRAINT t_order_fk FOREIGN KEY (order_id) REFERENCES shop.orders (id)`), 'D15');
  assert.equal(f.length, 1);
  assert.match(f[0].title, /order_id/);
});

test('a leading index on the FK column satisfies the rule', () => {
  const f = byId(DDL(`    id integer NOT NULL,
    order_id bigint NOT NULL,
    CONSTRAINT t_pkey PRIMARY KEY (id),
    CONSTRAINT t_order_fk FOREIGN KEY (order_id) REFERENCES shop.orders (id)`,
  'CREATE INDEX t_order_id_idx ON shop.t USING btree (order_id);\n'), 'D15');
  assert.equal(f.length, 0);
});

test('inline REFERENCES is treated as a FK too', () => {
  const f = byId(DDL('    id integer PRIMARY KEY,\n    order_id bigint REFERENCES shop.orders (id) NOT NULL'), 'D15');
  assert.equal(f.length, 1);
});

test('a redundant prefix index is named; a UNIQUE prefix is a constraint, not redundant', () => {
  const f = byId(DDL('    id integer PRIMARY KEY,\n    a text,\n    b text',
    'CREATE INDEX ix_a ON shop.t (a);\nCREATE INDEX ix_ab ON shop.t (a, b);\n'), 'D16');
  assert.equal(f.length, 1);
  assert.match(f[0].title, /ix_a/);
  // UNIQUE (a) ⊂ (a, b) is a constraint — left alone by this rule.
  const g = byId(DDL('    id integer PRIMARY KEY,\n    a text UNIQUE,\n    b text',
    'CREATE INDEX ix_ab ON shop.t (a, b);\n'), 'D16');
  assert.equal(g.length, 0);
});

test('pervasive NULL columns are flagged once the table is wide enough', () => {
  const wide = DDL('    id integer PRIMARY KEY,\n    a text,\n    b text,\n    c text,\n    d text,\n    e text');
  const f = byId(wide, 'D18');
  assert.equal(f.length, 1);
  const tight = DDL('    id integer PRIMARY KEY,\n    a text NOT NULL,\n    b text NOT NULL,\n    c text NOT NULL,\n    d text');
  assert.equal(byId(tight, 'D18').length, 0);
});
