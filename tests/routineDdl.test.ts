/**
 * Stored routines as structured data (src/utils/routineDdl.ts).
 *
 * The failure mode this guards is quiet corruption: a parameter list split on
 * a bare comma turns `DECIMAL(10,2)` into two broken parameters, and the
 * editor then *saves* that back over a working routine. Every splitter here is
 * therefore tested against types with commas, strings with commas, comments
 * with anything, and bodies containing the very delimiters used to quote them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitTopLevel, matchParen, skipQuoted, parseParam, renderParam, quoteIdent,
  parseMysqlRoutine, parsePgRoutine, parsePgTrigger, parseRoutine,
  buildRoutineDdl, buildPgTriggerDdl, dropRoutineDdl, dollarTag, routineSignature,
  parseMssqlRoutine, parseMssqlParam, renderMssqlParam, buildMssqlRoutineDdl,
} from '../src/utils/routineDdl.ts';
import type { RoutineDef } from '../src/utils/routineDdl.ts';

// ── the scanner ─────────────────────────────────────────────────────────────

test('quoted and commented regions are skipped whole', () => {
  const s = "a 'str' b";
  assert.equal(skipQuoted(s, 2), 7, 'single-quoted string');
  assert.equal(skipQuoted("x `id` y", 2), 6, 'backtick identifier');
  assert.equal(skipQuoted('x /* c */ y', 2), 9, 'block comment');
  assert.equal(skipQuoted('x -- c\ny', 2), 7, 'line comment');
  assert.equal(skipQuoted('$$b$$', 0), 5, 'dollar quoting');
  assert.equal(skipQuoted('$tag$b$tag$', 0), 11, 'tagged dollar quoting');
  assert.equal(skipQuoted('abc', 0), 0, 'plain text is not a region');
});

test('an escaped quote does not end the string', () => {
  assert.equal(skipQuoted("'it''s'", 0), 7, "'' escape");
  assert.equal(skipQuoted("'a\\'b'", 0), 6, 'backslash escape');
});

test('an unterminated region consumes to the end rather than looping', () => {
  assert.equal(skipQuoted("'never closed", 0), 13);
  assert.equal(skipQuoted('/* never closed', 0), 15);
});

// ── the splitter, which is the whole ballgame ───────────────────────────────

test('a comma inside a type is not a separator', () => {
  assert.deepEqual(
    splitTopLevel('IN id INT, OUT total DECIMAL(10,2)'),
    ['IN id INT', 'OUT total DECIMAL(10,2)'],
  );
});

test('a comma inside a string literal is not a separator', () => {
  assert.deepEqual(
    splitTopLevel("a SET('x,y','z'), b INT"),
    ["a SET('x,y','z')", 'b INT'],
  );
});

test('a comma inside a comment is not a separator', () => {
  assert.deepEqual(
    splitTopLevel('a INT /* one, two */, b INT'),
    ['a INT /* one, two */', 'b INT'],
  );
});

test('nested parentheses are tracked to full depth', () => {
  assert.deepEqual(
    splitTopLevel('a NUMERIC(10,2), b foo(bar(1,2),baz(3,4)), c INT'),
    ['a NUMERIC(10,2)', 'b foo(bar(1,2),baz(3,4))', 'c INT'],
  );
});

test('an empty or blank list yields no parameters', () => {
  // A routine with no parameters must not produce one empty parameter.
  assert.deepEqual(splitTopLevel(''), []);
  assert.deepEqual(splitTopLevel('   '), []);
  assert.deepEqual(splitTopLevel('a,,b'), ['a', 'b'], 'empty segments dropped');
});

test('matchParen finds the closing paren past nested and quoted ones', () => {
  const s = 'f(a(1,2), b) tail';
  assert.equal(matchParen(s, 1), 11);
  assert.equal(s.slice(2, 11), 'a(1,2), b');
  // A paren inside a string must not be counted.
  const q = "f('(' , x)";
  assert.equal(matchParen(q, 1), 9);
  assert.equal(matchParen('no paren here', 0), -1);
  assert.equal(matchParen('f(unclosed', 1), -1);
});

// ── parameters ──────────────────────────────────────────────────────────────

