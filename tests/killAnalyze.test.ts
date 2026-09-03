/**
 * Rules behind the `kill …` / `killall` popup (src/utils/killAnalyze.ts).
 * Dependency-free: `npm test` runs these through node:test + Node's built-in
 * TypeScript type stripping — no test framework, no build step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKillTrigger, digest, oneLine, trackHistory, aged, families,
  recommend, matchProc, orderProcs, killable, isIdle, isIdleInTrx, killLogLine,
  noVerdictReason, mergeRows, compareRows, procRank,
} from '../src/utils/killAnalyze.ts';
import type { ProcInfo, History, RowState } from '../src/utils/killAnalyze.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────

function proc(over: Partial<ProcInfo> = {}): ProcInfo {
  return {
    id: 1, user: 'app_rw', host: '10.0.0.5:4711', db: 'shop', command: 'Query',
    time: 30, state: 'Sending data', info: 'SELECT * FROM orders WHERE id = 42',
    trxAge: -1, rowsLocked: 0, trxState: '', blocking: [], blockedBy: [],
    isSelf: false, isSystem: false, ...over,
  };
}

/**
 * N members of one family, ages stepping down from `oldest`.
 * `idBase` keeps two families in one test from sharing thread ids (history is
 * keyed by id, so a collision would make the fixture lie).
 */
function family(
  n: number,
  oldest = 60,
  over: Partial<ProcInfo> = {},
  { step = 3, idBase = 100 }: { step?: number; idBase?: number } = {},
): ProcInfo[] {
  return Array.from({ length: n }, (_, i) => proc({
    id: idBase + i,
    time: Math.max(0, oldest - i * step),
    info: `SELECT /* slot=${i} */ SLEEP(300)`,
    ...over,
  }));
}

// ── the editor trigger ────────────────────────────────────────────────────────

test('kill opens only once there is a separator after the keyword', () => {
  assert.equal(parseKillTrigger('kill'), null, 'still typing the word');
  assert.equal(parseKillTrigger('killi'), null);
  assert.equal(parseKillTrigger('kil '), null);
  const t = parseKillTrigger('kill ');
  assert.ok(t);
  assert.equal(t.kind, 'kill');
  assert.equal(t.filter, '');
  assert.equal(t.mode, 'connection', 'bare KILL drops the connection in MySQL');
});

test('killall is complete on its own and defaults to the gentler kill', () => {
  const t = parseKillTrigger('killall');
  assert.ok(t);
  assert.equal(t.kind, 'killall');
  assert.equal(t.mode, 'query');
  assert.equal(parseKillTrigger('killall app_rw')?.filter, 'app_rw');
});

test('the qualifier picks the mode', () => {
  assert.equal(parseKillTrigger('kill query ')?.mode, 'query');
  assert.equal(parseKillTrigger('kill connection ')?.mode, 'connection');
  assert.equal(parseKillTrigger('KILL QUERY 4711')?.mode, 'query');
  assert.equal(parseKillTrigger('KILL QUERY 4711')?.filter, '4711');
});

test('typed text becomes the filter, digits included', () => {
  assert.equal(parseKillTrigger('kill 47')?.filter, '47');
  assert.equal(parseKillTrigger('kill app')?.filter, 'app');
  assert.equal(parseKillTrigger('kill  ')?.filter, '');
});

test('it stays shut when kill is not the statement', () => {
  assert.equal(parseKillTrigger("SELECT 'kill '"), null);
  assert.equal(parseKillTrigger('-- kill 5'), null);
  assert.equal(parseKillTrigger('# kill 5'), null);
  assert.equal(parseKillTrigger('SELECT * FROM kill '), null);
  assert.equal(parseKillTrigger('overkill '), null);
});

test('it opens after a statement separator or a new line', () => {
  assert.ok(parseKillTrigger('SELECT 1;\nkill '));
  assert.ok(parseKillTrigger('SELECT 1; kill 12'));
  const t = parseKillTrigger('SELECT 1;\nkill 12');
  assert.ok(t);
  // offsets point at the keyword, so ⇧⏎ replaces exactly the command
  assert.equal('SELECT 1;\nkill 12'.slice(t.from, t.to), 'kill 12');
});

