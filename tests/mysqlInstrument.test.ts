/**
 * MySQL routine instrumentation (src/utils/mysqlInstrument.ts).
 *
 * The output of this module is SQL that gets executed, so a bug here is not a
 * wrong pixel — it is a copy that will not compile, or worse, one that
 * compiles and traces the wrong thing. These tests pin the splitting, scoping
 * and rewriting rules the generated SQL depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMysqlStatements, instrumentMysqlRoutine, parseMysqlTrace,
  DEFAULT_MAX_STEPS, LINE_ENTRY, LINE_ERROR, LINE_OUT, LINE_TRUNCATED,
} from '../src/utils/mysqlInstrument.ts';
import type { RoutineDef } from '../src/utils/routineDdl.ts';

const proc = (body: string, params: RoutineDef['params'] = []): RoutineDef => ({
  kind: 'procedure', schema: 'app', name: 'calc', params,
  returns: null, language: 'SQL', body, characteristics: [], bodyOffset: 0,
});

const fn = (body: string, params: RoutineDef['params'] = []): RoutineDef => ({
  ...proc(body, params), kind: 'function', returns: 'INT',
});

const OPTS = { scratchSchema: 'txui_debug', runId: 'run-42' };

// ── statement splitting ─────────────────────────────────────────────────────

test('simple statements split with their original end lines', () => {
  const stmts = findMysqlStatements('BEGIN\n  SET a = 1;\n  SET b = 2;\nEND');
  assert.equal(stmts.length, 2);
  // The first chunk carries the BEGIN with it — that is fine, the injection
  // point is what matters.
  assert.match(stmts[0].text, /SET a = 1;/);
  assert.equal(stmts[0].line, 2);
  assert.equal(stmts[1].line, 3);
});

test('a semicolon inside a string is not a statement boundary', () => {
  const stmts = findMysqlStatements("BEGIN SET x = 'a;b'; SET y = 2; END");
  assert.equal(stmts.length, 2);
});

test('semicolons inside comments are not boundaries', () => {
  assert.equal(findMysqlStatements('BEGIN SET x = 1; -- a; b\nSET y = 2; END').length, 2);
  assert.equal(findMysqlStatements('BEGIN SET x = 1; /* a; b */ SET y = 2; END').length, 2);
  assert.equal(findMysqlStatements('BEGIN SET x = 1; # a; b\nSET y = 2; END').length, 2);
});

test('DECIMAL(10,2) declares without the comma or parens confusing the split', () => {
  const stmts = findMysqlStatements('BEGIN\nDECLARE d DECIMAL(10,2);\nSET d = 1.5;\nEND');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].kind, 'declare');
  assert.deepEqual(stmts[0].vars, ['d']);
});

test('line numbers survive newlines inside strings', () => {
  const stmts = findMysqlStatements("BEGIN\n  SET x = 'one\ntwo';\n  SET y = 2;\nEND");
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].line, 3, 'the statement ends on the third line');
  assert.equal(stmts[1].line, 4);
});

test('IF / ELSEIF / ELSE branches each yield their inner statements', () => {
  const stmts = findMysqlStatements(
    'BEGIN IF a THEN SET x = 1; ELSEIF b THEN SET x = 2; ELSE SET x = 3; END IF; SET y = 1; END');
  const texts = stmts.map(s => s.text.replace(/\s+/g, ' '));
  assert.ok(texts.some(t => t.includes('IF a THEN SET x = 1;')), texts.join(' | '));
  assert.ok(texts.some(t => t.startsWith('ELSEIF b THEN SET x = 2;')));
  assert.ok(texts.some(t => t.startsWith('ELSE SET x = 3;')));
  assert.ok(texts.some(t => t.startsWith('END IF;')));
  assert.ok(texts.some(t => t.startsWith('SET y = 1;')));
});

test('WHILE loops split and balance', () => {
  const stmts = findMysqlStatements(
    'BEGIN DECLARE i INT DEFAULT 0; WHILE i < 10 DO SET i = i + 1; END WHILE; END');
  const texts = stmts.map(s => s.text.replace(/\s+/g, ' '));
  assert.ok(texts.some(t => t.includes('WHILE i < 10 DO SET i = i + 1;')), texts.join(' | '));
  assert.ok(texts.some(t => t.startsWith('END WHILE;')));
});

