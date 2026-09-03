/**
 * plpgsql instrumentation (src/utils/plpgsqlInstrument.ts).
 *
 * The output of this module is SQL that gets executed, so a bug here is not a
 * wrong pixel — it is a block that will not compile, or worse, one that
 * compiles and traces the wrong thing. The generated SQL is also verified
 * end-to-end against a real PostgreSQL (see the session notes); these tests
 * pin the parsing and rewriting rules that make that possible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBody, findStatements, traceableNames, returnExpression,
  instrumentPlpgsql, parseTrace, changedVars, formatValue, pickTag,
  DEFAULT_MAX_STEPS,
} from '../src/utils/plpgsqlInstrument.ts';
import type { RoutineDef } from '../src/utils/routineDdl.ts';

const fn = (body: string, params: RoutineDef['params'] = []): RoutineDef => ({
  kind: 'function', schema: 'public', name: 'f', params,
  returns: 'numeric', language: 'plpgsql', body,
  characteristics: [], bodyOffset: 0,
});

const BODY = `DECLARE
  total numeric := 0;
  r record;
BEGIN
  total := 0;
  FOR r IN SELECT id, amount FROM orders ORDER BY id LOOP
    total := total + r.amount;
  END LOOP;
  RETURN total;
END;`;

// ── splitting ───────────────────────────────────────────────────────────────

test('the DECLARE section is separated from the executable body', () => {
  const { declare, exec } = splitBody(BODY);
  assert.match(declare, /total numeric := 0;/);
  assert.match(declare, /r record;/);
  assert.ok(!exec.includes('numeric := 0;\n  r record'), 'declarations leaked into exec');
  assert.match(exec, /FOR r IN SELECT/);
});

test('the closing END of the outermost block is removed', () => {
  const { exec } = splitBody(BODY);
  assert.ok(!/\bEND;\s*$/i.test(exec.trim()), `exec still ends with END: ${JSON.stringify(exec.slice(-20))}`);
  // But the inner END LOOP must survive.
  assert.match(exec, /END LOOP;/i);
});

test('a body with no DECLARE section still splits', () => {
  const { declare, exec } = splitBody('BEGIN\n  PERFORM 1;\nEND;');
  assert.equal(declare, '');
  assert.match(exec, /PERFORM 1;/);
});

test('a single-expression SQL body yields nothing to instrument', () => {
  const { exec } = splitBody('SELECT 1');
  assert.equal(exec.trim(), '');
});

test('the words DECLARE and BEGIN inside a string do not split the body', () => {
  const src = "BEGIN\n  RAISE NOTICE 'DECLARE this BEGIN that';\n  PERFORM 1;\nEND;";
  const { declare, exec } = splitBody(src);
  assert.equal(declare, '', 'a string was mistaken for a DECLARE section');
  assert.match(exec, /PERFORM 1;/);
});

// ── statement boundaries ────────────────────────────────────────────────────

test('statements are found with their original line numbers', () => {
  const { exec } = splitBody(BODY);
  const stmts = findStatements(exec);
  const texts = stmts.map(s => s.text.replace(/\s+/g, ' '));
  assert.ok(texts.some(t => t.startsWith('total := 0')), texts.join(' / '));
  assert.ok(texts.some(t => t.includes('total + r.amount')));
  assert.ok(texts.some(t => t.startsWith('END LOOP')));
  assert.ok(texts.some(t => t.startsWith('RETURN total')));
});

test('a semicolon inside parentheses is not a statement boundary', () => {
  const stmts = findStatements("PERFORM f('a;b');\nPERFORM 2;");
  assert.equal(stmts.length, 2, stmts.map(s => s.text).join(' | '));
});

test('a semicolon inside a string or comment is not a boundary', () => {
  assert.equal(findStatements("x := 'a;b';").length, 1);
  assert.equal(findStatements('x := 1; -- a; comment\ny := 2;').length, 2);
  assert.equal(findStatements('x := 1; /* a; b */ y := 2;').length, 2);
});

test('line numbers survive newlines inside strings and comments', () => {
  // A multi-line string must advance the counter, or every later statement
  // reports a line that is too low and the gutter points at the wrong code.
  const src = "a := 'one\ntwo\nthree';\nb := 2;";
  const stmts = findStatements(src);
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].line, 3, 'the statement ends on the third line');
  assert.equal(stmts[1].line, 4, `got line ${stmts[1].line}`);
});

test('a statement reports the line it ENDS on, offset to the original body', () => {
  // The trace fires after the statement, so that is what the gutter marks.
  // A FOR loop whose body assigns on the next line must report the assignment,
  // not the FOR.
  const stmts = findStatements('\n  x := 1;\n  FOR r IN SELECT 1 LOOP\n    y := 2;\n  END LOOP;', 4);
  assert.deepEqual(stmts.map(s => s.line), [5, 7, 8]);
});