// ── digest ───────────────────────────────────────────────────────────────────

test('digest folds literals, comments and whitespace', () => {
  assert.equal(
    digest("SELECT  *\nFROM orders /* app=web */ WHERE id = 42 AND name = 'bob'"),
    'select * from orders where id = ? and name = ?');
  assert.equal(digest('SELECT 1 -- trailing'), 'select ?');
});

test('digest makes copies of one statement identical', () => {
  const a = digest('SELECT /* txui-playground mess rogue slot=1 */ SLEEP(30.00)');
  const b = digest('SELECT /* txui-playground mess rogue slot=7 */ SLEEP(30.00)');
  assert.equal(a, b);
  assert.notEqual(a, digest('SELECT pg_sleep(30)'));
});

test('digest collapses IN lists so arity does not split a family', () => {
  assert.equal(digest('SELECT * FROM t WHERE id IN (1,2,3)'),
               digest('SELECT * FROM t WHERE id IN (9, 8)'));
});

test('oneLine flattens and caps', () => {
  assert.equal(oneLine('  a\n  b  '), 'a b');
  assert.equal(oneLine('x'.repeat(50), 10).length, 10);
  assert.ok(oneLine('x'.repeat(50), 10).endsWith('…'));
});

// ── history / growth ─────────────────────────────────────────────────────────

test('a thread that keeps its statement and ages is growing', () => {
  const hist: History = new Map();
  trackHistory(hist, [proc({ id: 7, time: 10 })], 1_000);
  assert.equal(aged(hist, 7), null, 'one sample proves nothing');
  assert.equal(hist.get(7)!.growing, false);

  trackHistory(hist, [proc({ id: 7, time: 13 })], 2_000);
  assert.equal(hist.get(7)!.growing, true);
  assert.equal(aged(hist, 7), 3);
  assert.equal(hist.get(7)!.samples, 2);
});

test('a new statement on the same thread resets history, it is not growth', () => {
  const hist: History = new Map();
  trackHistory(hist, [proc({ id: 7, time: 10, info: 'SELECT a' })], 1_000);
  trackHistory(hist, [proc({ id: 7, time: 2, info: 'SELECT b' })], 2_000);
  const h = hist.get(7)!;
  assert.equal(h.samples, 1);
  assert.equal(h.growing, false);
  assert.equal(aged(hist, 7), null);
});

test('history forgets threads that stopped showing up', () => {
  const hist: History = new Map();
  trackHistory(hist, [proc({ id: 7 })], 1_000);
  trackHistory(hist, [proc({ id: 8 })], 1_000 + 400_000);
  assert.equal(hist.has(7), false);
  assert.equal(hist.has(8), true);
});

// ── families ─────────────────────────────────────────────────────────────────

test('same user + db + digest is one family, different user is not', () => {
  const fams = families([
    ...family(3),
    proc({ id: 200, user: 'reports', info: 'SELECT /* slot=0 */ SLEEP(300)' }),
    proc({ id: 201, info: 'SELECT 1' }),
  ]);
  assert.equal(fams[0].procs.length, 3);
  assert.equal(fams[0].user, 'app_rw');
  assert.equal(fams.length, 3);
});

test('threads with no statement text form no family', () => {
  assert.equal(families([proc({ id: 1, info: '' }), proc({ id: 2, info: '' })]).length, 0);
});

test('families count how many members were watched ageing', () => {
  const hist: History = new Map();
  const first = family(2, 40);
  trackHistory(hist, first, 1_000);
  trackHistory(hist, family(2, 45), 2_000);
  assert.equal(families(first, hist)[0].growing, 2);
});

// ── recommend ────────────────────────────────────────────────────────────────

test('nothing worth killing → no recommendation', () => {
  assert.equal(recommend([]), null);
  assert.equal(recommend([proc({ time: 1, info: 'SELECT 1' })]), null);
  assert.equal(recommend([proc({ command: 'Sleep', time: 900, info: '' })]), null,
    'an idle connection has nothing to abort');
});