test('REPEAT … UNTIL … END REPEAT splits and balances', () => {
  const stmts = findMysqlStatements(
    'BEGIN REPEAT SET i = i + 1; UNTIL i >= 10 END REPEAT; SET done = 1; END');
  const texts = stmts.map(s => s.text.replace(/\s+/g, ' '));
  assert.ok(texts.some(t => t.includes('REPEAT SET i = i + 1;')), texts.join(' | '));
  assert.ok(texts.some(t => t.startsWith('UNTIL i >= 10 END REPEAT;')));
  assert.ok(texts.some(t => t.startsWith('SET done = 1;')));
});

test('a labelled LOOP with LEAVE balances', () => {
  const stmts = findMysqlStatements(
    'BEGIN lbl: LOOP SET x = x + 1; IF x > 5 THEN LEAVE lbl; END IF; END LOOP lbl; SET y = 1; END');
  const texts = stmts.map(s => s.text.replace(/\s+/g, ' '));
  assert.ok(texts.some(t => t.includes('lbl: LOOP SET x = x + 1;')), texts.join(' | '));
  assert.ok(texts.some(t => t.startsWith('END LOOP lbl;')));
  assert.ok(texts.some(t => t.startsWith('SET y = 1;')));
});

test('a CASE statement splits its branches', () => {
  const stmts = findMysqlStatements(
    'BEGIN CASE x WHEN 1 THEN SET y = 1; WHEN 2 THEN SET y = 2; ELSE SET y = 3; END CASE; END');
  const texts = stmts.map(s => s.text.replace(/\s+/g, ' '));
  assert.ok(texts.some(t => t.startsWith('WHEN 2 THEN SET y = 2;')), texts.join(' | '));
  assert.ok(texts.some(t => t.startsWith('END CASE;')));
});

test('a CASE EXPRESSION does not pop a block at its END', () => {
  // `SET x = CASE … END;` — that END closes an expression, not a block. If the
  // walker pops wrongly here, the following statement inherits a broken scope.
  const stmts = findMysqlStatements(
    'BEGIN SET x = CASE WHEN y > 0 THEN 1 ELSE 2 END; SET z = 1; END');
  assert.equal(stmts.length, 2);
  assert.ok(stmts[1].text.startsWith('SET z'));
});

test('the IF() function is not an IF statement', () => {
  const stmts = findMysqlStatements('BEGIN SET x = IF(y > 0, 1, 2); SET z = 1; END');
  assert.equal(stmts.length, 2);
});

test('a nested IF inside a THEN branch still balances', () => {
  const stmts = findMysqlStatements(
    'BEGIN IF a THEN IF b THEN SET x = 1; END IF; END IF; SET y = 1; END');
  assert.ok(stmts.some(s => s.text.startsWith('SET y = 1;')),
    'the walk lost track of the nested END IF');
});

// ── variable scoping ────────────────────────────────────────────────────────

const SCOPED = `BEGIN
  DECLARE a INT;
  SET a = 1;
  BEGIN
    DECLARE b INT;
    SET b = 2;
  END;
  SET a = 3;
END`;

test('an inner-block variable is in scope only inside its block', () => {
  const stmts = findMysqlStatements(SCOPED);
  const inner = stmts.find(s => /SET b = 2;/.test(s.text));
  const outer = stmts.find(s => /SET a = 3;/.test(s.text));
  assert.ok(inner && outer);
  assert.deepEqual(inner.vars, ['a', 'b']);
  assert.deepEqual(outer.vars, ['a'], 'b must not be traced after its block closed');
});

test('a block END reports only the outer scope again', () => {
  const stmts = findMysqlStatements(SCOPED);
  const end = stmts.find(s => /^END;$/.test(s.text.trim()));
  assert.ok(end);
  assert.deepEqual(end.vars, ['a']);
});