test('dollar-quoted regions are skipped whole', () => {
  const src = 'EXECUTE $q$SELECT 1; SELECT 2;$q$;\nPERFORM 3;';
  assert.equal(findStatements(src).length, 2);
});

// ── traced names ────────────────────────────────────────────────────────────

test('parameters and declared variables are traced', () => {
  const def = fn(BODY, [{ mode: 'IN', name: 'cust_id', type: 'integer' }]);
  const { declare } = splitBody(BODY);
  const names = traceableNames(def, declare);
  assert.deepEqual(names, ['cust_id', 'total', 'r']);
});

test('an undeclared FOR-loop variable is NOT traced', () => {
  // plpgsql auto-declares it scoped to the loop; referencing it outside is a
  // compile error, so tracing it would break the generated block.
  const body = 'BEGIN\n  FOR rec IN SELECT 1 LOOP\n    PERFORM rec;\n  END LOOP;\nEND;';
  const def = fn(body);
  const { declare } = splitBody(body);
  assert.deepEqual(traceableNames(def, declare), []);
});

// ── RETURN rewriting ────────────────────────────────────────────────────────

test('RETURN expr is recognised and its expression extracted', () => {
  assert.equal(returnExpression('RETURN total;'), 'total');
  assert.equal(returnExpression('  return  a + b ;  '), 'a + b');
  assert.equal(returnExpression('RETURN;'), null, 'a bare RETURN needs no rewrite');
  assert.equal(returnExpression('x := 1;'), null);
});

test('RETURN NEXT and RETURN QUERY are left alone', () => {
  // Rewriting a set-returning form as a scalar would silently change meaning.
  assert.equal(returnExpression('RETURN NEXT r;'), null);
  assert.equal(returnExpression('RETURN QUERY SELECT 1;'), null);
});

test('a set-returning routine is reported unsupported rather than mangled', () => {
  const r = instrumentPlpgsql(fn('BEGIN\n  RETURN QUERY SELECT 1;\nEND;'));
  assert.ok(r.unsupported, 'should refuse');
  assert.match(r.unsupported, /RETURN NEXT|RETURN QUERY/);
  assert.equal(r.sql, '');
});

test('a body with nothing to step through is reported, not silently empty', () => {
  const r = instrumentPlpgsql(fn('SELECT 1'));
  assert.ok(r.unsupported);
  assert.equal(r.sql, '');
});

// ── the generated block ─────────────────────────────────────────────────────

test('the generated SQL has the shape the run depends on', () => {
  const r = instrumentPlpgsql(fn(BODY, [{ mode: 'IN', name: 'cust_id', type: 'integer' }]),
    { values: [{ name: 'cust_id', value: '42' }] });
  assert.ok(!r.unsupported, r.unsupported);

  // Temp sink, dropped with the transaction — no scratch schema.
  assert.match(r.sql, /CREATE TEMP TABLE __txui_trace\(step jsonb\) ON COMMIT DROP;/);
  // Anonymous block — nothing is created on the server.
  assert.match(r.sql, /^CREATE TEMP TABLE[\s\S]*\nDO \$__txui_dbg\$/);
  // The parameter is bound as a local.
  assert.match(r.sql, /cust_id integer := 42;/);
  // The trace lives in memory…
  assert.match(r.sql, /__txui_tr jsonb\[\] := '\{\}';/);
  // …guarded by a handler…
  assert.match(r.sql, /EXCEPTION WHEN OTHERS THEN/);
  // …and is written ONCE, after the handler, so a failed run still reports.
  const insertAt = r.sql.indexOf('INSERT INTO __txui_trace');
  const handlerAt = r.sql.indexOf('EXCEPTION WHEN OTHERS');
  assert.ok(insertAt > handlerAt, 'the trace insert must come after the handler');
  // The timeline is read out at the end; the caller supplies the ROLLBACK.
  assert.match(r.sql, /SELECT step FROM __txui_trace ORDER BY \(step->>'n'\)::int;$/);
});

test('the run is exposed as separate statements, none of them terminated', () => {
  // The backend runs these one at a time inside a transaction it always rolls
  // back; a trailing `;` would break the single-statement execution path.
  const { parts } = instrumentPlpgsql(fn(BODY));
  assert.match(parts.setup, /^CREATE TEMP TABLE __txui_trace/);
  assert.match(parts.block, /^DO \$__txui_dbg\$/);
  assert.match(parts.select, /^SELECT step FROM __txui_trace/);
  for (const [k, v] of Object.entries(parts)) {
    assert.ok(!v.trimEnd().endsWith(';'), `${k} must not be terminated`);
  }
});

test('an unsupported routine yields empty parts, not partial SQL', () => {
  const r = instrumentPlpgsql(fn('SELECT 1'));
  assert.deepEqual(r.parts, { setup: '', block: '', select: '' });
});

test('every statement gets a trace append', () => {
  const r = instrumentPlpgsql(fn(BODY));
  const appends = r.sql.match(/__txui_tr := __txui_tr \|\|/g) ?? [];
  // One per statement plus the exception pseudo-step.
  assert.ok(appends.length >= 4, `only ${appends.length} trace appends`);
  assert.ok(r.lines.length >= 4);
});

