#!/usr/bin/env node
/**
 * Run the server-side generator's own SQL against a live server.
 *
 * Every claim in `utils/datagenSql.ts` is about what a *particular engine*
 * will accept — `ELT` exists only on MySQL, `generate_series` only on
 * PostgreSQL, and MySQL's recursive-CTE depth limit is the whole reason the
 * row source is a cross join. None of that can be verified by reading it.
 *
 *     dbctl start pg16 my80
 *     node --experimental-strip-types dev/probe_datagen.mjs
 *
 * Creates a scratch table, generates into it, checks the row count, drops it.
 */
import { execFileSync } from 'node:child_process';
import { buildServerPlan } from '../src/utils/datagenSql.ts';
import { DEFAULT_PARAMS } from '../src/utils/datagen.ts';

const col = (name, typeName, generator) => ({ name, typeName, generator, params: { ...DEFAULT_PARAMS } });
const SPECS = [
  col('id', 'bigint', 'sequence'),
  col('name', 'varchar(80)', 'fullName'),
  col('city', 'varchar(60)', 'city'),
  col('score', 'int', 'int'),
  col('made_on', 'date', 'date'),
  // Added with the 0.56.0 generator expansion. Coordinates and evenly spaced
  // timestamps are exactly the columns people generate ten million of, so
  // they are the ones that most need to work on the server-side path — and
  // the trigonometry differs enough between engines to be worth running.
  col('lat', 'double precision', 'latitude'),
  col('lon', 'double precision', 'longitude'),
  col('bucket', 'timestamp', 'timestampStep'),
  col('amount', 'decimal(12,2)', 'money'),
  col('pct', 'decimal(5,1)', 'percent'),
];
const ROWS = Number(process.env.ROWS ?? 250_000);
const TABLE = 'txui_datagen_probe';

function psql(port, sql) {
  return execFileSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'root', '-d', 'root',
    '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'root' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const MY_DB = process.env.MY_DB ?? 'txui_probe';
function mysql(port, sql) {
  return execFileSync('mysql', ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', '--password=root',
    '-D', MY_DB, '-N', '-B', '-e', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** The scratch database has to exist before -D can select it. */
function mysqlBootstrap(port) {
  execFileSync('mysql', ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', '--password=root',
    '-N', '-B', '-e', `CREATE DATABASE IF NOT EXISTS \`${MY_DB}\``],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The scratch table, derived from SPECS rather than written out.
 *
 * It used to be a hardcoded column list, which meant adding a generator to
 * SPECS produced "column does not exist" instead of testing the generator.
 * `double precision` is PostgreSQL's spelling; MySQL wants `double`.
 */
function ddl(engine) {
  const cols = SPECS.map(s => {
    let type = s.typeName;
    if (engine === 'mysql') {
      type = type.replace(/double precision/i, 'double');
      // DATETIME, not TIMESTAMP — see the DST note in utils/datagenSql.ts.
      // An evenly spaced hourly series crosses the spring-forward gap once a
      // year, and MySQL rejects those local times in a TIMESTAMP column.
      // This probe found that with '2024-03-31 02:00:00' on a CEST server.
      type = type.replace(/^timestamp$/i, 'datetime');
    }
    return `${s.name} ${type}`;
  }).join(', ');
  return `DROP TABLE IF EXISTS ${TABLE}; CREATE TABLE ${TABLE} (${cols})`;
}

const targets = [
  { engine: 'postgres', port: process.env.PG_PORT ?? 5432, run: psql,
    create: ddl('postgres'),
    count: `SELECT count(*) FROM ${TABLE}`, drop: `DROP TABLE IF EXISTS ${TABLE}` },
  { engine: 'mysql', port: process.env.MY_PORT ?? 3306, run: mysql,
    create: ddl('mysql'),
    count: `SELECT COUNT(*) FROM ${TABLE}`, drop: `DROP TABLE IF EXISTS ${TABLE}` },
];

let failed = 0;
for (const t of targets) {
  process.stdout.write(`\n── ${t.engine} :${t.port}\n`);
  try {
    if (t.engine === 'mysql') mysqlBootstrap(t.port);
    t.run(t.port, 'SELECT 1');
  } catch {
    process.stdout.write('   not reachable, skipped\n');
    continue;
  }
  try {
    t.run(t.port, t.create);
    const plan = buildServerPlan(t.engine, TABLE, SPECS, ROWS);
    if (plan.unsupported.length) throw new Error(`unsupported: ${JSON.stringify(plan.unsupported)}`);
    process.stdout.write(`   ${plan.chunks} chunk(s) × ${plan.chunkRows} rows\n`);
    const t0 = Date.now();
    for (const stmt of plan.statements) t.run(t.port, stmt);
    const ms = Date.now() - t0;
    const got = Number(String(t.run(t.port, t.count)).trim().split('\n').pop());
    const ok = got === ROWS;
    if (!ok) failed++;
    process.stdout.write(`   ${ok ? '✓' : '✗'} ${got.toLocaleString()} rows in ${(ms / 1000).toFixed(1)}s`
      + ` (${Math.round(got / (ms / 1000)).toLocaleString()} rows/s)\n`);
    // A sample, so "it ran" is not the only thing checked.
    const sample = String(t.run(t.port, `SELECT * FROM ${TABLE} LIMIT 2`)).trim();
    process.stdout.write(`   ${sample.split('\n').join('\n   ')}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`   ✗ ${String(e.stderr ?? e.message).split('\n').slice(0, 3).join(' ')}\n`);
  } finally {
    try { t.run(t.port, t.drop); } catch { /* leave nothing behind */ }
  }
}
process.exit(failed === 0 ? 0 : 1);
