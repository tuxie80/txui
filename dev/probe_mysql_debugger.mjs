#!/usr/bin/env node
/**
 * End-to-end probe of the MySQL routine debugger against a live server.
 *
 * The backend command (`debug_routine_mysql`) is deliberately a thin
 * statement-runner: the SQL it executes comes from
 * `src/utils/mysqlInstrument.ts`, and TypeScript is what this probe exercises
 * — the REAL generated instrumented SQL, driven through the same statement
 * sequence the app runs, against a real MySQL 8.4:
 *
 *   node --loader /tmp/ts-strip-loader.mjs dev/probe_mysql_debugger.mjs
 *
 * Connection discipline mirrors the backend: setup/create/select/cleanup are
 * one client invocation each (no shared state), while the RUN phase goes
 * through a single mysql process — the step counter and OUT bindings are
 * user variables, which are connection-scoped, so splitting them across
 * connections would corrupt the run exactly the way pooling would in the app.
 * The CREATE goes through the client's DELIMITER handling, which is a
 * client-side framing concern only — the wire statement is identical to what
 * the backend sends.
 *
 * What is NOT covered here: the prod/read-only gate refusals — those are
 * decided in Rust before any SQL exists and are pinned by unit tests in
 * src-tauri/src/commands/routines.rs plus the live runner test there.
 *
 * Exits non-zero if any assertion fails.
 */
import { spawnSync } from 'node:child_process';
import {
  instrumentMysqlRoutine, parseMysqlTrace,
} from '../src/utils/mysqlInstrument.ts';

const MYSQL = process.env.TXUI_MYSQL ?? `${process.env.HOME}/.linuxbrew/opt/mysql@8.4/bin/mysql`;
const HOST = process.env.TXUI_MY_HOST ?? '127.0.0.1';
const PORT = process.env.TXUI_MY_PORT ?? '3307';
const USER = process.env.TXUI_MY_USER ?? 'root';
const PASS = process.env.TXUI_MY_PASSWORD ?? 'root';

const SCRATCH = 'txui_debug';   // the nominated scratch schema (persists)
const FIXTURE = 'txui_probe';   // where the routines under test live
const TRACE_REF = `\`${SCRATCH}\`.\`__txui_trace\``;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** One statement (or a DELIMITER-wrapped create), its own connection. */
function exec(sql, { allowFail = false } = {}) {
  const r = spawnSync(MYSQL, [
    '-h', HOST, '-P', PORT, '-u', USER,
    '--batch', '--raw', '--skip-column-names',
  ], {
    input: sql, encoding: 'utf8',
    env: { ...process.env, MYSQL_PWD: PASS },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`mysql exited ${r.status}: ${r.stderr.trim()}\n  sql: ${sql.slice(0, 200)}`);
  }
  return r;
}

/** A query whose TSV rows we want back. NULL arrives as the text `NULL`. */
function query(sql) {
  const out = exec(sql).stdout;
  return out.split('\n').filter(l => l.length)
    .map(l => l.split('\t').map(c => (c === 'NULL' ? null : c)));
}

/** A CREATE PROCEDURE/FUNCTION needs client-side DELIMITER framing. */
function execCreate(create) {
  return exec(`DELIMITER $$\n${create}$$\nDELIMITER ;`);
}

/**
 * The run phase on ONE connection, stopping at the first error — exactly the
 * backend's behavior (no --force, so a failing CALL aborts the remaining run
 * statements; the error rows were already written by the EXIT HANDLER).
 */
function execRunPhase(statements) {
  const script = statements.map(s => `${s};`).join('\n');
  return exec(script, { allowFail: true });
}

/**
 * The full debug flow, statement for statement what
 * `debug_routine_mysql` does (routines.rs::run_mysql_debug).
 */
