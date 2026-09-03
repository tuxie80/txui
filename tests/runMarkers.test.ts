/**
 * The run-marker translation layer (utils/runMarkers.ts), tested the way the
 * gutter consumes it: split the doc, filter blank statements, marker on the
 * line of each statement's first non-whitespace char — exactly what
 * markerMap() in SqlEditor.tsx does with the runs array this module returns.
 *
 * The accumulating model: a tab keeps stmtRuns (statement index → outcome).
 * Single ⌘↵ runs update one entry; script runs drive the gutter from their
 * lines and replace the map; a single run after a script run folds the
 * script's finished markers in first, so nothing vanishes until its own
 * statement is re-run or the buffer is edited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldScriptInto, nextRunTick, runningIndex, runStamp, scriptLinesToRuns, spinnerFrame,
  statementIndexAt, stmtRunsToRuns, tickElapsed, timingLine,
} from '../src/utils/runMarkers.ts';
import type { StmtRunMap } from '../src/utils/runMarkers.ts';
import { fmtDurationCompact } from '../src/utils/fmtDuration.ts';
import { splitStatements } from '../src/utils/sqlSplit.ts';
import type { StatementRun } from '../src/components/SqlEditor.ts';

const DOC = '-- a comment\nSELECT 1;\n\nSELECT 2;\nSELECT 3;\n';

/** The gutter's placement rule, mirrored: statement i's marker line number. */
function markerLine(doc: string, stmtIndex: number): number {
  const stmts = splitStatements(doc, ';').filter(x => x.text.trim());
  const s = stmts[stmtIndex];
  const at = s.from + (s.text.length - s.text.trimStart().length);
  return doc.slice(0, at).split('\n').length;
}

/** Line numbers that would carry a visible (non-skipped) marker. */
function visibleMarkerLines(doc: string, runs: StatementRun[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].status !== 'skipped') out.push(markerLine(doc, i));
  }
  return out;
}

test('offset → statement index, on the gutter’s enumeration (resolved at run time)', () => {
  const stmts = splitStatements(DOC, ';').filter(x => x.text.trim());
  assert.equal(stmts.length, 3);
  assert.equal(statementIndexAt(DOC, stmts[0].from), 0);
  assert.equal(statementIndexAt(DOC, stmts[1].from), 1);
  assert.equal(statementIndexAt(DOC, stmts[2].from), 2);
  // an offset inside a statement resolves to that statement
  assert.equal(statementIndexAt(DOC, stmts[1].from + 3), 1);
  // leading whitespace/comments before statement 1
  assert.equal(statementIndexAt(DOC, 0), 0);
  // a stale offset past the end (buffer was edited) clamps to the last one
  assert.equal(statementIndexAt(DOC, 9999), 2);
  // no statements at all
  assert.equal(statementIndexAt('', 0), -1);
  assert.equal(statementIndexAt('\n\n', 0), -1);
});

test('custom delimiter is honoured in the translation', () => {
  const doc = 'SELECT 1\nGO\nSELECT 2\nGO\n';
  const stmts = splitStatements(doc, 'GO').filter(x => x.text.trim());
  assert.equal(stmts.length, 2);
  assert.equal(statementIndexAt(doc, stmts[1].from, 'GO'), 1);
});

// ── script runs ──────────────────────────────────────────────────────────────

test('a script run maps one marker per statement, pending invisible', () => {
  const runs = scriptLinesToRuns([
    { status: 'ok', ms: 12 },
    { status: 'error', ms: 340 },
    { status: 'pending' },
  ]);
  assert.deepEqual(runs.map(r => r.status), ['ok', 'error', 'skipped']);
  assert.equal(runs[0].ms, 12);
  // statements 1 and 2 visible — statement 1's marker sits on line 1 because
  // the splitter attaches its leading comment; statement 2 follows a blank line
  assert.deepEqual(visibleMarkerLines(DOC, runs), [1, 4]);
});

// ── the accumulator: sequential single runs ──────────────────────────────────

