// Generate the conformance vectors that keep the Rust sync port honest.
//
// The GUI runs `src/utils/sync*.ts`; the backend mirrors it in `src-tauri/src/sync/*.rs`.
// Two implementations of one set of rules drift, and the drift is silent — a
// copy verified against different rules than the ones that produced it is
// exactly the failure the verifier exists to prevent.
//
// TxShell's conformance test compares a *verb registry* by reading names out of
// the TypeScript. That works for a declarative list and would prove nothing
// here, because this logic is behavioural: matching function names says nothing
// about what they compute.
//
// So this runs the TypeScript implementation over a fixed set of inputs and
// records the outputs. `src-tauri/tests/sync_conformance.rs` feeds the same
// inputs to the Rust and asserts the outputs match. A behavioural difference is
// what fails, which is the only kind worth catching.
//
//   node --experimental-strip-types dev/gen_sync_vectors.mjs
//
// Re-run it whenever the TypeScript changes; the Rust test then fails until the
// port is brought back into line. That failure is the point.

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import {
  splitCreateTable, rebuildPlan, loadColumnList, splitClauses, classifyClause,
  generatedColumnName, columnName, liftAutoIncrement,
} from '../src/utils/syncDdl.ts';
import {
  parseVersion, atLeast, isMariaDb, binlogStatusStatement, resetBinlogStatement,
  gtidAvailability, canSeedByGtid, seedCapability, changeSourceStatement,
  REPLICA_STATUS_STATEMENT, RESET_REPLICA_STATEMENT,
} from '../src/utils/syncCompat.ts';

const OUT = new URL('../src-tauri/tests/fixtures/sync_vectors.json', import.meta.url).pathname;

/** Versions chosen to cover every branch, including the MariaDB trap. */
const VERSIONS = [
  '8.0.46',
  '8.4.10',
  // Boundary versions, either side of the 8.4 cutover. Without these an
  // off-by-one in the threshold passes every vector — found by injecting
  // exactly that drift and watching the test stay green.
  '8.4.0',
  '8.3.0',
  '8.2.0',
  '7.9.9',
  '9.5.0',
  '8.10.0',                    // numeric vs lexicographic comparison
  '8.0.46-0ubuntu0.22.04.1',   // distro suffix
  '10.11.6-MariaDB',           // version number past 8.4, legacy vocabulary
  '11.4.2-MariaDB',
  '8.4',                       // missing patch
  'unknown',                   // unparseable
  '',
];

const GTID_MODES = [
  'ON', 'OFF', 'ON_PERMISSIVE', 'OFF_PERMISSIVE',
  '  on  ', 'Off_Permissive', '', null,
];

const POSITIONS = [
  { gtidExecuted: 'uuid:1-500', logFile: null, logPos: null },
  { gtidExecuted: null, logFile: 'binlog.000043', logPos: 67337257 },
  { gtidExecuted: 'g:1', logFile: 'binlog.1', logPos: 4 },   // GTID wins
  { gtidExecuted: null, logFile: null, logPos: null },        // neither
];

const CONNS = [
  { host: 'db-source', port: 3306, user: 'repl' },
  { host: 'db-source', port: 3307, user: 'repl' },
  { host: 'h', user: 'u' },                                   // no port
  { host: "it's", port: 3306, user: "o'brien" },              // quote escaping
];

/**
 * Every `SHOW CREATE TABLE` on both live servers.
 *
 * A parser checked only against fixtures its author wrote is checked against
 * their assumptions. These are real statements the servers themselves produced,
 * including whatever quoting, defaults and option ordering they chose — and the
 * pair spans a major version, so 8.0 and 8.4 renderings are both covered.
 *
 * Falls back to the built-in fixtures when the servers are not running, so the
 * generator works on a machine that has never seen them.
 */