test('parameters are in scope from the start', () => {
  const stmts = findMysqlStatements('BEGIN SET y = 1; END', ['x']);
  assert.deepEqual(stmts[0].vars, ['x']);
});

test('a shadowing redeclaration is traced once', () => {
  const stmts = findMysqlStatements('BEGIN DECLARE x INT; BEGIN DECLARE x INT; SET x = 1; END; END');
  const inner = stmts.find(s => /SET x = 1;/.test(s.text));
  assert.deepEqual(inner?.vars, ['x']);
});

test('multi-name declarations register every name', () => {
  const stmts = findMysqlStatements('BEGIN DECLARE a, b INT DEFAULT 0; SET a = 1; END');
  assert.deepEqual(stmts[1].vars, ['a', 'b']);
});

test('backticked declaration names are unquoted for the scope', () => {
  const stmts = findMysqlStatements('BEGIN DECLARE `my var` INT; SET `my var` = 1; END');
  assert.deepEqual(stmts[0].vars, ['my var']);
});

test('cursors, conditions and handlers are not traceable variables', () => {
  const stmts = findMysqlStatements(`BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE cur CURSOR FOR SELECT 1;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  OPEN cur;
END`);
  const open = stmts.find(s => /OPEN cur/.test(s.text));
  assert.ok(open);
  assert.deepEqual(open.vars, ['done'], 'cursor/handler names would not compile as variables');
});

// ── RETURN handling ─────────────────────────────────────────────────────────

test('a RETURN statement is found with its expression', () => {
  const stmts = findMysqlStatements('BEGIN\n  RETURN x + 1;\nEND');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].kind, 'return');
  assert.equal(stmts[0].returnExpr, 'x + 1');
  assert.equal(stmts[0].line, 2);
});

test('a RETURN inside an IF branch is found mid-chunk', () => {
  const stmts = findMysqlStatements('BEGIN IF a THEN RETURN 1; ELSE RETURN 2; END IF; END');
  const returns = stmts.filter(s => s.kind === 'return');
  assert.equal(returns.length, 2);
  assert.equal(returns[0].returnExpr, '1');
  assert.equal(returns[1].returnExpr, '2');
});

test('a bare RETURN body (no BEGIN…END) parses as one statement', () => {
  const stmts = findMysqlStatements('RETURN x + 1');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].kind, 'return');
  assert.equal(stmts[0].hadSemi, false);
});

// ── the generated run ───────────────────────────────────────────────────────

const BODY = `BEGIN
  SET a = 1;
  SET b = a + 1;
END`;

test('the trace table has the established shape in the scratch schema', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.ok(!r.unsupported, r.unsupported);
  assert.match(r.parts.setup[0],
    /^CREATE TABLE IF NOT EXISTS txui_debug\.__txui_trace \(/);
  for (const col of ['run VARCHAR(64)', 'seq INT UNSIGNED', 'line INT', 'var VARCHAR(128)', 'val LONGTEXT NULL']) {
    assert.ok(r.parts.setup[0].includes(col), `missing column: ${col}`);
  }
});

test('the copy is created under the __txui_dbg_ prefix in the scratch schema', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.equal(r.copyName, '__txui_dbg_calc');
  assert.match(r.parts.create, /^CREATE PROCEDURE txui_debug\.__txui_dbg_calc\(/);
});

test('trace rows carry ORIGINAL line numbers, stamped at generation time', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  // No variables are in scope, so each step writes its sentinel row; the
  // stamped line must be the one in the original body (2 and 3), not the
  // line the injected INSERT happens to land on in the copy.
  assert.ok(r.parts.create.includes(`'run-42', @__txui_dbg_seq, 2, '__txui_step', NULL`),
    'first statement did not report line 2');
  assert.ok(r.parts.create.includes(`'run-42', @__txui_dbg_seq, 3, '__txui_step', NULL`),
    'second statement did not report line 3');
  assert.deepEqual(r.lines, [2, 3]);
});

test('every statement gets a trace step, plus the entry step', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  const steps = r.parts.create.match(/SET @__txui_dbg_seq = @__txui_dbg_seq \+ 1;/g) ?? [];
  assert.equal(steps.length, 3, `2 statements + entry, got ${steps.length}`);
});