test('run stmt 1, then stmt 2: BOTH markers stay, with their own times', () => {
  let acc: StmtRunMap = {};
  acc = { ...acc, 0: { status: 'ok', ms: 87 } };        // ⌘↵ on statement 1
  acc = { ...acc, 1: { status: 'ok', ms: 2031 } };      // ⌘↵ on statement 2
  const runs = stmtRunsToRuns(acc)!;
  assert.deepEqual(runs.map(r => `${r.status}:${r.ms}`), ['ok:87', 'ok:2031']);
  // statement 1's chip on the comment-attached line 1, statement 2's on line 4
  assert.deepEqual(visibleMarkerLines(DOC, runs), [1, 4]);
});

test('re-running one statement updates only its own entry', () => {
  let acc: StmtRunMap = { 0: { status: 'ok', ms: 87 }, 1: { status: 'ok', ms: 2031 } };
  acc = { ...acc, 0: { status: 'running' } };           // stmt 1 re-run starts
  let runs = stmtRunsToRuns(acc)!;
  assert.deepEqual(runs.map(r => `${r.status}:${r.ms ?? ''}`), ['running:', 'ok:2031'],
    'statement 2 keeps its chip and time while statement 1 re-runs');
  acc = { ...acc, 0: { status: 'ok', ms: 64 } };        // stmt 1 finishes
  runs = stmtRunsToRuns(acc)!;
  assert.deepEqual(runs.map(r => `${r.status}:${r.ms}`), ['ok:64', 'ok:2031']);
});

test('a failed single run marks red on its own line, others untouched', () => {
  const acc: StmtRunMap = { 0: { status: 'ok', ms: 87 }, 2: { status: 'error', ms: 5 } };
  const runs = stmtRunsToRuns(acc)!;
  assert.deepEqual(runs.map(r => r.status), ['ok', 'skipped', 'error']);
  assert.deepEqual(visibleMarkerLines(DOC, runs), [1, 5]);
});

test('a running single statement shows the spinner state immediately', () => {
  const runs = stmtRunsToRuns({ 0: { status: 'running' } });
  assert.deepEqual(runs?.map(r => r.status), ['running']);
});

test('an empty accumulator means no gutter at all', () => {
  assert.equal(stmtRunsToRuns({}), undefined);
});

// ── script run ↔ single run interplay ────────────────────────────────────────

test('a single run after a script run folds the script’s finished markers in', () => {
  const script = [
    { status: 'ok' as const, ms: 2103 },
    { status: 'error' as const, ms: 340 },
    { status: 'ok' as const, ms: 8 },
  ];
  // ⌘↵ on statement 2: the script lines fold first, then entry 1 is replaced
  const acc = { ...foldScriptInto(script, {}), 1: { status: 'ok' as const, ms: 91 } };
  const runs = stmtRunsToRuns(acc)!;
  assert.deepEqual(runs.map(r => `${r.status}:${r.ms}`), ['ok:2103', 'ok:91', 'ok:8'],
    'statements 1 and 3 keep the script’s chips; statement 2 shows the new run');
});

test('the fold never overwrites a newer single-run entry', () => {
  const acc = foldScriptInto([{ status: 'ok', ms: 100 }], { 0: { status: 'error', ms: 3 } });
  assert.deepEqual(acc[0], { status: 'error', ms: 3 }, 'the accumulator’s entry is newer');
});

test('the fold skips unfinished script lines (pending/skipped/running)', () => {
  const acc = foldScriptInto(
    [{ status: 'ok', ms: 1 }, { status: 'pending' }, { status: 'skipped' }, { status: 'running' }],
    {});
  assert.deepEqual(Object.keys(acc), ['0']);
});

test('a script run replaces the accumulated entries (host clears stmtRuns)', () => {
  // The host side: script start sets stmtRuns {} and drives the gutter from
  // its lines — nothing accumulated survives.
  const runs = scriptLinesToRuns([
    { status: 'ok', ms: 1 }, { status: 'ok', ms: 1 }, { status: 'ok', ms: 1 },
  ]);
  assert.deepEqual(runs.map(r => r.ms), [1, 1, 1]);
});

// ── rerun transitions: old chips must RESET, not stick ───────────────────────
// The host drives these states through tab.scriptResults / tab.stmtRuns; the
// gutter repaints on every setStatementRuns effect (lineMarkerChange). Each
// step must produce content DISTINCT from the step before it — the QueryTabs
// memo keys on content, so a collision would silently keep the stale marker.

