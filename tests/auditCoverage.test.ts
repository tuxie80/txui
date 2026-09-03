/**
 * Audit coverage policy.
 *
 * The 📜 Audit log's only value is that it is **complete**. One surface that
 * quietly does not record makes every answer it gives conditional — "no, there
 * is no record of anyone importing that file" stops meaning anything once a
 * panel exists that imports files without saying so. And that is exactly what
 * had happened: CSV import, dump/restore, fleet execution, TxShell and ANALYZE
 * all ran server-side work and recorded nothing anywhere.
 *
 * These are source-level rules rather than behavioural tests because the
 * failure they guard against is a *new call site* — code that has not been
 * written yet, in a file nobody thought to test. A unit test cannot fail for
 * code that does not exist; a policy scan can.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Backend commands that change something, or run something on a server, and
 * the panel that is allowed to call each. Every call must be wrapped in
 * `audited(...)` from `utils/panelAudit`.
 */
const MUST_BE_AUDITED: Array<{ file: string; command: string }> = [
  { file: 'src/components/CsvImportPanel.tsx', command: 'csv_import' },
  { file: 'src/components/DumpRestorePanel.tsx', command: 'run_dump_tool' },
  { file: 'src/components/MultiExec.tsx', command: 'multi_execute' },
  { file: 'src/components/TxShellPanel.tsx', command: 'execute_query' },
];

test('every consequential panel command is wrapped in audited()', () => {
  const offenders: string[] = [];
  for (const { file, command } of MUST_BE_AUDITED) {
    const src = read(file);
    // `invoke('x'` and `invoke<T>('x'` are the same call.
    const re = new RegExp(`invoke(?:<[^>]*>)?\\('${command}'`, 'g');
    let seen = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const i = m.index;
      seen += 1;
      // The wrapper opens shortly before the call it wraps: `audited({ …,
      // run: () => invoke('x', …) })`. A call further than this from an
      // `audited({` is one nobody wrapped.
      const window = src.slice(Math.max(0, i - 900), i);
      if (!window.includes('audited({')) {
        const line = src.slice(0, i).split('\n').length;
        offenders.push(`${file}:${line} — invoke('${command}') is not inside audited()`);
      }
    }
    assert.ok(seen > 0, `${file} no longer calls ${command} — update MUST_BE_AUDITED`);
  }
  assert.deepEqual(offenders, [],
    'wrap it in audited() from utils/panelAudit — an unrecorded write makes the whole audit log conditional');
});

test('every panel named here actually imports the wrapper', () => {
  for (const { file } of MUST_BE_AUDITED) {
    assert.match(read(file), /import \{ audited \} from '\.\.\/utils\/panelAudit'/, file);
  }
});

// ── the security guarantee ──────────────────────────────────────────────────

test('the wrapper redacts every string it records, with no way to opt out', () => {
  // What passes through here is written to an immutable SQLite row, mirrored
  // into the session log, and often mirrored again into a file on disk. Those
  // are the artefacts people paste into tickets.
  const src = read('src/utils/panelAudit.ts');
  assert.match(src, /redactCommandLine\(redactSecrets\(/,
    'both redactors must run, SQL first then command-line forms');
  // No flag, no option, no conditional: the one call site that opted out would
  // be the one that leaked.
  assert.doesNotMatch(src, /redact\s*[?:]|skipRedact|noRedact/,
    'redaction must not be optional');
});

test('the wrapper records failures as well as successes', () => {
  const src = read('src/utils/panelAudit.ts');
  assert.match(src, /ok:\s*false/, 'a log that only holds what worked cannot answer "what was tried"');
  assert.match(src, /throw e/, 'auditing must not swallow the error the panel is about to handle');
});

test('the wrapper measures the duration rather than accepting one', () => {
  const src = read('src/utils/panelAudit.ts');
  assert.match(src, /performance\.now\(\)/);
  assert.doesNotMatch(src, /duration_ms:\s*a\./, 'the caller must not be able to state the duration');
});

// ── the mirror into the session log ─────────────────────────────────────────

test('logAudit mirrors into the session log unless the caller already logs', () => {
  const src = read('src/utils/audit.ts');
  assert.match(src, /addLog\(entry\.session_id/, 'audited actions must appear in the 📓 Log');
  assert.match(src, /opts\.alsoLog === false/, 'and the editor, which logs its own richer pair, must be able to opt out');
});

test('the three call sites that write their own lines opt out, and only those', () => {
  // The editor's run engine moved to hooks/useQueryRunner (WP-16 16.1 step 4)
  // and its opt-out moved with it.
  const optOut = ['src/hooks/useQueryRunner.ts', 'src/components/DataBrowser.tsx', 'src/utils/killExec.ts'];
  for (const f of optOut) {
    assert.match(read(f), /alsoLog: false/, `${f} writes its own log lines and must opt out`);
  }
  // A panel that opted out without writing its own lines would be invisible
  // again — which is the bug this whole change exists to fix.
  for (const { file } of MUST_BE_AUDITED) {
    assert.doesNotMatch(read(file), /alsoLog: false/, `${file} must not opt out of the log mirror`);
  }
});