test('parameter modes are recognised, defaulting to IN', () => {
  assert.deepEqual(parseParam('IN id INT'), { mode: 'IN', name: 'id', type: 'INT', defaultValue: undefined });
  assert.equal(parseParam('OUT total DECIMAL(10,2)')?.mode, 'OUT');
  assert.equal(parseParam('INOUT acc INT')?.mode, 'INOUT');
  assert.equal(parseParam('VARIADIC vals int[]')?.mode, 'VARIADIC');
  assert.equal(parseParam('id INT')?.mode, 'IN', 'no mode means IN');
});

test('INOUT is matched before IN', () => {
  // "IN" is a prefix of "INOUT"; checking IN first would leave "OUT acc INT".
  const p = parseParam('INOUT acc INT');
  assert.equal(p?.mode, 'INOUT');
  assert.equal(p?.name, 'acc');
  assert.equal(p?.type, 'INT');
});

test('a type containing a comma survives parameter parsing', () => {
  const p = parseParam('OUT total DECIMAL(10,2)');
  assert.equal(p?.name, 'total');
  assert.equal(p?.type, 'DECIMAL(10,2)');
});

test('quoted parameter names are unquoted, and defaults are kept verbatim', () => {
  assert.equal(parseParam('IN `order` INT')?.name, 'order');
  assert.equal(parseParam('"myParam" text')?.name, 'myParam');
  const d = parseParam("p_name text DEFAULT 'x'");
  assert.equal(d?.name, 'p_name');
  assert.equal(d?.type, 'text');
  assert.equal(d?.defaultValue, "'x'");
  assert.equal(parseParam('n int = 5')?.defaultValue, '5');
});

test('an unnamed parameter keeps its type and is not invented a name', () => {
  const p = parseParam('integer');
  assert.equal(p?.name, '');
  assert.equal(p?.type, 'integer');
});

test('parameters round-trip through render', () => {
  for (const src of ['IN id INT', 'OUT total DECIMAL(10,2)', 'INOUT acc BIGINT']) {
    const p = parseParam(src)!;
    assert.equal(renderParam(p, 'mysql'), src);
  }
});

test('mysql FUNCTION parameters never carry a mode', () => {
  // CREATE FUNCTION f(IN x INT) is ERROR 1064 — verified live on 8.4. The
  // mode is a procedure-only concept on MySQL; omitting kind keeps the old
  // procedure behavior, so the function case must be the explicit exception.
  const p = parseParam('IN id INT')!;
  assert.equal(renderParam(p, 'mysql', 'function'), 'id INT');
  assert.equal(renderParam(p, 'mysql', 'procedure'), 'IN id INT');
  assert.equal(renderParam(p, 'mysql'), 'IN id INT');
  // PostgreSQL functions legitimately take modes — untouched.
  assert.equal(renderParam(parseParam('OUT total INT')!, 'postgres', 'function'), 'OUT total INT');
});

test('identifiers are quoted only when they need it', () => {
  assert.equal(quoteIdent('orders', 'mysql'), 'orders');
  // Reserved, so it must be quoted even though its shape is bare-legal. This
  // assertion used to expect the bare form: the copy of the quoter that lived
  // in this module tested only the shape, so a routine with an `order`
  // parameter rendered `CREATE PROCEDURE p(order INT)` — a syntax error,
  // verified against MySQL 8.0.46. It now delegates to utils/sqlIdent.
  assert.equal(quoteIdent('order', 'mysql'), '`order`');
  assert.equal(quoteIdent('myTable', 'postgres'), '"myTable"');
  assert.equal(quoteIdent('with space', 'mysql'), '`with space`');
  assert.equal(quoteIdent('a`b', 'mysql'), '`a``b`', 'embedded backtick doubled');
  assert.equal(quoteIdent('a"b', 'postgres'), '"a""b"', 'embedded quote doubled');
});

// ── MySQL ───────────────────────────────────────────────────────────────────

const MYSQL_PROC = `CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`shop\`.\`recalc\`(IN cust_id INT, OUT total DECIMAL(10,2))
    MODIFIES SQL DATA
    SQL SECURITY INVOKER
BEGIN
  DECLARE t DECIMAL(10,2) DEFAULT 0;
  SELECT SUM(amount) INTO t FROM orders WHERE customer_id = cust_id;
  SET total = t;
END`;

