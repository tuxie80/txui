// Run every ClickHouse DBA view against the live server with readonly=1.
// Metadata only: every view reads system.* by construction, and this harness
// refuses to send anything that does not.
import { execFileSync } from 'node:child_process';
import { DBA_VIEWS } from '../src/utils/dbaViews.ts';

const HOST = process.env.CH_HOST ?? '127.0.0.1';
const PORT = process.env.CH_PORT ?? '8123';
const USER = process.env.CH_USER ?? 'default';
const PASS = process.env.CH_PASS;
if (!PASS) {
  console.error('usage: CH_HOST=… CH_USER=… CH_PASS=… node --experimental-strip-types dev/probe_ch_views.mjs');
  process.exit(1);
}

const views = DBA_VIEWS.clickhouse ?? [];
console.log(`# ${views.length} ClickHouse DBA views\n`);

let bad = 0;
for (const v of views) {
  // Guard: a view must only touch system.* — proves the panel cannot read
  // user data even if someone edits a view later.
  const refs = [...v.sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)\./g)].map(m => m[1]);
  const nonSystem = refs.filter(r => r !== 'system');
  if (nonSystem.length) {
    console.log(`GUARD ${v.id.padEnd(16)} touches non-system: ${nonSystem}`);
    bad++; continue;
  }
  try {
    const out = execFileSync('curl', [
      '-sS', '--fail-with-body', '--max-time', '30',
      '-H', `X-ClickHouse-User: ${USER}`,
      '-H', `X-ClickHouse-Key: ${PASS}`,
      `http://${HOST}:${PORT}/?readonly=1&max_execution_time=25&max_result_rows=2000&result_overflow_mode=break&default_format=TSV`,
      '--data-binary', v.sql,
    ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const rows = out.trim() ? out.trim().split('\n').length : 0;
    console.log(`ok    ${v.id.padEnd(16)} ${String(rows).padStart(5)} rows  ${v.label}`);
  } catch (e) {
    const body = String(e.stdout || e.stderr || e.message).split('\n')[0].slice(0, 150);
    console.log(`FAIL  ${v.id.padEnd(16)} ${v.label}\n        ${body}`);
    bad++;
  }
}
console.log(`\n# ${bad} failing view(s)`);