test('the entry step records parameters and initial values at line 0', () => {
  const r = instrumentMysqlRoutine(
    proc('BEGIN\n  DECLARE n INT DEFAULT 5;\n  SET n = n + x;\nEND',
      [{ mode: 'IN', name: 'x', type: 'INT' }]),
    OPTS);
  assert.ok(r.parts.create.includes(`('run-42', @__txui_dbg_seq, ${LINE_ENTRY}, 'x', CAST(x AS CHAR))`),
    'parameter missing from the entry step');
  assert.ok(r.parts.create.includes(`('run-42', @__txui_dbg_seq, ${LINE_ENTRY}, 'n', CAST(n AS CHAR))`),
    'declared variable missing from the entry step');
  // And the declare section is traced only once — at its end.
  const betweenDeclares = r.parts.create.slice(
    r.parts.create.indexOf('DECLARE n INT'), r.parts.create.indexOf('SET n = n + x;'));
  assert.ok(betweenDeclares.includes('DECLARE EXIT HANDLER'),
    'our handler must follow the user declarations');
});

test('NULL variables stay visible as NULL rows, never skipped', () => {
  // One INSERT row per in-scope variable with CAST(var AS CHAR) — CAST keeps
  // NULL as NULL, and the row exists either way.
  const r = instrumentMysqlRoutine(
    proc('BEGIN\n  DECLARE a INT;\n  SET a = 1;\nEND'), OPTS);
  assert.ok(r.parts.create.includes(`'a', CAST(a AS CHAR)`));
  const stepInserts = r.parts.create.match(/INSERT INTO txui_debug\.__txui_trace \(run, seq, line, var, val\) VALUES/g) ?? [];
  assert.ok(stepInserts.length >= 3, 'entry + per-statement inserts');
});

test('an inner-block variable is never referenced by an outer trace', () => {
  const r = instrumentMysqlRoutine(proc(SCOPED), OPTS);
  assert.ok(!r.unsupported, r.unsupported);
  assert.ok(r.parts.create.includes('CAST(b AS CHAR)'), 'b is traced inside its block');
  // Everything injected after `SET a = 3;` is outer scope — naming b there is
  // a compile error in the copy.
  const tail = r.parts.create.slice(r.parts.create.lastIndexOf('SET a = 3;'));
  assert.ok(!tail.includes('CAST(b AS CHAR)'), 'the outer trace references b — the copy would not compile');
});

test('the error handler records SQLSTATE + message, then RESIGNALs', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.match(r.parts.create, /DECLARE EXIT HANDLER FOR SQLEXCEPTION/);
  assert.match(r.parts.create, /GET DIAGNOSTICS CONDITION 1/);
  assert.match(r.parts.create, /RETURNED_SQLSTATE/);
  assert.match(r.parts.create, /MESSAGE_TEXT/);
  assert.ok(r.parts.create.includes(`'${'__txui_error'}'`));
  assert.ok(r.parts.create.includes(`, ${LINE_ERROR}, '__txui_sqlstate'`));
  assert.match(r.parts.create, /RESIGNAL;/);
  // The handler sits after the user's declarations, before the first
  // executable statement — MySQL's required declare order.
  const withDeclares = instrumentMysqlRoutine(
    proc('BEGIN\n  DECLARE a INT;\n  SET a = 1;\nEND'), OPTS);
  const c = withDeclares.parts.create;
  assert.ok(c.indexOf('DECLARE a INT;') < c.indexOf('DECLARE EXIT HANDLER'));
  assert.ok(c.indexOf('DECLARE EXIT HANDLER') < c.indexOf('SET a = 1;'));
});

test('a user SQLEXCEPTION handler suppresses ours rather than duplicating', () => {
  const r = instrumentMysqlRoutine(proc(`BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION SET e = 1;
  SET a = 1;
END`), OPTS);
  assert.ok(!r.unsupported, r.unsupported);
  const handlers = r.parts.create.match(/DECLARE EXIT HANDLER FOR SQLEXCEPTION/g) ?? [];
  assert.equal(handlers.length, 1, 'two handlers for SQLEXCEPTION would not compile');
  assert.ok(r.notes.some(n => /HANDLER FOR SQLEXCEPTION/.test(n)));
});

