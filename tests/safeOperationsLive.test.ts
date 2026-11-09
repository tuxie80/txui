import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync('dev/safe_operations_live.sh', 'utf8');
const migration = readFileSync('src-tauri/src/commands/migration.rs', 'utf8');
const refresh = readFileSync('src-tauri/src/commands/refresh.rs', 'utf8')
  + readFileSync('src-tauri/src/commands/refresh/execute.rs', 'utf8');
const queryLab = readFileSync('src-tauri/src/commands/query_lab.rs', 'utf8');

function liveTests(source: string, prefix: string): number {
  return [...source.matchAll(/async fn (dbctl_[a-z0-9_]+)\(/g)]
    .filter(match => match[1].startsWith(prefix)).length;
}

test('Safe Operations live runner covers the complete dbctl inventory', () => {
  const counts = {
    migrationMysql: liveTests(migration, 'dbctl_mysql_'),
    migrationPostgres: liveTests(migration, 'dbctl_postgres_'),
    refreshMysql: liveTests(refresh, 'dbctl_'),
    queryLabMysql: liveTests(queryLab, 'dbctl_mysql_'),
    queryLabPostgres: liveTests(queryLab, 'dbctl_pg_') + liveTests(queryLab, 'dbctl_hypopg_'),
  };
  assert.deepEqual(counts, {
    migrationMysql: 6,
    migrationPostgres: 6,
    refreshMysql: 6,
    queryLabMysql: 4,
    queryLabPostgres: 7,
  });
  const total = counts.migrationMysql * 2 + counts.migrationPostgres
    + counts.refreshMysql * 2 + counts.queryLabMysql * 2 + counts.queryLabPostgres;
  assert.equal(total, 45);
  assert.match(script, /TOTAL_GROUPS=8/);
  assert.match(script, new RegExp(`TOTAL_TESTS=${total}`));
});

test('Safe Operations live runner uses exact engine filters and disposable serial fixtures', () => {
  const groups = [...script.matchAll(/run_group '([^']+)' ([^ ]+) '([^']+)' (\d+)/g)]
    .map(match => ({ feature: match[1], target: match[2], filter: match[3], count: Number(match[4]) }));
  assert.equal(groups.length, 8);
  assert.deepEqual(groups.map(group => group.count), [6, 6, 6, 6, 6, 4, 4, 7]);
  assert.deepEqual(groups.map(group => group.target), [
    'mysql@8.4', 'mariadb@11.8', 'postgres@18',
    'mysql@8.4', 'mariadb@11.8',
    'mysql@8.4', 'mariadb@11.8', 'postgres@18',
  ]);
  assert.ok(groups.every(group => group.filter.startsWith('commands::')));
  assert.equal((script.match(/dbctl tmp /g) ?? []).length, 1);
  assert.match(script, /--profile tiny/);
  assert.match(script, /--ignored --nocapture --test-threads=1/);
  assert.match(script, /postgres@18 'commands::query_lab::tests::dbctl_' 7 '--skip dbctl_mysql_'/);
  assert.doesNotMatch(script, /--keep/);
});