function debugRun(built) {
  exec(`CREATE DATABASE IF NOT EXISTS \`${SCRATCH}\``);
  // Crash-sweep: drop leftover copies from earlier killed runs.
  const swept = [];
  for (const [kind, schema, name] of query(built.parts.sweep[0])) {
    exec(`DROP ${kind} IF EXISTS \`${schema}\`.\`${name}\``);
    swept.push(`${schema}.${name}`);
  }
  let error = null;
  let runError = null;
  let steps = [];
  try {
    for (const s of built.parts.setup) exec(s);
    exec(built.parts.sweep[1], { allowFail: true }); // housekeeping, never fatal
    execCreate(built.parts.create);
    const r = execRunPhase(built.parts.run);
    if (r.status !== 0) runError = r.stderr.trim();
    steps = query(built.parts.select)
      .map(([seq, line, v, val]) => ({ seq: Number(seq), line: Number(line), var: v, val }));
  } catch (e) {
    error = String(e.message ?? e);
  } finally {
    for (const s of built.parts.cleanup) {
      try { exec(s); } catch (e) {
        error = `${error ? `${error}; ` : ''}cleanup failed: ${String(e.message ?? e)}`;
      }
    }
  }
  return { steps: parseMysqlTrace(steps), error, runError, swept };
}

/** No `__txui_dbg_%` routine may survive anywhere on the server. */
function leftoverCopies() {
  return query("SELECT ROUTINE_SCHEMA, ROUTINE_NAME FROM information_schema.ROUTINES "
    + "WHERE ROUTINE_NAME LIKE '\\_\\_txui\\_dbg\\_%'");
}

// ── fixtures ─────────────────────────────────────────────────────────────────

exec(`CREATE DATABASE IF NOT EXISTS \`${FIXTURE}\``);
exec(`DROP PROCEDURE IF EXISTS \`${FIXTURE}\`.\`probe_loop\``);
exec(`DROP PROCEDURE IF EXISTS \`${FIXTURE}\`.\`probe_fail\``);
exec(`DROP FUNCTION IF EXISTS \`${FIXTURE}\`.\`probe_fn\``);
execCreate(`CREATE PROCEDURE \`${FIXTURE}\`.\`probe_loop\`(IN p_start INT, INOUT p_total INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE t INT DEFAULT p_total;
  WHILE i < p_start DO
    SET i = i + 1;
    SET t = t + i * 2;
  END WHILE;
  SET p_total = t;
END`);
execCreate(`CREATE PROCEDURE \`${FIXTURE}\`.\`probe_fail\`(IN p_limit INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  WHILE i < p_limit DO
    SET i = i + 1;
    IF i = 3 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'boom at three';
    END IF;
  END WHILE;
END`);
execCreate(`CREATE FUNCTION \`${FIXTURE}\`.\`probe_fn\`(p_x INT) RETURNS INT DETERMINISTIC
BEGIN
  DECLARE doubled INT DEFAULT p_x * 2;
  RETURN doubled + 1;
END`);

const LOOP_DEF = {
  kind: 'procedure', schema: FIXTURE, name: 'probe_loop',
  params: [
    { mode: 'IN', name: 'p_start', type: 'INT' },
    { mode: 'INOUT', name: 'p_total', type: 'INT' },
  ],
  returns: null, language: 'SQL', characteristics: [],
  body: 'BEGIN\n'
    + '  DECLARE i INT DEFAULT 0;\n'
    + '  DECLARE t INT DEFAULT p_total;\n'
    + '  WHILE i < p_start DO\n'
    + '    SET i = i + 1;\n'
    + '    SET t = t + i * 2;\n'
    + '  END WHILE;\n'
    + '  SET p_total = t;\n'
    + 'END',
  bodyOffset: 0,
};
const FAIL_DEF = {
  kind: 'procedure', schema: FIXTURE, name: 'probe_fail',
  params: [{ mode: 'IN', name: 'p_limit', type: 'INT' }],
  returns: null, language: 'SQL', characteristics: [],
  body: 'BEGIN\n'
    + '  DECLARE i INT DEFAULT 0;\n'
    + '  WHILE i < p_limit DO\n'
    + '    SET i = i + 1;\n'
    + '    IF i = 3 THEN\n'
    + "      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'boom at three';\n"
    + '    END IF;\n'
    + '  END WHILE;\n'
    + 'END',
  bodyOffset: 0,
};
const FN_DEF = {
  kind: 'function', schema: FIXTURE, name: 'probe_fn',
  params: [{ mode: 'IN', name: 'p_x', type: 'INT' }],
  returns: 'INT', language: 'SQL', characteristics: ['DETERMINISTIC'],
  body: 'BEGIN\n'
    + '  DECLARE doubled INT DEFAULT p_x * 2;\n'
    + '  RETURN doubled + 1;\n'
    + 'END',
  bodyOffset: 0,
};