test('the step cap guards every injected insert, with an honest truncation row', () => {
  const r = instrumentMysqlRoutine(proc(BODY), { ...OPTS, maxSteps: 7 });
  assert.match(r.parts.create, /IF @__txui_dbg_seq < 7 THEN/);
  assert.ok(!r.parts.create.includes('< 5000 THEN'), 'the custom cap was not used');
  const marker = r.parts.run.find(s => s.includes('__txui_truncated'));
  assert.ok(marker, 'no truncation marker in the run');
  assert.ok(marker.includes(`, ${LINE_TRUNCATED}, '__txui_truncated', '7'`));
  assert.match(marker, /WHERE @__txui_dbg_seq >= 7/);
  // The default is the PG module's cap.
  const d = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.match(d.parts.create, new RegExp(`IF @__txui_dbg_seq < ${DEFAULT_MAX_STEPS} THEN`));
});

test('IN / OUT / INOUT parameters are wired through the CALL', () => {
  const r = instrumentMysqlRoutine(proc('BEGIN\n  SET b = a + c;\nEND', [
    { mode: 'IN', name: 'a', type: 'INT' },
    { mode: 'OUT', name: 'b', type: 'INT' },
    { mode: 'INOUT', name: 'c', type: 'INT' },
  ]), { ...OPTS, values: [{ name: 'a', value: '5' }, { name: 'c', value: '9' }] });
  assert.ok(!r.unsupported, r.unsupported);
  // OUT/INOUT cross the CALL in session variables; IN goes in as the literal.
  assert.ok(r.parts.run.includes('SET @__txui_dbg_p_b = NULL'));
  assert.ok(r.parts.run.includes('SET @__txui_dbg_p_c = 9'));
  const call = r.parts.run.find(s => s.startsWith('CALL '));
  assert.equal(call, 'CALL txui_debug.__txui_dbg_calc(5, @__txui_dbg_p_b, @__txui_dbg_p_c)');
  // The signature keeps the modes, and the OUT values are captured after.
  assert.ok(r.parts.create.includes('IN a INT'));
  assert.ok(r.parts.create.includes('OUT b INT'));
  const outCapture = r.parts.run.find(s => s.includes(`, ${LINE_OUT},`));
  assert.ok(outCapture?.includes(`'b', CAST(@__txui_dbg_p_b AS CHAR)`));
  assert.ok(outCapture?.includes(`'c', CAST(@__txui_dbg_p_c AS CHAR)`));
});

test('a function runs via SELECT and its RETURN is traced before it executes', () => {
  const r = instrumentMysqlRoutine(fn('BEGIN\n  RETURN x + 1;\nEND',
    [{ mode: 'IN', name: 'x', type: 'INT' }]),
    { ...OPTS, values: [{ name: 'x', value: '41' }] });
  assert.ok(!r.unsupported, r.unsupported);
  assert.match(r.parts.create, /^CREATE FUNCTION/);
  const call = r.parts.run.find(s => s.includes('__txui_dbg_calc('));
  assert.equal(call, 'SELECT txui_debug.__txui_dbg_calc(41) AS `__txui_dbg_ret`');
  // The trace (with the returned value) must come BEFORE the RETURN —
  // anything after it never runs.
  const traceAt = r.parts.create.indexOf("'__txui_return', CAST((x + 1) AS CHAR)");
  const returnAt = r.parts.create.indexOf('RETURN x + 1;');
  assert.ok(traceAt > -1 && returnAt > -1, 'return trace or RETURN missing');
  assert.ok(traceAt < returnAt, 'the return trace must precede the RETURN');
});