test('a MySQL procedure is taken apart correctly', () => {
  const d = parseMysqlRoutine(MYSQL_PROC, 'procedure');
  assert.equal(d.schema, 'shop');
  assert.equal(d.name, 'recalc');
  assert.equal(d.params.length, 2);
  assert.deepEqual(d.params.map(p => [p.mode, p.name, p.type]),
    [['IN', 'cust_id', 'INT'], ['OUT', 'total', 'DECIMAL(10,2)']]);
  assert.equal(d.returns, null);
  assert.ok(d.characteristics.includes('MODIFIES SQL DATA'));
  assert.ok(d.characteristics.includes('SQL SECURITY INVOKER'));
  assert.match(d.body, /^BEGIN/);
  assert.match(d.body, /END$/);
});

test('the DEFINER clause is dropped rather than replayed', () => {
  // Re-issuing DEFINER needs SUPER on most servers; saving as the current user
  // is what an editor should do, and fails loudly rather than silently.
  const d = parseMysqlRoutine(MYSQL_PROC, 'procedure');
  const ddl = buildRoutineDdl('mysql', d);
  assert.ok(!/DEFINER/i.test(ddl), 'DEFINER leaked into the rebuilt DDL');
});

test('the body offset points at the body in the original text', () => {
  const d = parseMysqlRoutine(MYSQL_PROC, 'procedure');
  assert.equal(MYSQL_PROC.slice(d.bodyOffset).trim(), d.body);
});

const MYSQL_FUNC = `CREATE DEFINER=\`root\`@\`%\` FUNCTION \`tax\`(amount DECIMAL(10,2), rate DECIMAL(5,4)) RETURNS DECIMAL(10,2)
    DETERMINISTIC
    READS SQL DATA
RETURN amount * rate`;

test('a MySQL function keeps its return type separate from its characteristics', () => {
  const d = parseMysqlRoutine(MYSQL_FUNC, 'function');
  assert.equal(d.name, 'tax');
  assert.equal(d.returns, 'DECIMAL(10,2)');
  assert.ok(d.characteristics.includes('DETERMINISTIC'));
  assert.ok(d.characteristics.includes('READS SQL DATA'));
  assert.match(d.body, /^RETURN amount \* rate$/);
  assert.equal(d.params.length, 2);
});

test('a MySQL trigger records its timing, event and table', () => {
  const src = 'CREATE DEFINER=`root`@`localhost` TRIGGER `audit_ins` AFTER INSERT ON `orders` FOR EACH ROW\n'
    + 'INSERT INTO audit(t) VALUES (NOW())';
  const d = parseMysqlRoutine(src, 'trigger');
  assert.equal(d.name, 'audit_ins');
  assert.deepEqual(d.trigger, { timing: 'AFTER', event: 'INSERT', table: 'orders' });
  assert.match(d.body, /^INSERT INTO audit/);
});

test('a MySQL event records its schedule and enabled state', () => {
  const src = 'CREATE DEFINER=`root`@`localhost` EVENT `nightly` ON SCHEDULE EVERY 1 DAY '
    + 'ON COMPLETION NOT PRESERVE ENABLE DO CALL recalc(1)';
  const d = parseMysqlRoutine(src, 'event');
  assert.equal(d.name, 'nightly');
  assert.equal(d.event?.schedule, 'EVERY 1 DAY');
  assert.equal(d.event?.enabled, 'ENABLE');
  assert.match(d.body, /^CALL recalc\(1\)$/);
});

test('a MySQL routine with no parameters parses to an empty list', () => {
  const d = parseMysqlRoutine('CREATE PROCEDURE `noop`()\nBEGIN\nEND', 'procedure');
  assert.deepEqual(d.params, []);
  assert.equal(d.name, 'noop');
});

// ── PostgreSQL ──────────────────────────────────────────────────────────────

const PG_FUNC = `CREATE OR REPLACE FUNCTION public.recalc(cust_id integer, OUT total numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  SELECT sum(amount) INTO total FROM orders WHERE customer_id = cust_id;
  RETURN total;
END;
$function$`;