const version = query('SELECT VERSION()')[0][0];
console.log(`# MySQL routine debugger probe — server ${version} at ${HOST}:${PORT}\n`);

// ── 1. happy path: loop + variables + INOUT ──────────────────────────────────

console.log('── procedure with a loop, IN + INOUT parameters');
{
  const built = instrumentMysqlRoutine(LOOP_DEF, {
    scratchSchema: SCRATCH, runId: 'probe-happy',
    values: [{ name: 'p_start', value: '4' }, { name: 'p_total', value: '5' }],
  });
  if (built.unsupported) { check('instrumented', false, built.unsupported); process.exit(1); }
  const r = debugRun(built);
  check('run has no error', r.error === null, r.error ?? '');
  check('run has no runError', r.runError === null, r.runError ?? '');
  const entry = r.steps.find(s => s.entry);
  check('entry step recorded', !!entry);
  check('entry carries parameter values',
    entry?.vars.p_start === '4' && entry?.vars.p_total === '5',
    JSON.stringify(entry?.vars));
  // i goes 1..4, t accumulates i*2 onto 5 → final t = 5 + 2*(1+2+3+4) = 25.
  const lastT = [...r.steps].reverse().find(s => s.vars.t !== undefined);
  check('loop accumulated t = 25', lastT?.vars.t === '25', JSON.stringify(lastT?.vars));
  const outStep = r.steps.find(s => s.line === -2);
  check('OUT capture step present', !!outStep);
  check('INOUT param returned to the caller', outStep?.vars.p_total === '25',
    JSON.stringify(outStep?.vars));
  check('no truncated marker on a short run', !r.steps.some(s => s.truncated));
  check('cleanup left no copies behind', leftoverCopies().length === 0,
    JSON.stringify(leftoverCopies()));
  const traceLeft = query(`SELECT COUNT(*) FROM ${TRACE_REF} WHERE run = 'probe-happy'`)[0][0];
  check('cleanup deleted this run’s trace rows', traceLeft === '0');
}

// ── 2. truncation at a tiny cap ──────────────────────────────────────────────

console.log('── truncation marker at a tiny maxSteps');
{
  const built = instrumentMysqlRoutine(LOOP_DEF, {
    scratchSchema: SCRATCH, runId: 'probe-trunc', maxSteps: 4,
    values: [{ name: 'p_start', value: '50' }, { name: 'p_total', value: '0' }],
  });
  const r = debugRun(built);
  check('run has no error', r.error === null, r.error ?? '');
  const truncated = r.steps.find(s => s.truncated);
  check('truncation marker present', !!truncated);
  const capped = r.steps.filter(s => s.n <= 4 && !s.truncated);
  check('steps stopped at the cap', capped.length > 0
    && r.steps.every(s => s.n <= 5), // cap + the marker step
    `max seq ${Math.max(...r.steps.map(s => s.n))}`);
  check('cleanup left no copies behind', leftoverCopies().length === 0);
}

// ── 3. the routine raises mid-loop ───────────────────────────────────────────