test('a function copy’s parameters carry no mode — MySQL rejects IN on functions', () => {
  // `CREATE FUNCTION f(IN x INT)` is ERROR 1064 on MySQL 8.4 (caught live by
  // dev/probe_mysql_debugger.mjs): function parameters are mode-less, while
  // procedure parameters keep the explicit mode.
  const f = instrumentMysqlRoutine(fn('BEGIN\n  RETURN x + 1;\nEND',
    [{ mode: 'IN', name: 'x', type: 'INT' }]), OPTS);
  assert.ok(!f.unsupported, f.unsupported);
  assert.match(f.parts.create, /^CREATE FUNCTION txui_debug\.__txui_dbg_calc\(x INT\)/);
  // …and it must carry its RETURNS before any characteristics.
  assert.match(f.parts.create, /\(x INT\)\nRETURNS INT\n/);
  const p = instrumentMysqlRoutine(proc(BODY, [{ mode: 'INOUT', name: 'v', type: 'INT' }]), OPTS);
  assert.match(p.parts.create, /^CREATE PROCEDURE txui_debug\.__txui_dbg_calc\(INOUT v INT\)/);
});

test('a bare-statement body is wrapped in BEGIN…END so the handler has a home', () => {
  const r = instrumentMysqlRoutine(fn('RETURN x + 1', [{ mode: 'IN', name: 'x', type: 'INT' }]), OPTS);
  assert.ok(!r.unsupported, r.unsupported);
  assert.match(r.parts.create, /BEGIN\nDECLARE EXIT HANDLER/);
  // The wrapped body still terminates its statement.
  assert.match(r.parts.create, /RETURN x \+ 1;\nEND/);
});

test('characteristics survive into the copy', () => {
  const def = { ...proc(BODY), characteristics: ['DETERMINISTIC', "COMMENT 'hi'"] };
  const r = instrumentMysqlRoutine(def, OPTS);
  assert.match(r.parts.create, /\)\nDETERMINISTIC\nCOMMENT 'hi'\nBEGIN/);
});

test('cleanup drops the copy and deletes only this run’s rows', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.equal(r.parts.cleanup[0], 'DROP PROCEDURE IF EXISTS txui_debug.__txui_dbg_calc');
  assert.equal(r.parts.cleanup[1], "DELETE FROM txui_debug.__txui_trace WHERE run = 'run-42'");
  // A stale copy is also dropped before the CREATE.
  assert.equal(r.parts.setup[1], 'DROP PROCEDURE IF EXISTS txui_debug.__txui_dbg_calc');
});

test('the startup sweep finds leftover copies and purges old trace rows', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.match(r.parts.sweep[0], /FROM information_schema\.ROUTINES/);
  // LIKE's own wildcards in the prefix are escaped (doubled for the literal).
  assert.ok(r.parts.sweep[0].includes(String.raw`\\_\\_txui\\_dbg\\_%`), r.parts.sweep[0]);
  assert.match(r.parts.sweep[1], /^DELETE FROM txui_debug\.__txui_trace WHERE ts < /);
});

test('the trace is read back by run id, ordered deterministically', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  assert.equal(r.parts.select,
    "SELECT seq, line, var, val\nFROM txui_debug.__txui_trace\nWHERE run = 'run-42'\nORDER BY seq, var");
});

test('the parts are single unterminated statements', () => {
  const { parts } = instrumentMysqlRoutine(proc(BODY), OPTS);
  const all = [...parts.setup, parts.create, ...parts.run, parts.select, ...parts.cleanup, ...parts.sweep];
  for (const s of all) {
    assert.ok(!s.trimEnd().endsWith(';'), `terminated: ${s.slice(0, 60)}…`);
  }
});

test('the display SQL fences the CREATE with DELIMITER', () => {
  const r = instrumentMysqlRoutine(proc(BODY), OPTS);
  const open = r.sql.indexOf('DELIMITER $$');
  const close = r.sql.indexOf('DELIMITER ;');
  const createAt = r.sql.indexOf('CREATE PROCEDURE');
  assert.ok(open > -1 && close > open && createAt > open && createAt < close,
    'the copy is full of semicolons — unfenced, pasting the script breaks');
});

test('strings with quotes and commas survive into the copy verbatim', () => {
  const r = instrumentMysqlRoutine(proc("BEGIN SET x = 'it''s a, b'; END"), OPTS);
  assert.ok(r.parts.create.includes("'it''s a, b'"));
});