test('the blocker wins over its victims', () => {
  const holder = proc({ id: 10, time: 90, blocking: [11, 12], trxAge: 95, rowsLocked: 3 });
  const waiters = [
    proc({ id: 11, time: 40, blockedBy: [10], state: 'updating' }),
    proc({ id: 12, time: 20, blockedBy: [10], state: 'updating' }),
  ];
  const r = recommend([...waiters, holder]);
  assert.ok(r);
  assert.deepEqual(r.ids, [10], 'kill the cause, not the queue');
  assert.deepEqual(r.blockers, [10]);
  assert.equal(r.confidence, 'high');
  assert.match(r.headline, /blocker/);
  assert.ok(r.reasons.some(x => x.includes('#11')));
});

test('an idle-in-transaction blocker needs the connection killed', () => {
  const r = recommend([
    proc({ id: 10, command: 'Sleep', time: 300, info: '', trxAge: 300, blocking: [11] }),
    proc({ id: 11, time: 40, blockedBy: [10] }),
  ]);
  assert.ok(r);
  assert.equal(r.mode, 'connection', 'KILL QUERY would abort nothing');
  assert.ok(r.reasons.some(x => /idle inside an open transaction/.test(x)));
});

test('independent blockers are ranked by how many threads they hold', () => {
  const r = recommend([
    proc({ id: 10, time: 50, blocking: [12] }),
    proc({ id: 11, time: 20, blocking: [13, 14, 15] }),
    proc({ id: 12, time: 10, blockedBy: [10] }),
  ]);
  assert.deepEqual(r!.ids, [11, 10]);
});