test('script rerun: every statement cycles running → fresh ms', () => {
  // run 1 finished: failed, ok, failed
  const done1 = scriptLinesToRuns(
    [{ status: 'error', ms: 340 }, { status: 'ok', ms: 12 }, { status: 'error', ms: 5 }]);
  assert.deepEqual(done1.map(r => `${r.status}:${r.ms}`), ['error:340', 'ok:12', 'error:5']);

  // rerun starts: the host resets all lines to pending → all markers clear
  const reset = scriptLinesToRuns(
    [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
  assert.deepEqual(reset.map(r => r.status), ['skipped', 'skipped', 'skipped'],
    'pending maps to invisible — the old chips must disappear at rerun start');

  // statement 1 runs: it alone shows the running marker
  const s1run = scriptLinesToRuns(
    [{ status: 'running' }, { status: 'pending' }, { status: 'pending' }]);
  assert.deepEqual(s1run.map(r => r.status), ['running', 'skipped', 'skipped']);

  // statement 1 finishes with a FRESH time, statement 2 starts ticking
  const s2run = scriptLinesToRuns(
    [{ status: 'ok', ms: 2103 }, { status: 'running' }, { status: 'pending' }]);
  assert.deepEqual(s2run.map(r => `${r.status}:${r.ms ?? ''}`),
    ['ok:2103', 'running:', 'skipped:']);

  // final state: every time was re-measured — nothing from run 1 survives
  const done2 = scriptLinesToRuns(
    [{ status: 'ok', ms: 2103 }, { status: 'ok', ms: 1105 }, { status: 'ok', ms: 2089 }]);
  assert.deepEqual(done2.map(r => `${r.status}:${r.ms}`), ['ok:2103', 'ok:1105', 'ok:2089']);
  for (let i = 0; i < 3; i++) assert.notEqual(done2[i].ms, done1[i].ms);
});

test('rerun with an IDENTICAL final ms still passes through a distinct running state', () => {
  // The one content-key collision that could stick: rerun measures the same ms.
  // It cannot stick, because the run goes through 'running' first — a different
  // array — so the editor always sees a transition.
  const before = stmtRunsToRuns({ 1: { status: 'ok', ms: 87 } })!;
  const during = stmtRunsToRuns({ 1: { status: 'running' } })!;
  const after = stmtRunsToRuns({ 1: { status: 'ok', ms: 87 } })!;
  const key = (rs: StatementRun[]) => rs.map(r => `${r.status}:${r.ms ?? ''}`).join('|');
  assert.notEqual(key(before), key(during));
  assert.notEqual(key(during), key(after));
});

test('single ⌘↵ rerun of one line: that marker resets and re-measures', () => {
  const first = stmtRunsToRuns({ 1: { status: 'ok', ms: 87 } })!;
  assert.deepEqual(visibleMarkerLines(DOC, first), [4]);

  // rerun starts: the marker flips to running (chip + old time gone)
  const running = stmtRunsToRuns({ 1: { status: 'running' } })!;
  assert.deepEqual(running.map(r => r.status), ['skipped', 'running']);
  assert.equal(running[1].ms, undefined, 'the stale ms must not survive the rerun');

  // finishes: fresh time on the same line
  const done = stmtRunsToRuns({ 1: { status: 'ok', ms: 91 } })!;
  assert.equal(done[1].ms, 91);
  assert.deepEqual(visibleMarkerLines(DOC, done), [4]);
});

test('the accumulator output does not depend on the document (edits cannot move it)', () => {
  // Regression guard for "deleted-then-retyped statements resurrect old
  // times": stmtRuns stores run-time INDICES, so none of these functions take
  // a document — there is nothing an edit could shift. The editor-side field
  // clears on docChanged (tests/runMarkersField.test.ts), and because this
  // output is index-stable the memo keeps returning the SAME array identity,
  // so no re-dispatch resurrects the markers.
  const a = stmtRunsToRuns({ 1: { status: 'ok', ms: 87 } })!;
  const b = stmtRunsToRuns({ 1: { status: 'ok', ms: 87 } })!;
  assert.deepEqual(a, b);
});

// ── the ticker (editor-side rising counter) ─────────────────────────────────

test('nextRunTick: starts when a statement starts running, stops when none does', () => {
  assert.equal(nextRunTick(null, [{ status: 'ok' }], 1000), null);
  const t = nextRunTick(null, [{ status: 'ok' }, { status: 'running' }], 1000);
  assert.deepEqual(t, { idx: 1, startedAt: 1000 });
});

test('nextRunTick: identity-stable while the SAME statement runs (no reset per tick)', () => {
  const t = nextRunTick(null, [{ status: 'running' }], 1000)!;
  assert.equal(nextRunTick(t, [{ status: 'running' }], 1125), t,
    'same object → the plugin knows nothing changed and does not restart the clock');
});

test('nextRunTick: the NEXT statement in a script restarts the clock', () => {
  const t1 = nextRunTick(null, [{ status: 'running' }, { status: 'pending' }], 1000)!;
  const t2 = nextRunTick(t1, [{ status: 'ok' }, { status: 'running' }], 3100);
  assert.deepEqual(t2, { idx: 1, startedAt: 3100 });
  assert.equal(tickElapsed(t2, 3100), 0);
  assert.equal(tickElapsed(t2, 5100), 2000, 'select sleep(2) counts to ~2000ms');
});

test('tickElapsed never goes negative (clock skew)', () => {
  assert.equal(tickElapsed({ idx: 0, startedAt: 5000 }, 4000), 0);
});

test('spinnerFrame cycles the six-dot braille frames with elapsed time', () => {
  assert.equal(spinnerFrame(0), '⠋');
  assert.equal(spinnerFrame(125), '⠙');
  assert.equal(spinnerFrame(250), '⠹');
  assert.equal(spinnerFrame(625), '⠴');
  assert.equal(spinnerFrame(750), '⠋', 'wraps after the sixth frame');
  assert.equal(spinnerFrame(2000), spinnerFrame(2000 % 750));
  for (const f of ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴']) {
    assert.equal(f.length, 1, 'single-width glyph — the gutter must not jitter');
  }
});

test('a run of N ticks visibly advances both the frame and the ms text', () => {
  // The ticker loop as the plugin drives it (injected clock): start at
  // t=1000, tick every 125 ms — the rendered spinner frame and elapsed text
  // must change on (nearly) every tick, never freeze on the first frame.
  const tick = nextRunTick(null, [{ status: 'running' }], 1000)!;
  const frames: string[] = [];
  const texts: string[] = [];
  for (let n = 0; n <= 16; n++) {
    const elapsed = tickElapsed(tick, 1000 + n * 125);
    frames.push(spinnerFrame(elapsed));
    texts.push(fmtDurationCompact(elapsed));
  }
  assert.deepEqual(frames.slice(0, 6), ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴']);
  assert.equal(new Set(frames).size, 6, 'all six frames cycle over 16 ticks');
  assert.equal(texts[0], '0ms');
  assert.equal(texts[1], '125ms');
  assert.equal(texts[8], '1.0s');
  assert.equal(texts[16], '2.0s', 'select sleep(2) ends its count at ~2.0s');
});

// ── auto-scroll trigger: running-index transitions ───────────────────────────
// SqlEditor scrolls the running statement's first line into view exactly when
// this index CHANGES (y: 'nearest' — an already-visible line never scrolls).
// These are the sequences the listener must see.

test('runningIndex: a script advance is one transition per statement', () => {
  const seq = [
    [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }],
    [{ status: 'running' }, { status: 'pending' }, { status: 'pending' }],
    [{ status: 'ok' }, { status: 'running' }, { status: 'pending' }],
    [{ status: 'ok' }, { status: 'ok' }, { status: 'running' }],
    [{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }],
  ];
  assert.deepEqual(seq.map(runningIndex), [-1, 0, 1, 2, -1],
    'scroll fires on 0, 1, 2 — and on the -1 edges it does nothing');
});

test('runningIndex: a single run is one transition, then back to nothing', () => {
  assert.equal(runningIndex([{ status: 'skipped' }, { status: 'running' }]), 1);
  assert.equal(runningIndex([{ status: 'skipped' }, { status: 'ok' }]), -1);
  assert.equal(runningIndex([]), -1);
});

test('runningIndex: repeated reads of the same runs do not retrigger', () => {
  // The listener compares against the last index it saw — identical input
  // must yield identical output, or every tick would scroll.
  const runs = [{ status: 'ok' }, { status: 'running' }];
  assert.equal(runningIndex(runs), 1);
  assert.equal(runningIndex(runs), 1);
});

// ── selection script runs: markers bind to the lines that RAN ───────────────
// A run over statements 2–3 of a 4-statement buffer must mark lines 2–3, not
// 1–2: the host resolves the base index at run start (tab.scriptBase) and
// scriptLinesToRuns shifts the lines by it.

const DOC4 = 'SELECT 1;\nSELECT 2;\nSELECT 3;\nSELECT 4;\n';

test('a selection run of statements 2–3 (base=1) marks exactly those lines', () => {
  const lines = [
    { status: 'ok' as const, ms: 100 },
    { status: 'ok' as const, ms: 200 },
  ];
  const runs = scriptLinesToRuns(lines, 1);
  assert.deepEqual(runs.map(r => `${r.status}:${r.ms ?? ''}`),
    ['skipped:', 'ok:100', 'ok:200'],
    'buffer statement 0 is an invisible placeholder, the run starts at index 1');
  // SELECT 2 is line 2, SELECT 3 is line 3 — NOT lines 1–2
  assert.deepEqual(visibleMarkerLines(DOC4, runs), [2, 3]);
});

test('base=0 (whole-buffer run) is unchanged', () => {
  const runs = scriptLinesToRuns(
    [{ status: 'ok', ms: 1 }, { status: 'ok', ms: 2 }], 0);
  assert.deepEqual(runs.map(r => r.ms), [1, 2]);
  assert.deepEqual(visibleMarkerLines(DOC4, runs), [1, 2]);
});

test('re-running a different selection moves the markers', () => {
  const first = scriptLinesToRuns([{ status: 'ok', ms: 10 }], 0);
  assert.deepEqual(visibleMarkerLines(DOC4, first), [1]);
  const second = scriptLinesToRuns([{ status: 'ok', ms: 20 }, { status: 'ok', ms: 30 }], 2);
  assert.deepEqual(visibleMarkerLines(DOC4, second), [3, 4]);
});

test('a base at/past the last statement is still safe (clamped at run time)', () => {
  // statementIndexAt clamps the offset; even a raw oversized base only pads.
  assert.equal(statementIndexAt(DOC4, 9999), 3);
  const runs = scriptLinesToRuns([{ status: 'ok', ms: 5 }], 3);
  assert.equal(runs.length, 4);
  assert.deepEqual(visibleMarkerLines(DOC4, runs), [4]);
});

test('a selection starting MID-LINE resolves to the right statement', () => {
  // 'select 1; select 2;' on one line — the selection's first char is the
  // second statement's start, mid-line.
  const doc = 'select 1; select 2;\nselect 3;\n';
  const from = doc.indexOf('select 2');
  assert.equal(statementIndexAt(doc, from), 1);
  // …and leading partial text on the line does not count as a statement start
  const runs = scriptLinesToRuns([{ status: 'ok', ms: 7 }], 1);
  assert.deepEqual(visibleMarkerLines(doc, runs), [1],
    'statement 2 starts mid-line-1 — its marker goes on line 1');
});

test('selection script run: error mid-selection binds to its own line', () => {
  const runs = scriptLinesToRuns(
    [{ status: 'ok', ms: 100 }, { status: 'error', ms: 12 }], 1);
  assert.deepEqual(runs.map(r => r.status), ['skipped', 'ok', 'error']);
  assert.deepEqual(visibleMarkerLines(DOC4, runs), [2, 3]);
});

// ── startedAt: the hover tooltip's "when did this run" stamp ────────────────

test('startedAt survives every translation the gutter array goes through', () => {
  const t = Date.UTC(2026, 7, 25, 22, 54, 4);
  // script lines → runs
  const fromScript = scriptLinesToRuns([{ status: 'ok', ms: 12, startedAt: t }]);
  assert.equal(fromScript[0].startedAt, t);
  // script lines folded into the accumulator → runs
  const folded = foldScriptInto([{ status: 'ok', ms: 12, startedAt: t }], {});
  assert.deepEqual(folded[0], { status: 'ok', ms: 12, startedAt: t });
  const fromAcc = stmtRunsToRuns(folded)!;
  assert.equal(fromAcc[0].startedAt, t);
  // a run without a start time simply has none (old state, pads)
  assert.equal(scriptLinesToRuns([{ status: 'ok', ms: 1 }])[0].startedAt, undefined);
  assert.equal(stmtRunsToRuns({ 1: { status: 'ok', ms: 1 } })![0].startedAt, undefined);
});

test('runStamp renders the canonical log-line prefix in local time', () => {
  const t = new Date(2026, 7, 25, 22, 54, 4).getTime();  // local components
  assert.equal(runStamp(t), '[2026-08-25 22:54:04]');
  assert.match(runStamp(Date.now()), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
});

// ── timingLine: the marker context menu's "Copy timing line" ────────────────

test('timingLine renders stamp, one-line SQL, status and ms like a log line', () => {
  const t = new Date(2026, 7, 25, 22, 54, 4).getTime();
  assert.equal(
    timingLine({ status: 'ok', ms: 1012, startedAt: t }, 'SELECT *\nFROM   users'),
    '[2026-08-25 22:54:04] SELECT * FROM users → ok · 1012 ms',
  );
  assert.equal(
    timingLine({ status: 'error', ms: 3, startedAt: t }, 'DELETE FROM t'),
    '[2026-08-25 22:54:04] DELETE FROM t → error · 3 ms',
  );
});

test('timingLine omits the stamp when the run never recorded a start time', () => {
  assert.equal(timingLine({ status: 'ok', ms: 42 }, 'SELECT 1'), 'SELECT 1 → ok · 42 ms');
});

test('timingLine refuses runs without a timing (that is what Copy SQL is for)', () => {
  assert.equal(timingLine({ status: 'running', startedAt: 1 }, 'SELECT 1'), null);
  assert.equal(timingLine({ status: 'skipped' }, 'SELECT 1'), null);
  assert.equal(timingLine({ status: 'ok' }, 'SELECT 1'), null);
});

test('timingLine caps a huge statement rather than flooding the clipboard', () => {
  const line = timingLine({ status: 'ok', ms: 1 }, 'SELECT ' + 'x'.repeat(500))!;
  assert.ok(line.endsWith('… → ok · 1 ms'));
  assert.ok(line.length < 230, `got ${line.length} chars`);
});

// ── hasPlan / stats: background enrichments riding the same entry ────────────
// Auto-EXPLAIN and the digest lookup land AFTER the run's own entry — they
// patch the same stmtRuns entry, and stmtRunsToRuns must carry both through to
// the gutter array (the QueryTabs memo key includes them, so a landing badge or
// tooltip stat re-dispatches the markers).

test('hasPlan and stats pass through stmtRunsToRuns to the gutter array', () => {
  const runs = stmtRunsToRuns({
    0: { status: 'ok', ms: 6400, hasPlan: true },
    2: { status: 'ok', ms: 210, stats: { runs: 41, p95Ms: 1200 } },
  })!;
  assert.equal(runs[0].hasPlan, true);
  assert.equal(runs[1].hasPlan, undefined, 'the skipped pad carries nothing');
  assert.deepEqual(runs[2].stats, { runs: 41, p95Ms: 1200 });
  assert.equal(runs[2].hasPlan, undefined, 'no plan badge until the fetch landed');
});

test('hasPlan/stats change the marker content (memo keys must not swallow them)', () => {
  // The QueryTabs run-marker memo keys on a content string; these two arrays
  // differ ONLY in the enrichment, so the key must differ too — otherwise the
  // badge would never appear until the next unrelated run.
  const key = (rs: StatementRun[]) => rs.map(r =>
    `${r.status}:${r.ms ?? ''}:${r.hasPlan ? 'P' : ''}:${r.stats ? `${r.stats.runs}x${r.stats.p95Ms}` : ''}`
  ).join('|');
  const plain = stmtRunsToRuns({ 0: { status: 'ok', ms: 6400 } })!;
  const planned = stmtRunsToRuns({ 0: { status: 'ok', ms: 6400, hasPlan: true } })!;
  const stated = stmtRunsToRuns({ 0: { status: 'ok', ms: 6400, stats: { runs: 3, p95Ms: 900 } } })!;
  assert.notEqual(key(plain), key(planned));
  assert.notEqual(key(plain), key(stated));
});