test('a PostgreSQL function is taken apart correctly', () => {
  const d = parsePgRoutine(PG_FUNC, 'function');
  assert.equal(d.schema, 'public');
  assert.equal(d.name, 'recalc');
  assert.equal(d.language, 'plpgsql');
  assert.equal(d.returns, 'numeric');
  assert.deepEqual(d.params.map(p => [p.mode, p.name, p.type]),
    [['IN', 'cust_id', 'integer'], ['OUT', 'total', 'numeric']]);
  assert.ok(d.characteristics.includes('STABLE'));
  assert.ok(d.characteristics.some(c => /SECURITY DEFINER/i.test(c)));
  assert.match(d.body, /^BEGIN/);
  assert.match(d.body, /END;$/);
  assert.ok(!d.body.includes('$function$'), 'the dollar tag leaked into the body');
});

test('characteristics are read from the header, never from the body', () => {
  // A plpgsql body legitimately contains words like STABLE or STRICT.
  const src = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'this is STABLE and SECURITY DEFINER text';
END;
$$`;
  const d = parsePgRoutine(src, 'function');
  assert.deepEqual(d.characteristics, [], 'body text was mistaken for a characteristic');
});

test('the older AS \'body\' quoting form is handled', () => {
  const src = "CREATE FUNCTION add1(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n + 1'";
  const d = parsePgRoutine(src, 'function');
  assert.equal(d.body, 'SELECT n + 1');
  assert.equal(d.language, 'sql');
});

test('parseRoutine dispatches on the engine', () => {
  assert.equal(parseRoutine('postgres', PG_FUNC, 'function').language, 'plpgsql');
  assert.equal(parseRoutine('mysql', MYSQL_PROC, 'procedure').name, 'recalc');
});

// ── rendering ───────────────────────────────────────────────────────────────

test('a PostgreSQL function round-trips through parse and rebuild', () => {
  const d = parsePgRoutine(PG_FUNC, 'function');
  const rebuilt = buildRoutineDdl('postgres', d, { orReplace: true });
  const again = parsePgRoutine(rebuilt, 'function');
  assert.equal(again.name, d.name);
  assert.equal(again.returns, d.returns);
  assert.equal(again.language, d.language);
  assert.equal(again.body.trim(), d.body.trim());
  assert.deepEqual(again.params, d.params);
});

test('a MySQL procedure round-trips through parse and rebuild', () => {
  const d = parseMysqlRoutine(MYSQL_PROC, 'procedure');
  const again = parseMysqlRoutine(buildRoutineDdl('mysql', d), 'procedure');
  assert.equal(again.name, d.name);
  assert.deepEqual(again.params, d.params);
  assert.equal(again.body.trim(), d.body.trim());
  assert.deepEqual(again.characteristics, d.characteristics);
});

test('a body containing $$ gets a tag that cannot terminate it early', () => {
  // plpgsql that builds dynamic SQL routinely dollar-quotes internally.
  const body = "BEGIN\n  EXECUTE $$SELECT 1$$;\nEND;";
  const tag = dollarTag(body);
  assert.notEqual(tag, '$$');
  assert.ok(!body.includes(tag), 'the chosen tag occurs in the body');

  const ddl = buildRoutineDdl('postgres',
    { kind: 'function', schema: null, name: 'f', params: [], returns: 'void',
      language: 'plpgsql', body, characteristics: [], bodyOffset: 0 },
    { orReplace: true });
  // The rebuilt body must survive a re-parse intact.
  assert.equal(parsePgRoutine(ddl, 'function').body.trim(), body);
});

test('dollarTag escalates until it finds a free tag', () => {
  assert.equal(dollarTag('plain body'), '$$');
  assert.equal(dollarTag('has $$ inside'), '$body$');
  assert.equal(dollarTag('has $$ and $body$'), '$func$');
});

test('CREATE OR REPLACE is only emitted where the engine supports it', () => {
  const d = parseMysqlRoutine(MYSQL_PROC, 'procedure');
  assert.ok(!/OR REPLACE/i.test(buildRoutineDdl('mysql', d, { orReplace: true })),
    'MySQL has no CREATE OR REPLACE for routines');
  const p = parsePgRoutine(PG_FUNC, 'function');
  assert.match(buildRoutineDdl('postgres', p, { orReplace: true }), /CREATE OR REPLACE FUNCTION/i);
});

test('a PostgreSQL drop carries the argument types, a MySQL one does not', () => {
  // PG identifies an overload by signature; MySQL cannot overload at all.
  const p = parsePgRoutine(PG_FUNC, 'function');
  const pgDrop = dropRoutineDdl('postgres', p);
  assert.match(pgDrop, /DROP FUNCTION IF EXISTS public\.recalc\(integer\)/);
  assert.ok(!/numeric/.test(pgDrop), 'OUT parameters are not part of the signature');

  const m = parseMysqlRoutine(MYSQL_PROC, 'procedure');
  assert.match(dropRoutineDdl('mysql', m), /DROP PROCEDURE IF EXISTS shop\.recalc$/);
});

// ── PostgreSQL triggers ─────────────────────────────────────────────────────

const pgTrigger = (over: Partial<NonNullable<RoutineDef['trigger']>> = {}): RoutineDef => ({
  kind: 'trigger', schema: 'public', name: 'trg_touch', params: [], returns: null,
  language: null, body: '', characteristics: [], bodyOffset: 0,
  trigger: {
    timing: 'BEFORE', event: 'INSERT', table: 'orders',
    events: ['INSERT', 'UPDATE'], level: 'ROW', when: '',
    function: 'touch_row', functionArgs: '', ...over,
  },
});

test('a PostgreSQL trigger executes a function rather than holding a body', () => {
  const sql = buildPgTriggerDdl(pgTrigger());
  assert.match(sql, /^CREATE TRIGGER trg_touch$/m);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\.orders/);
  assert.match(sql, /FOR EACH ROW/);
  assert.match(sql, /EXECUTE FUNCTION touch_row\(\)/);
  assert.ok(!/BEGIN/.test(sql), 'a PG trigger has no inline body');
});

test('timing, level, WHEN and function args all render', () => {
  const sql = buildPgTriggerDdl(pgTrigger({
    timing: 'AFTER', events: ['UPDATE', 'DELETE'], level: 'STATEMENT',
    when: 'OLD.status IS DISTINCT FROM NEW.status',
    function: 'audit.log_change', functionArgs: "'orders', 'v2'",
  }));
  assert.match(sql, /AFTER UPDATE OR DELETE ON public\.orders/);
  assert.match(sql, /FOR EACH STATEMENT/);
  assert.match(sql, /WHEN \(OLD\.status IS DISTINCT FROM NEW\.status\)/);
  assert.match(sql, /EXECUTE FUNCTION audit\.log_change\('orders', 'v2'\)/);
});

test('a reserved-word trigger or table name is quoted', () => {
  const sql = buildPgTriggerDdl(pgTrigger({ table: 'order' }));
  assert.match(sql, /ON public\."order"/, 'the reserved table name is quoted');
});

test('buildRoutineDdl routes a PG trigger to the trigger builder, not the function one', () => {
  const sql = buildRoutineDdl('postgres', pgTrigger());
  assert.match(sql, /CREATE TRIGGER trg_touch/);
  assert.ok(!/CREATE (?:OR REPLACE )?FUNCTION/i.test(sql));
});

test('a PostgreSQL trigger drop names its table', () => {
  const sql = dropRoutineDdl('postgres', pgTrigger());
  assert.match(sql, /^DROP TRIGGER IF EXISTS trg_touch ON public\.orders$/);
});

test('pg_get_triggerdef round-trips through parse and rebuild', () => {
  const def = 'CREATE TRIGGER trg_touch BEFORE INSERT OR UPDATE ON public.orders '
    + 'FOR EACH ROW WHEN ((new.status IS NOT NULL)) EXECUTE FUNCTION touch_row()';
  const d = parsePgTrigger(def);
  assert.equal(d.name, 'trg_touch');
  assert.equal(d.trigger?.timing, 'BEFORE');
  assert.deepEqual(d.trigger?.events, ['INSERT', 'UPDATE']);
  assert.equal(d.trigger?.table, 'orders');
  assert.equal(d.schema, 'public');
  assert.equal(d.trigger?.level, 'ROW');
  assert.equal(d.trigger?.when, '(new.status IS NOT NULL)');
  assert.equal(d.trigger?.function, 'touch_row');
  // parseRoutine must dispatch a PG trigger here, not to the pg_proc parser.
  assert.equal(parseRoutine('postgres', def, 'trigger').name, 'trg_touch');
});

test('INSTEAD OF and FOR EACH STATEMENT parse back out', () => {
  const def = 'CREATE TRIGGER v_ins INSTEAD OF INSERT ON public.a_view '
    + 'FOR EACH STATEMENT EXECUTE FUNCTION handle()';
  const d = parsePgTrigger(def);
  assert.equal(d.trigger?.timing, 'INSTEAD OF');
  assert.equal(d.trigger?.level, 'STATEMENT');
});

test('signatures read like a developer would write them', () => {
  assert.equal(
    routineSignature(parseMysqlRoutine(MYSQL_PROC, 'procedure')),
    'recalc(cust_id INT, OUT total DECIMAL(10,2))',
  );
  assert.match(routineSignature(parseMysqlRoutine(MYSQL_FUNC, 'function')), /→ DECIMAL\(10,2\)$/);
  const trig = parseMysqlRoutine(
    'CREATE TRIGGER `t` BEFORE UPDATE ON `orders` FOR EACH ROW SET NEW.x = 1', 'trigger');
  assert.equal(routineSignature(trig), 't — BEFORE UPDATE ON orders');
});

// ── SQL Server ───────────────────────────────────────────────────────────────
//
// Every DDL string below is the VERBATIM `sys.sql_modules.definition` of an
// object in dev/mssql_fixture.sql, copied from a live SQL Server 2022 — banner
// comments, alignment and all. Each rebuilt definition was executed against
// that server and the routines still ran afterwards.

const MS_PROC = `
-- ── Stored procedure, with parameters ────────────────────
CREATE PROCEDURE sales.usp_close_orders
    @older_than_days int = 90,
    @closed          int OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE sales.orders
       SET status = 'cancelled'
     WHERE status = 'new'
       AND placed_at < DATEADD(day, -@older_than_days, SYSDATETIMEOFFSET());
    SET @closed = @@ROWCOUNT;
END;`;

const MS_FN = `
CREATE FUNCTION sales.fn_order_total_with_vat(@order_id bigint)
RETURNS decimal(12,2)
AS
BEGIN
    DECLARE @t decimal(12,2);
    SELECT @t = total * 1.21 FROM sales.orders WHERE id = @order_id;
    RETURN @t;
END;`;

const MS_TVF = `
CREATE FUNCTION sales.tvf_orders_for_customer(@customer_id int)
RETURNS TABLE
AS
RETURN (SELECT id, status, total, placed_at FROM sales.orders WHERE customer_id = @customer_id);`;

const MS_TRIGGER = `
-- ── Trigger ────────────────────────────────
CREATE TRIGGER sales.trg_orders_audit
ON sales.orders
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO sales.audit_raw (payload)
    SELECT CONCAT('order ', CAST(id AS varchar(20)), ' inserted') FROM inserted;
END;`;

test('a definition that opens with a banner comment still parses', () => {
  // sys.sql_modules returns the author's ORIGINAL text, not a reconstruction,
  // so anchoring on ^CREATE misses every routine in a commented codebase.
  const def = parseMssqlRoutine(MS_PROC, 'procedure');
  assert.equal(def.schema, 'sales');
  assert.equal(def.name, 'usp_close_orders');
});

test('a T-SQL procedure parameter list needs no parentheses', () => {
  const def = parseMssqlRoutine(MS_PROC, 'procedure');
  assert.equal(def.params.length, 2);
  assert.deepEqual(def.params[0],
    { mode: 'IN', name: '@older_than_days', type: 'int', defaultValue: '90' });
  assert.deepEqual(def.params[1],
    { mode: 'OUT', name: '@closed', type: 'int', defaultValue: undefined });
});

test('the @ stays in the parameter name — EXEC needs it', () => {
  const def = parseMssqlRoutine(MS_PROC, 'procedure');
  assert.ok(def.params.every(p => p.name.startsWith('@')));
});

test('OUTPUT trails the type in T-SQL, and is read as a mode not a type', () => {
  assert.deepEqual(parseMssqlParam('@total decimal(10,2) OUTPUT'),
    { mode: 'OUT', name: '@total', type: 'decimal(10,2)', defaultValue: undefined });
  // OUT is the accepted abbreviation.
  assert.equal(parseMssqlParam('@t int OUT')!.mode, 'OUT');
  // A table-valued parameter is READONLY and is still an input.
  assert.deepEqual(parseMssqlParam('@rows dbo.id_list READONLY'),
    { mode: 'IN', name: '@rows', type: 'dbo.id_list', defaultValue: undefined });
});

test('a comma inside a type is not a parameter separator', () => {
  const def = parseMssqlRoutine(
    'CREATE PROCEDURE p @a decimal(10,2), @b numeric(18, 4) = 1.5 AS SELECT 1', 'procedure');
  assert.equal(def.params.length, 2);
  assert.equal(def.params[0].type, 'decimal(10,2)');
  assert.equal(def.params[1].type, 'numeric(18, 4)');
  assert.equal(def.params[1].defaultValue, '1.5');
});

test('the body split is the top-level AS, not the first AS in the text', () => {
  // `CAST(x AS int)` inside a default, and `AS` inside the body, must not win.
  const def = parseMssqlRoutine(
    "CREATE PROCEDURE p @a varchar(10) = 'CAST(1 AS int)' AS SELECT CAST(1 AS int) AS n",
    'procedure');
  assert.equal(def.params.length, 1);
  assert.equal(def.body, 'SELECT CAST(1 AS int) AS n');
});

test('a scalar function keeps its return type verbatim', () => {
  const def = parseMssqlRoutine(MS_FN, 'function');
  assert.equal(def.returns, 'decimal(12,2)');
  assert.equal(def.params[0].name, '@order_id');
  assert.match(def.body, /^BEGIN/);
  assert.match(def.body, /RETURN @t;/);
});

test('a table-valued function returns TABLE, and its body is the RETURN', () => {
  const def = parseMssqlRoutine(MS_TVF, 'function');
  assert.equal(def.returns, 'TABLE');
  assert.match(def.body, /^RETURN \(SELECT id/);
});

test('a T-SQL trigger names its table before its timing, and holds a body', () => {
  const def = parseMssqlRoutine(MS_TRIGGER, 'trigger');
  assert.equal(def.name, 'trg_orders_audit');
  assert.deepEqual(def.trigger,
    { timing: 'AFTER', event: 'INSERT', table: 'orders', events: ['INSERT'] });
  assert.match(def.body, /INSERT INTO sales\.audit_raw/);
});

test('FOR is normalised to AFTER, and several events share one trigger', () => {
  const def = parseMssqlRoutine(
    'CREATE TRIGGER t ON dbo.x FOR INSERT, UPDATE AS SELECT 1', 'trigger');
  assert.equal(def.trigger!.timing, 'AFTER');
  assert.deepEqual(def.trigger!.events, ['INSERT', 'UPDATE']);
});

test('INSTEAD OF survives the round trip', () => {
  const def = parseMssqlRoutine(
    'CREATE TRIGGER t ON dbo.v INSTEAD OF DELETE AS SELECT 1', 'trigger');
  assert.equal(def.trigger!.timing, 'INSTEAD OF');
  assert.match(buildMssqlRoutineDdl(def, true), /INSTEAD OF DELETE/);
});

test('CREATE OR ALTER is emitted — SQL Server never needs a drop first', () => {
  const def = parseMssqlRoutine(MS_PROC, 'procedure');
  const ddl = buildMssqlRoutineDdl(def, true);
  // Identifiers are bracketed only when they need it — the same rule every
  // other engine follows here, and what the live server was given.
  assert.match(ddl, /\nCREATE OR ALTER PROCEDURE sales\.usp_close_orders/);
  assert.match(ddl, /@older_than_days int = 90/);
  assert.match(ddl, /@closed int OUTPUT/);
  assert.match(ddl, /\nAS\nBEGIN/);
});

test('a re-parse of the rebuilt DDL gives back the same definition', () => {
  for (const [src, kind] of [
    [MS_PROC, 'procedure'], [MS_FN, 'function'],
    [MS_TVF, 'function'], [MS_TRIGGER, 'trigger'],
  ] as const) {
    const a = parseMssqlRoutine(src, kind);
    const b = parseMssqlRoutine(buildMssqlRoutineDdl(a, true), kind);
    assert.deepEqual(
      { ...b, bodyOffset: 0 }, { ...a, bodyOffset: 0 },
      `${a.name} did not survive a rebuild`);
  }
});

test('a parameter typed without an @ gets one, or CREATE is a syntax error', () => {
  assert.equal(renderMssqlParam({ mode: 'IN', name: 'n', type: 'int' }), '@n int');
  assert.equal(renderMssqlParam({ mode: 'OUT', name: '@n', type: 'int' }), '@n int OUTPUT');
  assert.equal(
    renderMssqlParam({ mode: 'IN', name: '@n', type: 'int', defaultValue: '7' }),
    '@n int = 7');
});

test('parseRoutine dispatches SQL Server to the T-SQL parser', () => {
  const def = parseRoutine('sqlserver', MS_PROC, 'procedure');
  assert.equal(def.params[1].mode, 'OUT');
});

test('renderParam and buildRoutineDdl both route SQL Server to T-SQL', () => {
  assert.equal(renderParam({ mode: 'OUT', name: '@t', type: 'int' }, 'sqlserver'),
    '@t int OUTPUT');
  const def = parseMssqlRoutine(MS_FN, 'function');
  assert.match(buildRoutineDdl('sqlserver', def, { orReplace: true }),
    /^CREATE OR ALTER FUNCTION sales\.fn_order_total_with_vat\(@order_id bigint\)/);
});

test('the drop needs no signature and no table — SQL Server has neither problem', () => {
  // No overloading, so a bare name is unambiguous; a trigger name is unique
  // per schema, so unlike PostgreSQL the table is not needed.
  const fn = parseMssqlRoutine(MS_FN, 'function');
  assert.equal(dropRoutineDdl('sqlserver', fn),
    'DROP FUNCTION IF EXISTS sales.fn_order_total_with_vat');
  const tr = parseMssqlRoutine(MS_TRIGGER, 'trigger');
  assert.equal(dropRoutineDdl('sqlserver', tr),
    'DROP TRIGGER IF EXISTS sales.trg_orders_audit');
});

test('a name that needs brackets gets them, in the DDL and in the drop', () => {
  const def = parseMssqlRoutine(MS_FN, 'function');
  const odd = { ...def, schema: 'my schema', name: 'fn]weird' };
  const ddl = buildMssqlRoutineDdl(odd, true);
  // The closing bracket inside a name doubles, or it terminates the quote.
  assert.match(ddl, /\[my schema\]\.\[fn\]\]weird\]/);
  assert.match(dropRoutineDdl('sqlserver', odd), /\[my schema\]\.\[fn\]\]weird\]/);
});

test('a banner comment above CREATE survives a save — SQL Server keeps it', () => {
  // sys.sql_modules is the author's text, so the comment IS the user's data.
  // MySQL and PostgreSQL never see this because their servers re-render and
  // the comment is already gone; that is a reason to preserve it here, not to
  // match them by discarding it.
  const def = parseMssqlRoutine(MS_PROC, 'procedure');
  assert.match(def.preamble!, /Stored procedure, with parameters/);
  const ddl = buildMssqlRoutineDdl(def, true);
  assert.match(ddl, /^\n?-- ── Stored procedure/);
  assert.match(ddl, /\nCREATE OR ALTER PROCEDURE sales\.usp_close_orders/);
  // And a trigger's, which takes the other parse path.
  const tr = parseMssqlRoutine(MS_TRIGGER, 'trigger');
  assert.match(buildMssqlRoutineDdl(tr, true), /-- ── Trigger[\s\S]*CREATE OR ALTER TRIGGER/);
});

test('a routine with no preamble gains no leading blank line', () => {
  const def = parseMssqlRoutine('CREATE PROCEDURE p AS SELECT 1', 'procedure');
  assert.match(buildMssqlRoutineDdl(def, true), /^CREATE OR ALTER PROCEDURE p/);
});

test('round-tripping repeatedly does not grow the preamble', () => {
  let ddl = MS_PROC;
  for (let i = 0; i < 3; i++) {
    ddl = buildMssqlRoutineDdl(parseMssqlRoutine(ddl, 'procedure'), true);
  }
  const twice = buildMssqlRoutineDdl(parseMssqlRoutine(ddl, 'procedure'), true);
  assert.equal(twice, ddl, 'the rebuild is not idempotent');
});