function liveDdl() {
  const servers = [
    { port: 3306, bin: 'mysql' },
    { port: 3307, bin: '/opt/homebrew/opt/mysql@8.4/bin/mysql' },
  ];
  const out = [];
  for (const { port, bin } of servers) {
    let rows;
    try {
      rows = execFileSync(bin, ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-proot', '-N', '-e',
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type='BASE TABLE'
           AND table_schema NOT IN ('mysql','sys','information_schema','performance_schema')`],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch { continue; }
    if (!rows) continue;
    for (const line of rows.split('\n')) {
      const [schema, table] = line.split('\t');
      try {
        const ddl = execFileSync(bin, ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', '-proot',
          '-N', schema, '-e', `SHOW CREATE TABLE \`${table}\``],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
          .split('\t').slice(1).join('\t').replace(/\\n/g, '\n').trim();
        if (ddl.startsWith('CREATE TABLE')) out.push({ from: `${port}`, schema, table, ddl });
      } catch { /* table vanished or unreadable — skip it */ }
    }
  }
  return out;
}

/** Kept so the generator still exercises the awkward cases with no servers. */
const FALLBACK_DDL = [
  { from: 'fixture', schema: 'db', table: 'commented',
    ddl: "CREATE TABLE `commented` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n)"
       + " ENGINE=InnoDB COMMENT='reset AUTO_INCREMENT=5 nightly'" },
  { from: 'fixture', schema: 'db', table: 'weird',
    ddl: "CREATE TABLE `weird` (\n  `we,ird` int DEFAULT NULL,\n  `s` varchar(10) DEFAULT 'a,b',\n"
       + "  `keyword` int DEFAULT NULL,\n  PRIMARY KEY (`we,ird`)\n) ENGINE=InnoDB AUTO_INCREMENT=7" },
  { from: 'fixture', schema: 'db', table: 'nothing',
    ddl: 'CREATE TABLE `nothing` (\n  `id` int NOT NULL\n) ENGINE=InnoDB' },
];

const DDL_CASES = [...liveDdl(), ...FALLBACK_DDL];

const vectors = {
  _generated_by: 'dev/gen_sync_vectors.mjs',
  _asserted_by: 'src-tauri/tests/sync_conformance.rs',

  version: VERSIONS.map(raw => {
    const v = parseVersion(raw);
    return {
      raw,
      major: v.major, minor: v.minor, patch: v.patch,
      isMariaDb: isMariaDb(v),
      atLeast_8_4: atLeast(v, 8, 4),
      binlogStatus: binlogStatusStatement(v),
      resetBinlog: resetBinlogStatement(v),
    };
  }),

  gtid: GTID_MODES.map(mode => ({
    mode,
    availability: gtidAvailability(mode),
    canSeed: canSeedByGtid(mode),
    capability: seedCapability(mode),
  })),

  changeSource: POSITIONS.flatMap(pos =>
    CONNS.map(conn => ({ pos, conn, sql: changeSourceStatement(pos, conn) }))),

  ddl: DDL_CASES.map(({ from, schema, table, ddl }) => {
    const split = splitCreateTable(ddl);
    return {
      from, schema, table, ddl,
      createSql: split.createSql,
      deferred: split.deferred,
      autoIncrement: split.autoIncrement,
      generatedColumns: split.generatedColumns,
      loadColumns: split.loadColumns,
      loadColumnList: loadColumnList(split),
      rebuild: rebuildPlan(schema, table, split),
    };
  }),

  ddlParts: DDL_CASES.map(({ ddl }) => {
    const open = ddl.indexOf('('), close = ddl.lastIndexOf(')');
    const body = open >= 0 && close > open ? ddl.slice(open + 1, close) : '';
    const clauses = splitClauses(body);
    return {
      clauses,
      classified: clauses.map(classifyClause),
      generated: clauses.map(generatedColumnName),
      columns: clauses.map(columnName),
      lifted: liftAutoIncrement(close >= 0 ? ddl.slice(close + 1) : ''),
    };
  }),

  constants: {
    replicaStatus: REPLICA_STATUS_STATEMENT,
    resetReplica: RESET_REPLICA_STATEMENT,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(vectors, null, 2) + '\n');

const count = vectors.version.length + vectors.gtid.length + vectors.changeSource.length
  + vectors.ddl.length + vectors.ddlParts.length;
const live = vectors.ddl.filter(d => d.from !== 'fixture').length;
console.log(`wrote ${count} vectors to ${OUT}`);
console.log(`  ${live} DDL cases read from live servers, ${vectors.ddl.length - live} from fixtures`);