test('RETURN expr becomes a traced value followed by EXIT, never RETURN', () => {
  // `RETURN total;` does not compile in a DO block — and a bare `RETURN;`
  // leaves the WHOLE block, skipping the INSERT that saves the timeline. That
  // produced an empty trace for every routine that returned a value, which is
  // most of them. EXIT leaves only the labelled body.
  const r = instrumentPlpgsql(fn(BODY));
  assert.match(r.sql, /'ret', to_jsonb\(total\)/);
  assert.ok(!/RETURN total;/.test(r.sql), 'the value-returning RETURN survived');
  assert.ok(!/\bRETURN\s*;/.test(r.sql), 'a bare RETURN would skip the trace insert');
  assert.match(r.sql, /EXIT __txui_body;/);
  assert.match(r.sql, /<<__txui_body>>/);
});

test('a record variable is captured through a guard, not read directly', () => {
  // to_jsonb(r) on an unassigned record raises "record r is not assigned yet",
  // which killed the run on every step before the loop populated it.
  const r = instrumentPlpgsql(fn(BODY));
  assert.match(r.sql, /__txui_v_r jsonb;/, 'no holder declared for the record');
  assert.match(r.sql, /BEGIN __txui_v_r := to_jsonb\(r\); EXCEPTION WHEN OTHERS THEN __txui_v_r := NULL; END;/);
  assert.ok(!/'r', to_jsonb\(r\)/.test(r.sql), 'the record is still read unguarded');
  // A scalar needs no guard.
  assert.match(r.sql, /'total', to_jsonb\(total\)/);
});

test('the step cap is enforced inside the loop, not after it', () => {
  // A runaway loop must not be able to grow the array without bound.
  const r = instrumentPlpgsql(fn(BODY), { maxSteps: 12 });
  assert.match(r.sql, /__txui_max int := 12;/);
  assert.match(r.sql, /IF __txui_n < __txui_max THEN/);
  assert.equal(instrumentPlpgsql(fn(BODY)).sql.includes(`:= ${DEFAULT_MAX_STEPS};`), true);
});

test('an unbound parameter is declared without an initialiser', () => {
  const r = instrumentPlpgsql(fn(BODY, [{ mode: 'IN', name: 'p', type: 'text' }]));
  assert.match(r.sql, /p text;/);
  assert.ok(!/p text :=/.test(r.sql));
});

test('the dollar tag cannot be terminated by the body', () => {
  assert.equal(pickTag('plain'), '$__txui_dbg$');
  assert.equal(pickTag('contains $__txui_dbg$ already'), '$__txui_d2$');
  const r = instrumentPlpgsql(fn('BEGIN\n  EXECUTE $__txui_dbg$SELECT 1$__txui_dbg$;\nEND;'));
  assert.ok(!r.sql.startsWith('DO $__txui_dbg$'));
});

// ── the recorded timeline ───────────────────────────────────────────────────

test('trace rows parse from JSON strings or objects, in order', () => {
  const steps = parseTrace([
    JSON.stringify({ n: 2, line: 7, vars: { total: 30 } }),
    { n: 1, line: 5, vars: { total: 0 } },
  ]);
  assert.deepEqual(steps.map(s => s.n), [1, 2]);
  assert.equal(steps[1].vars.total, 30);
});

test('an exception step carries its message and sqlstate', () => {
  const [s] = parseTrace([{ n: 1, line: -1, error: 'boom', sqlstate: 'P0001' }]);
  assert.equal(s.error, 'boom');
  assert.equal(s.sqlstate, 'P0001');
  assert.equal(s.line, -1);
});

test('malformed rows are skipped rather than crashing the view', () => {
  assert.deepEqual(parseTrace(['not json', null, 42]), []);
});

test('changed variables are detected between steps', () => {
  const a = { n: 1, line: 1, vars: { total: 0, r: null } };
  const b = { n: 2, line: 2, vars: { total: 10, r: null } };
  const changed = changedVars(a, b);
  assert.ok(changed.has('total'));
  assert.ok(!changed.has('r'), 'an unchanged variable must not be flagged');
  // The first step has no predecessor — everything counts as new.
  assert.ok(changedVars(undefined, a).has('total'));
});

test('a variable changing to or from NULL counts as a change', () => {
  const changed = changedVars(
    { n: 1, line: 1, vars: { x: null } },
    { n: 2, line: 2, vars: { x: 5 } },
  );
  assert.ok(changed.has('x'));
});

test('values display without lying about NULL', () => {
  assert.equal(formatValue(null), 'NULL');
  assert.equal(formatValue(undefined), 'NULL');
  assert.equal(formatValue(0), '0', 'zero is not null');
  assert.equal(formatValue(''), '', 'an empty string is not null');
  assert.equal(formatValue({ a: 1 }), '{"a":1}');
});