console.log('── a routine that raises stays debuggable');
{
  const built = instrumentMysqlRoutine(FAIL_DEF, {
    scratchSchema: SCRATCH, runId: 'probe-fail',
    values: [{ name: 'p_limit', value: '10' }],
  });
  const r = debugRun(built);
  check('run itself did not error', r.error === null, r.error ?? '');
  check('the CALL failed (RESIGNAL)', r.runError !== null && /boom at three/.test(r.runError),
    r.runError ?? 'no runError');
  const errStep = r.steps.find(s => s.error);
  check('error recorded as a trace step', !!errStep);
  check('error text and SQLSTATE captured',
    errStep?.error === 'boom at three' && errStep?.sqlstate === '45000',
    JSON.stringify(errStep));
  const iValues = r.steps.filter(s => s.vars.i !== undefined).map(s => s.vars.i);
  check('loop values before the raise survived', iValues.includes('1') && iValues.includes('2'),
    JSON.stringify(iValues));
  // i = 3 IS traced — the SET assigning it ran and traced before the SIGNAL
  // inside the IF fired. What must be absent is anything PAST the raise.
  check('the statement that assigned i = 3 traced before the raise', iValues.includes('3'));
  check('nothing reached past the raise', !iValues.includes('4'));
  check('cleanup still ran after the raise', leftoverCopies().length === 0);
  const traceLeft = query(`SELECT COUNT(*) FROM ${TRACE_REF} WHERE run = 'probe-fail'`)[0][0];
  check('cleanup deleted this run’s trace rows', traceLeft === '0');
}

// ── 4. a function’s RETURN value ─────────────────────────────────────────────

console.log('── function return value is captured');
{
  const built = instrumentMysqlRoutine(FN_DEF, {
    scratchSchema: SCRATCH, runId: 'probe-fn',
    values: [{ name: 'p_x', value: '21' }],
  });
  if (built.unsupported) { check('instrumented', false, built.unsupported); process.exit(1); }
  const r = debugRun(built);
  check('run has no error', r.error === null, r.error ?? '');
  const retStep = r.steps.find(s => s.ret !== undefined);
  check('return value captured (21*2+1 = 43)', retStep?.ret === '43',
    JSON.stringify(retStep));
  check('cleanup left no copies behind', leftoverCopies().length === 0);
}

// ── 5. crash-sweep removes leftovers and purges old trace rows ───────────────

console.log('── crash-sweep');
{
  execCreate(`CREATE PROCEDURE \`${SCRATCH}\`.\`__txui_dbg_leftover\`() BEGIN END`);
  exec(`INSERT INTO ${TRACE_REF} (run, seq, line, var, val, ts) VALUES `
    + `('ancient', 1, 1, '__txui_step', NULL, NOW() - INTERVAL 2 DAY)`);
  check('leftover planted', leftoverCopies().length === 1);
  const built = instrumentMysqlRoutine(FN_DEF, {
    scratchSchema: SCRATCH, runId: 'probe-sweep', values: [{ name: 'p_x', value: '1' }],
  });
  const r = debugRun(built);
  check('run has no error', r.error === null, r.error ?? '');
  check('sweep dropped the leftover copy', leftoverCopies().length === 0,
    JSON.stringify(leftoverCopies()));
  const aged = query(`SELECT COUNT(*) FROM ${TRACE_REF} WHERE run = 'ancient'`)[0][0];
  check('day-old trace rows purged', aged === '0');
}

// ── teardown ─────────────────────────────────────────────────────────────────

exec(`DROP PROCEDURE IF EXISTS \`${FIXTURE}\`.\`probe_loop\``);
exec(`DROP PROCEDURE IF EXISTS \`${FIXTURE}\`.\`probe_fail\``);
exec(`DROP FUNCTION IF EXISTS \`${FIXTURE}\`.\`probe_fn\``);
exec(`DROP DATABASE IF EXISTS \`${FIXTURE}\``);

console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