test('in a lock queue only the ROOT is a cause, not the waiters behind it', () => {
  // What MySQL actually reports for one holder + a queue of three waiters:
  // every queue member is listed as blocking the ones behind it.
  const r = recommend([
    proc({ id: 45, time: 60, blocking: [46, 47, 48], rowsLocked: 1 }),
    proc({ id: 46, time: 55, blocking: [47, 48], blockedBy: [45] }),
    proc({ id: 47, time: 50, blocking: [48], blockedBy: [45, 46] }),
    proc({ id: 48, time: 45, blockedBy: [45, 46, 47] }),
  ]);
  assert.ok(r);
  assert.deepEqual(r.ids, [45], 'only #45 waits for nobody');
  assert.match(r.headline, /^root blocker holding 3 threads hostage$/);
  assert.ok(r.reasons.some(x => /#46, #47 also appear to block others, but they are waiting themselves/.test(x)));
  assert.deepEqual(r.blockers, [45, 46, 47], 'the full set is still reported');
});

test('a wait cycle is called a deadlock and breaks on the oldest', () => {
  const r = recommend([
    proc({ id: 1, time: 30, blocking: [2], blockedBy: [2] }),
    proc({ id: 2, time: 90, blocking: [1], blockedBy: [1] }),
  ]);
  assert.ok(r);
  assert.match(r.headline, /deadlock cycle between 2 threads/);
  assert.deepEqual(r.ids, [2], 'oldest breaks the cycle');
  assert.equal(r.confidence, 'medium');
  assert.ok(r.reasons.some(x => /has not broken yet/.test(x)));
});

test('a rogue family is recommended whole, oldest first', () => {
  const r = recommend(family(4, 60));
  assert.ok(r);
  assert.deepEqual(r.ids, [100, 101, 102, 103]);
  assert.equal(r.mode, 'query');
  assert.match(r.headline, /rogue family: 4×/);
  assert.equal(r.confidence, 'medium', 'not yet watched across two polls');
  assert.ok(r.reasons.some(x => /SAME statement/.test(x)));
});

test('watching the family age raises confidence and says so', () => {
  const hist: History = new Map();
  trackHistory(hist, family(3, 40), 1_000);
  const second = family(3, 47);
  trackHistory(hist, second, 2_000);
  const r = recommend(second, hist);
  assert.ok(r);
  assert.equal(r.confidence, 'high');
  assert.ok(r.reasons.some(x => /aged \+7s while this popup watched/.test(x)));
});

test('a growing family beats a bigger but static one', () => {
  const hist: History = new Map();
  const stuck = (age: number) => family(2, age, { user: 'stuck_user' }, { idBase: 100 });
  const churn = family(3, 30, { user: 'churn_user' }, { idBase: 200 });
  trackHistory(hist, [...stuck(50), ...churn], 1_000);
  // only `stuck` ages on the next poll — churn's threads sit at the same TIME
  trackHistory(hist, [...stuck(58), ...churn], 2_000);
  const r = recommend([...stuck(58), ...churn], hist);
  assert.ok(r);
  assert.match(r.headline, /rogue family: 2×/);
  assert.deepEqual(r.ids, [100, 101]);
});

test('young threads are below the bar until they are seen ageing', () => {
  const young = family(5, 3, {}, { step: 0 });
  assert.equal(recommend(young), null, 'one glance at young threads proves nothing');
  assert.ok(recommend(young, new Map(), { minAge: 1 }));
});

test('a young family that ages across two polls is flagged immediately', () => {
  // The case that matters in practice: you spawn a mess and type `killall`
  // straight away — waiting 5s for the age bar made the verdict useless.
  const hist: History = new Map();
  trackHistory(hist, family(4, 2, {}, { step: 0 }), 1_000);
  const second = family(4, 3, {}, { step: 0 });
  trackHistory(hist, second, 2_000);
  const r = recommend(second, hist);
  assert.ok(r, 'four threads on one statement, all ageing, is enough');
  assert.equal(r.ids.length, 4);
  assert.equal(r.confidence, 'high');
  assert.ok(r.reasons.some(x => /flagged because they are ageing together/.test(x)),
    'and it says why, since they are younger than the age bar');
});

test('a single young thread ageing is still not a family', () => {
  const hist: History = new Map();
  trackHistory(hist, [proc({ id: 1, time: 2 })], 1_000);
  trackHistory(hist, [proc({ id: 1, time: 3 })], 2_000);
  assert.equal(recommend([proc({ id: 1, time: 3 })], hist), null);
});

// ── the empty verdict explains itself ────────────────────────────────────────

test('no backends at all says so', () => {
  assert.match(noVerdictReason([]), /no other client backends/);
  assert.match(noVerdictReason([proc({ isSelf: true })]), /no other client backends/);
});

test('all-idle says so', () => {
  assert.match(noVerdictReason([proc({ command: 'Sleep', info: '' })]),
    /All 1 backend\(s\) are idle/);
});

test('a family below the bar is named with its real numbers', () => {
  const why = noVerdictReason(family(3, 4, {}, { step: 0 }));
  assert.match(why, /biggest family is 3×/);
  assert.match(why, /oldest 4s, 0 seen ageing/);
  assert.match(why, /needs either 5s of age or two members watched ageing/);
});

test('unique statements are called out as such', () => {
  const why = noVerdictReason([
    proc({ id: 1, time: 3, info: 'SELECT a FROM t' }),
    proc({ id: 2, time: 2, info: 'SELECT b FROM u' }),
  ]);
  assert.match(why, /Every running statement is unique/);
  assert.match(why, /Oldest running statement: 3s/);
});

test('a lone old statement is reported with low confidence', () => {
  const r = recommend([proc({ id: 5, time: 900, info: 'SELECT * FROM huge' })]);
  assert.ok(r);
  assert.deepEqual(r.ids, [5]);
  assert.equal(r.confidence, 'low');
  assert.match(r.headline, /one long statement/);
  assert.ok(r.reasons.some(x => /often legitimate/.test(x)));
});

test('an old idle transaction is the last resort finding', () => {
  const r = recommend([proc({ id: 5, command: 'Sleep', time: 5, info: '', trxAge: 600, rowsLocked: 12 })]);
  assert.ok(r);
  assert.equal(r.mode, 'connection');
  assert.match(r.headline, /idle transaction open 10m0s/);
  assert.ok(r.reasons.some(x => /12 locked rows/.test(x)));
});

test('our own connection and the server’s threads are never recommended', () => {
  const r = recommend([
    proc({ id: 1, isSelf: true, time: 900, blocking: [2] }),
    proc({ id: 3, isSystem: true, time: 999_999, command: 'Daemon', info: '' }),
    proc({ id: 4, isSystem: true, time: 500, blocking: [5] }),
  ]);
  assert.equal(r, null);
  assert.deepEqual(killable([proc({ id: 1 }), proc({ id: 2, isSelf: true })]).map(p => p.id), [1]);
});

test('idle classification covers both engines’ vocabulary', () => {
  assert.ok(isIdle(proc({ command: 'Sleep' })));
  assert.ok(isIdle(proc({ command: 'idle' })));
  assert.ok(!isIdle(proc({ command: 'Query' })));
  assert.ok(isIdleInTrx(proc({ command: 'idle in transaction', trxAge: 10 })));
  assert.ok(!isIdleInTrx(proc({ command: 'idle in transaction', trxAge: -1 })));
});

// ── logging ──────────────────────────────────────────────────────────────────

test('a kill logs everything known about the victim, on one line', () => {
  const line = killLogLine({
    id: 4711, mode: 'connection', statement: 'KILL 4711', ok: true, source: 'killall',
    agedSecs: 7,
    proc: proc({
      id: 4711, user: 'app_rw', host: '10.0.0.5:4711', db: 'shop', command: 'Query',
      state: 'Sending data', time: 63, trxAge: 65, rowsLocked: 3, blocking: [4712, 4713],
      info: 'SELECT *\n  FROM orders WHERE id = 42',
    }),
  });
  assert.ok(!line.includes('\n'), 'must stay a one-liner');
  for (const fragment of [
    'KILL #4711', 'ok', 'app_rw@10.0.0.5:4711', 'db=shop', 'Query/Sending data 63s aged +7s',
    'trx 65s, 3 rows locked', 'was blocking #4712,#4713',
    'SELECT * FROM orders WHERE id = 42', 'issued: KILL 4711', 'via killall',
  ]) assert.ok(line.includes(fragment), `missing "${fragment}" in: ${line}`);
});

test('a failed kill logs the reason, and an unknown thread says so', () => {
  const failed = killLogLine({
    id: 99, mode: 'query', statement: 'KILL QUERY 99', ok: false,
    error: 'Unknown thread id: 99', source: 'kill',
  });
  assert.match(failed, /^KILL QUERY #99 · FAILED: Unknown thread id: 99/);
  assert.match(failed, /not in the last poll/);
});

test('a kill of an idle connection still logs the transaction it held', () => {
  const line = killLogLine({
    id: 8, mode: 'connection', statement: 'KILL 8', ok: true,
    proc: proc({ id: 8, command: 'Sleep', state: '', time: 300, trxAge: 320, info: '' }),
  });
  assert.ok(line.includes('trx 320s'));
  assert.ok(line.includes('(no statement)'));
});

// ── filter / order ───────────────────────────────────────────────────────────

test('digits filter by id prefix, text searches every column', () => {
  const p = proc({ id: 4711, user: 'app_rw', db: 'shop', info: 'SELECT * FROM orders' });
  assert.ok(matchProc(p, '47'));
  assert.ok(!matchProc(p, '48'));
  assert.ok(matchProc(p, 'app'));
  assert.ok(matchProc(p, 'ORDERS'), 'case-insensitive');
  assert.ok(matchProc(p, ''), 'empty filter matches everything');
});

test('order: killable by age first, own and system threads last', () => {
  const rows = orderProcs([
    proc({ id: 1, time: 5 }),
    proc({ id: 2, isSelf: true, time: 999 }),
    proc({ id: 3, isSystem: true, time: 999_999 }),
    proc({ id: 4, time: 50 }),
  ]);
  assert.deepEqual(rows.map(p => p.id), [4, 1, 3, 2]);
});

test('order applies the filter', () => {
  const rows = orderProcs([proc({ id: 1, user: 'a' }), proc({ id: 2, user: 'b' })], 'b');
  assert.deepEqual(rows.map(p => p.id), [2]);
});

// ── the popup's row list ──────────────────────────────────────────────────────

const M = { first: false, goneKeep: 30, max: 300 };
const rowsOf = (rs: RowState[]) => rs.map(r => `${r.id}${r.gone ? '✕' : ''}`);

test('the first poll of a viewing session is authoritative and age-ordered', () => {
  // What was on screen came from a cached snapshot — including two threads the
  // user killed in the PREVIOUS run. None of it may survive.
  const stale: RowState[] = [
    { id: 900, proc: proc({ id: 900, time: 999 }), gone: false },   // killed last run
    { id: 901, proc: proc({ id: 901, time: 998 }), gone: true },    // already dead
  ];
  const live = [proc({ id: 5, time: 3 }), proc({ id: 6, time: 40 })];
  const rows = mergeRows(stale, live, { ...M, first: true });
  assert.deepEqual(rowsOf(rows), ['6', '5'], 'rebuilt from the server, oldest first');
});

test('a thread that dies while you watch stays listed, but sinks below the live ones', () => {
  const live = [proc({ id: 1, time: 50 }), proc({ id: 2, time: 40 }), proc({ id: 3, time: 30 })];
  const first = mergeRows([], live, { ...M, first: true });
  assert.deepEqual(rowsOf(first), ['1', '2', '3']);
  // #2 is killed: you still see it (✕), but it no longer holds a place at the top
  const after = mergeRows(first, [live[0], live[2]], M);
  assert.deepEqual(rowsOf(after), ['1', '3', '2✕']);
});

test('a gone row stays gone even if the id is recycled later', () => {
  const first = mergeRows([], [proc({ id: 7, time: 10 })], { ...M, first: true });
  const dead = mergeRows(first, [], M);
  assert.deepEqual(rowsOf(dead), ['7✕']);
  // the server hands the same id to a new connection: it must not "resurrect"
  // in place with a stale age — it comes back as a new row
  const again = mergeRows(dead, [proc({ id: 7, time: 0 })], M);
  assert.deepEqual(rowsOf(again), ['7'], 'the row is live again, still one row');
});

test('a new thread lands where its age belongs, not at the end', () => {
  const first = mergeRows([], [proc({ id: 1, time: 5 })], { ...M, first: true });
  assert.deepEqual(rowsOf(mergeRows(first, [proc({ id: 1, time: 6 }), proc({ id: 9, time: 1 })], M)),
    ['1', '9'], 'younger goes below');
  assert.deepEqual(rowsOf(mergeRows(first, [proc({ id: 1, time: 6 }), proc({ id: 9, time: 100 })], M)),
    ['9', '1'], 'older goes above');
});

// ── ordering ──────────────────────────────────────────────────────────────────

test('a restarted statement drops below older threads (the 2s-above-30s bug)', () => {
  // A connection that finishes a statement and starts another keeps its thread
  // id but resets TIME to 0 — so a frozen order would leave it stranded at the
  // top. This is the reported symptom, pinned.
  const churn = (t: number) => proc({ id: 10, time: t, info: 'SELECT SLEEP(2)' });
  const stuck = (t: number) => proc({ id: 11, time: t, info: 'SELECT SLEEP(60)' });
  let rows = mergeRows([], [churn(28), stuck(25)], { ...M, first: true });
  assert.deepEqual(rowsOf(rows), ['10', '11']);
  rows = mergeRows(rows, [churn(1), stuck(32)], M);      // #10 restarted
  assert.deepEqual(rowsOf(rows), ['11', '10'], '32s must be above 1s');
  rows = mergeRows(rows, [churn(2), stuck(33)], M);
  assert.deepEqual(rowsOf(rows), ['11', '10'], 'and it stays that way');
});

test('running work outranks idle connections, however long they have idled', () => {
  // MySQL TIME for `Sleep` means "idle this long" — an hour-old idle connection
  // must not sit above a query that has been running for 40s.
  const rows = mergeRows([], [
    proc({ id: 20, time: 3600, command: 'Sleep', info: '' }),
    proc({ id: 21, time: 40, info: 'SELECT big' }),
  ], { ...M, first: true });
  assert.deepEqual(rowsOf(rows), ['21', '20']);
  assert.equal(procRank(proc({ command: 'Query' })), 0);
  assert.equal(procRank(proc({ command: 'Sleep' })), 1);
  assert.equal(procRank(proc({ isSystem: true })), 2);
  assert.equal(procRank(proc({}), true), 3, 'gone sinks below everything');
});

test('equal ages break by thread id, so the list cannot shimmer between polls', () => {
  const same = [proc({ id: 3, time: 9 }), proc({ id: 1, time: 9 }), proc({ id: 2, time: 9 })];
  assert.deepEqual(orderProcs(same).map(p => p.id), [1, 2, 3]);
  // the same set in a different input order must produce the same output order
  assert.deepEqual(orderProcs([...same].reverse()).map(p => p.id), [1, 2, 3]);
  // …and merging in any order converges on it too
  let rows = mergeRows([], [same[0]], { ...M, first: true });
  rows = mergeRows(rows, same, M);
  assert.deepEqual(rowsOf(rows), ['1', '2', '3']);
});

test('the comparator is a total order (antisymmetric, transitive on the tiers)', () => {
  const rows = [
    { proc: proc({ id: 1, time: 10 }) },
    { proc: proc({ id: 2, time: 10 }) },
    { proc: proc({ id: 3, time: 99, command: 'Sleep' }) },
    { proc: proc({ id: 4, time: 999, isSystem: true }) },
    { proc: proc({ id: 5, time: 999 }), gone: true },
  ];
  for (const a of rows) for (const b of rows) {
    // sign(a,b) + sign(b,a) === 0 covers both the ordered and the equal case
    // (and sidesteps 0 vs -0 under strict equality)
    assert.equal(Math.sign(compareRows(a, b)) + Math.sign(compareRows(b, a)), 0,
      `antisymmetry broken for #${a.proc.id} vs #${b.proc.id}`);
  }
  assert.deepEqual([...rows].sort(compareRows).map(r => r.proc.id), [1, 2, 3, 4, 5]);
  assert.deepEqual([...rows].reverse().sort(compareRows).map(r => r.proc.id), [1, 2, 3, 4, 5]);
});

test('corpses are budgeted and never evict a live row', () => {
  // 3 live + a long tail of dead threads, with a budget of 2 corpses
  const live = [proc({ id: 1 }), proc({ id: 2 }), proc({ id: 3 })];
  let rows = mergeRows([], live, { ...M, first: true });
  for (let i = 10; i < 20; i++) {
    rows = mergeRows(rows, [...live, proc({ id: i })], { ...M, goneKeep: 2 });
    rows = mergeRows(rows, live, { ...M, goneKeep: 2 });   // that one dies
  }
  const gone = rows.filter(r => r.gone);
  assert.equal(gone.length, 2, 'oldest corpses retired');
  assert.deepEqual(rows.filter(r => !r.gone).map(r => r.id), [1, 2, 3], 'live rows all present');
  // the survivors are the most recent deaths
  assert.deepEqual(gone.map(r => r.id), [18, 19]);
});

test('the cap keeps live rows rather than corpses', () => {
  const many = Array.from({ length: 5 }, (_, i) => proc({ id: 100 + i, time: 5 - i }));
  let rows = mergeRows([], many, { ...M, first: true, max: 5 });
  rows = mergeRows(rows, [], { ...M, max: 5, goneKeep: 5 });          // all die
  rows = mergeRows(rows, [proc({ id: 200 })], { ...M, max: 5, goneKeep: 5 });
  assert.equal(rows.length, 5);
  assert.ok(rows.some(r => r.id === 200 && !r.gone), 'the new live row is in the list');
});