test('a hostile run id cannot break out of its literal', () => {
  const r = instrumentMysqlRoutine(proc(BODY), { ...OPTS, runId: "r'x" });
  assert.ok(r.parts.select.includes("run = 'r''x'"), 'the quote must be doubled');
});

test('the output is deterministic', () => {
  const a = instrumentMysqlRoutine(proc(SCOPED), OPTS);
  const b = instrumentMysqlRoutine(proc(SCOPED), OPTS);
  assert.equal(a.sql, b.sql);
});

// ── refusal cases ───────────────────────────────────────────────────────────

test('triggers and events are refused, not mangled', () => {
  const trig: RoutineDef = { ...proc('BEGIN SET x = 1; END'), kind: 'trigger' };
  const r = instrumentMysqlRoutine(trig, OPTS);
  assert.ok(r.unsupported);
  assert.equal(r.sql, '');
  assert.equal(r.parts.create, '');
});

test('an unbalanced body is reported unsupported', () => {
  const r = instrumentMysqlRoutine(proc('BEGIN IF x THEN SET a = 1; END'), OPTS);
  assert.ok(r.unsupported, 'an IF closed by the outer END must not be instrumented');
  assert.equal(r.sql, '');
});

test('an empty body is reported unsupported', () => {
  assert.ok(instrumentMysqlRoutine(proc('  '), OPTS).unsupported);
});

test('a scratch schema is required', () => {
  assert.ok(instrumentMysqlRoutine(proc(BODY), { ...OPTS, scratchSchema: '' }).unsupported);
});

// ── the recorded timeline ───────────────────────────────────────────────────

test('rows group into steps by seq, sorted, NULLs preserved', () => {
  const steps = parseMysqlTrace([
    { seq: 2, line: 3, var: 'a', val: '1' },
    { seq: 1, line: 0, var: 'x', val: '42' },
    { seq: 2, line: 3, var: 'b', val: null },
  ]);
  assert.deepEqual(steps.map(s => s.n), [1, 2]);
  assert.deepEqual(steps[1].vars, { a: '1', b: null });
  assert.equal(steps[0].entry, true, 'line 0 marks the entry step');
});

test('sentinel vars fold onto the step instead of the variable map', () => {
  const [step] = parseMysqlTrace([
    { seq: 4, line: -1, var: '__txui_error', val: 'boom' },
    { seq: 4, line: -1, var: '__txui_sqlstate', val: '42000' },
    { seq: 5, line: -2, var: 'out_p', val: '9' },
    { seq: 6, line: -3, var: '__txui_truncated', val: '5000' },
    { seq: 7, line: 9, var: '__txui_return', val: '10' },
    { seq: 8, line: 2, var: '__txui_step', val: null },
  ]);
  // seq is the group key, so these are five steps — grab them in order.
  const steps = parseMysqlTrace([
    { seq: 4, line: -1, var: '__txui_error', val: 'boom' },
    { seq: 4, line: -1, var: '__txui_sqlstate', val: '42000' },
  ]);
  assert.equal(steps[0].error, 'boom');
  assert.equal(steps[0].sqlstate, '42000');
  assert.deepEqual(steps[0].vars, {});
  assert.equal(step.n, 4);
});

test('truncation, out-params and return value surface on their steps', () => {
  const steps = parseMysqlTrace([
    { seq: 1, line: LINE_TRUNCATED, var: '__txui_truncated', val: '5000' },
  ]);
  assert.equal(steps[0].truncated, true);
  const ret = parseMysqlTrace([{ seq: 1, line: 4, var: '__txui_return', val: '10' }]);
  assert.equal(ret[0].ret, '10');
  const out = parseMysqlTrace([{ seq: 1, line: LINE_OUT, var: 'b', val: '7' }]);
  assert.equal(out[0].vars.b, '7');
});

test('malformed rows are skipped rather than crashing the view', () => {
  assert.deepEqual(parseMysqlTrace([null, 'junk', { seq: 'x' }, 42]), []);
});
