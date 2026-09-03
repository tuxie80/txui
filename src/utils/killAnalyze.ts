/**
 * Kill hinting — the brains behind the `kill …` / `killall` editor popup.
 *
 * Pure functions only (no React, no Tauri), so the rules that decide "this is
 * a rogue family, kill THESE" are testable in isolation: see tests/killAnalyze.test.ts.
 *
 * The model:
 *   - a **sample** is one processlist poll; `trackHistory` folds samples into
 *     per-thread history so we can tell a thread that is *stuck and ageing*
 *     from one that merely happens to be running right now;
 *   - a **family** is (user, db, statement digest) — the unit `killall` reasons
 *     about, because a runaway is almost never one thread, it's five copies of
 *     the same statement from the same client;
 *   - a **recommendation** is what `killall` pre-selects, with the evidence
 *     spelled out so you can disagree before pressing ⏎.
 */

/** One backend, as returned by the `kill_candidates` command. */
export interface ProcInfo {
  id: number;
  user: string;
  host: string;
  db: string;
  /** MySQL COMMAND (Query/Sleep/…) · PG state (active/idle in transaction/…) */
  command: string;
  /** seconds in the current state */
  time: number;
  /** MySQL thread STATE · PG wait_event_type:wait_event */
  state: string;
  info: string;
  /** seconds the transaction has been open; -1 = none */
  trxAge: number;
  rowsLocked: number;
  trxState: string;
  blocking: number[];
  blockedBy: number[];
  isSelf: boolean;
  isSystem: boolean;
}

export type KillMode = 'query' | 'connection';

// ── the editor trigger ────────────────────────────────────────────────────────

export interface KillTrigger {
  kind: 'kill' | 'killall';
  /** what ⏎ will issue: KILL QUERY (statement only) or KILL (whole connection) */
  mode: KillMode;
  /** text typed after the keyword — filters the list (id prefix or free text) */
  filter: string;
  /** document offsets of the matched command (for ⇧⏎ insert-id) */
  from: number;
  to: number;
}

/**
 * Recognize a kill command being typed. `text` is everything before the caret;
 * offsets are relative to it, so callers pass `doc.slice(0, caret)`.
 *
 * Opens on:  `kill ` · `kill 47` · `kill query ` · `kill connection ` ·
 *            `killall` · `killall app_rw`
 * Stays shut inside a bigger statement (`SELECT 'kill '`, `-- kill`).
 */
export function parseKillTrigger(text: string): KillTrigger | null {
  // The command must start the statement: doc start, after ';' or a blank line.
  const m = /(?:^|;|\n)[ \t]*(killall|kill)\b([ \t]+(?:query|connection)\b)?([ \t]*)([^\s;]*)$/i
    .exec(text);
  if (!m) return null;

  const [full, kw, qualifier, gap, rest] = m;
  const kind = kw.toLowerCase() === 'killall' ? 'killall' : 'kill';
  // `kill` needs a separator before it means anything; `killall` is complete
  // on its own (nothing else starts with it).
  if (kind === 'kill' && !qualifier && gap.length === 0) return null;
  // A line comment before the keyword is not a command.
  const lineStart = text.lastIndexOf('\n', Math.max(0, m.index)) + 1;
  const prefix = text.slice(lineStart, m.index + full.indexOf(kw));
  if (prefix.includes('--') || prefix.includes('#')) return null;

  const q = (qualifier ?? '').trim().toLowerCase();
  return {
    kind,
    // MySQL semantics: bare KILL drops the connection, KILL QUERY only aborts
    // the statement. `killall` defaults to the gentler statement-only kill.
    mode: q === 'query' ? 'query' : q === 'connection' ? 'connection'
      : kind === 'killall' ? 'query' : 'connection',
    filter: rest,
    from: m.index + full.indexOf(kw),
    to: text.length,
  };
}

// ── statement digest ─────────────────────────────────────────────────────────

/**
 * Normalize a statement into a family key: comments gone, literals → `?`,
 * whitespace collapsed. Two copies of the same query with different parameters
 * (or different playground slot markers) land on the same digest.
 */
/**
 * Digest cache. Every poll digests every backend's statement — twice over
 * (history tracking, then family grouping) — and the strings barely change
 * between polls, so the 8 regex passes are pure repetition. Bounded, and
 * dropped wholesale when full: a stale entry is impossible because the key IS
 * the statement.
 */
const digestCache = new Map<string, string>();
const DIGEST_CACHE_MAX = 4096;

export function digest(sql: string): string {
  if (!sql) return '';
  const hit = digestCache.get(sql);
  if (hit !== undefined) return hit;
  const out = computeDigest(sql);
  if (digestCache.size >= DIGEST_CACHE_MAX) digestCache.clear();
  digestCache.set(sql, out);
  return out;
}

function computeDigest(sql: string): string {
  let s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/--[^\n]*/g, ' ')                   // -- line comments
    .replace(/#[^\n]*/g, ' ');                   // MySQL # comments
  s = s
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '?')       // 'strings'
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '?')       // "strings"
    .replace(/\b0x[0-9a-f]+\b/gi, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')          // numbers
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // IN (?, ?, ?) and VALUES (?, ?) collapse to a single placeholder list
  s = s.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)');
  return s.slice(0, 400);
}

/** Single-line, length-capped statement for display in a table cell. */
export function oneLine(sql: string, max = 200): string {
  const s = (sql || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── history / growth ─────────────────────────────────────────────────────────

export interface ThreadHistory {
  /** wall-clock ms of the first sample that saw this thread */
  firstSeen: number;
  lastSeen: number;
  /** server-reported TIME at the first / last sample */
  firstTime: number;
  lastTime: number;
  samples: number;
  /** digest at first sight — a changed digest means a new statement, not growth */
  digest: string;
  /** the thread kept the same statement and its age kept rising */
  growing: boolean;
  /** highest TIME ever seen for this thread */
  peakTime: number;
}

export type History = Map<number, ThreadHistory>;

/**
 * Fold one poll into the history map (mutates and returns it — the caller
 * keeps it in a ref across polls). Threads gone for more than `forgetMs`
 * are dropped so a long session doesn't grow forever.
 */
export function trackHistory(
  hist: History,
  procs: ProcInfo[],
  nowMs: number,
  forgetMs = 5 * 60_000,
): History {
  for (const p of procs) {
    const d = digest(p.info);
    const h = hist.get(p.id);
    if (!h || h.digest !== d) {
      hist.set(p.id, {
        firstSeen: nowMs, lastSeen: nowMs,
        firstTime: p.time, lastTime: p.time,
        samples: 1, digest: d, growing: false, peakTime: p.time,
      });
      continue;
    }
    h.lastSeen = nowMs;
    h.samples += 1;
    // TIME going UP while the statement stayed the same = still stuck on it.
    h.growing = p.time > h.firstTime;
    h.lastTime = p.time;
    h.peakTime = Math.max(h.peakTime, p.time);
  }
  for (const [id, h] of hist) {
    if (nowMs - h.lastSeen > forgetMs) hist.delete(id);
  }
  return hist;
}

/** Seconds this thread aged while we watched it (null before the 2nd sample). */
export function aged(hist: History, id: number): number | null {
  const h = hist.get(id);
  if (!h || h.samples < 2) return null;
  return h.lastTime - h.firstTime;
}

// ── families ─────────────────────────────────────────────────────────────────

export interface Family {
  key: string;
  user: string;
  db: string;
  digest: string;
  /** readable stand-in for the digest */
  label: string;
  procs: ProcInfo[];
  maxTime: number;
  /** how many members we watched age (same statement, rising TIME) */
  growing: number;
}

/** Group live threads into (user, db, digest) families, biggest age first. */
export function families(procs: ProcInfo[], hist?: History): Family[] {
  const map = new Map<string, Family>();
  for (const p of procs) {
    const d = digest(p.info);
    if (!d) continue;                                  // no statement = no family
    const key = `${p.user} ${p.db} ${d}`;
    let f = map.get(key);
    if (!f) {
      f = { key, user: p.user, db: p.db, digest: d, label: oneLine(p.info, 90),
            procs: [], maxTime: 0, growing: 0 };
      map.set(key, f);
    }
    f.procs.push(p);
    f.maxTime = Math.max(f.maxTime, p.time);
    if (hist?.get(p.id)?.growing) f.growing += 1;
  }
  return [...map.values()].sort((a, b) =>
    b.procs.length - a.procs.length || b.maxTime - a.maxTime);
}

// ── the recommendation ───────────────────────────────────────────────────────

export interface Recommendation {
  /** what to kill, in kill order (blockers first) */
  ids: number[];
  mode: KillMode;
  /** one-line verdict shown in the popup banner */
  headline: string;
  /** the evidence, one bullet per rule that fired */
  reasons: string[];
  confidence: 'high' | 'medium' | 'low';
  /** ids that are blocking other threads — killing these frees the queue */
  blockers: number[];
}

export interface AnalyzeOptions {
  /** ignore anything younger than this (seconds) */
  minAge?: number;
  /** a lone thread must be at least this old to be called rogue (seconds) */
  loneAge?: number;
  /** idle-in-transaction threads older than this are worth killing (seconds) */
  idleTrxAge?: number;
}

/** Idle connection — nothing running, so there is nothing to abort. */
export function isIdle(p: ProcInfo): boolean {
  const c = p.command.toLowerCase();
  return c === 'sleep' || c === 'idle' || c === '';
}

/** Idle, but holding a transaction open — the classic invisible blocker. */
export function isIdleInTrx(p: ProcInfo): boolean {
  return (p.command.toLowerCase() === 'idle in transaction' && p.trxAge >= 0)
    || (isIdle(p) && p.trxAge >= 0);
}

/** Threads a kill may target: not us, not the server's own machinery. */
export function killable(procs: ProcInfo[]): ProcInfo[] {
  return procs.filter(p => !p.isSelf && !p.isSystem);
}

const secs = (n: number) => n >= 60 ? `${Math.floor(n / 60)}m${n % 60}s` : `${n}s`;

/**
 * What `killall` should pre-select, in priority order:
 *   1. **blockers** — threads other threads are queued behind (kill the cause,
 *      not the victims). An idle-in-transaction blocker needs the *connection*
 *      killed: aborting its (nonexistent) statement would release nothing.
 *   2. **a rogue family** — 2+ threads, same user, same statement, ageing.
 *   3. **a lone long-runner** — nothing else stands out, but this one is old.
 *   4. **an old idle transaction** — holds locks/undo while doing nothing.
 * Returns null when nothing meets the bar (the honest answer most of the time).
 */
export function recommend(
  procs: ProcInfo[],
  hist: History = new Map(),
  opts: AnalyzeOptions = {},
): Recommendation | null {
  const minAge = opts.minAge ?? 5;
  const loneAge = opts.loneAge ?? 60;
  const idleTrxAge = opts.idleTrxAge ?? 60;
  const live = killable(procs);
  if (live.length === 0) return null;

  // 1 ── blocking chains. Careful: a lock queue makes every member look like a
  // blocker of the ones behind it (MySQL's sys.innodb_lock_waits reports every
  // holder/waiter pair). Only a thread that blocks others while waiting for
  // NOBODY is a cause — the rest are victims standing in the same queue.
  const blockers = live.filter(p => p.blocking.length > 0);
  if (blockers.length > 0) {
    const waiting = live.filter(p => p.blockedBy.length > 0);
    const roots = blockers.filter(p => p.blockedBy.length === 0);
    // No root = the waits form a cycle (a deadlock the server hasn't resolved).
    // Breaking it needs a victim chosen by hand: the oldest is the safest bet.
    const cycle = roots.length === 0;
    const chosen = cycle
      ? [...blockers].sort((a, b) => b.time - a.time).slice(0, 1)
      : [...roots].sort((a, b) => b.blocking.length - a.blocking.length || b.time - a.time);
    const idleRoot = chosen.some(isIdleInTrx);
    const reasons: string[] = [];
    if (cycle) {
      reasons.push(`${blockers.length} threads block each other in a cycle — no thread is free, so this is a deadlock the server has not broken yet`);
      reasons.push('one of them has to go for the rest to proceed; the oldest is pre-marked');
    } else {
      reasons.push(`${waiting.length} thread(s) are queued; the chain starts at ${chosen.map(p => `#${p.id}`).join(', ')} — kill the cause, killing the queue only makes it re-form`);
    }
    for (const b of chosen) {
      reasons.push(`#${b.id} ${b.user}@${b.db || '—'} holds what ${b.blocking.map(v => `#${v}`).join(', ')} want`
        + (b.trxAge >= 0 ? ` · transaction open ${secs(b.trxAge)}` : '')
        + (b.rowsLocked > 0 ? ` · ${b.rowsLocked} rows locked` : '')
        + ` · ${b.command}${b.state ? `/${b.state}` : ''} ${secs(b.time)}`);
    }
    const alsoLooksBlocking = blockers.filter(b => !chosen.includes(b));
    if (alsoLooksBlocking.length > 0) {
      reasons.push(`${alsoLooksBlocking.map(b => `#${b.id}`).join(', ')} also appear to block others, but they are waiting themselves — victims in the same queue, not causes`);
    }
    if (idleRoot) {
      reasons.push('the blocker is idle inside an open transaction — KILL QUERY would abort nothing, so this needs the whole connection dropped');
    }
    return {
      ids: chosen.map(p => p.id),
      mode: idleRoot ? 'connection' : 'query',
      headline: cycle
        ? `deadlock cycle between ${blockers.length} threads`
        : `${chosen.length === 1 ? 'root blocker' : `${chosen.length} root blockers`} holding ${waiting.length} thread${waiting.length > 1 ? 's' : ''} hostage`,
      reasons,
      confidence: cycle ? 'medium' : 'high',
      blockers: blockers.map(p => p.id),
    };
  }

  // 2 ── rogue family: same user, same statement, more than one, ageing.
  // Two ways in, because waiting for the age bar alone made the verdict useless
  // in the first seconds of an incident (which is exactly when you look):
  //   • old enough on its own  (maxTime >= minAge), or
  //   • watched ageing — two members seen growing across polls, which is
  //     evidence of being stuck no matter how young they are.
  const busy = live.filter(p => !isIdle(p));
  const fam = families(busy, hist)
    .filter(f => f.procs.length >= 2 && (f.maxTime >= minAge || f.growing >= 2))
    .sort((a, b) => (b.growing - a.growing)
      || (b.procs.length - a.procs.length)
      || (b.maxTime - a.maxTime))[0];
  if (fam) {
    const ages = fam.procs.map(p => p.time).sort((a, b) => b - a);
    const watched = fam.procs.map(p => aged(hist, p.id)).filter((n): n is number => n != null);
    const reasons = [
      `${fam.procs.length} threads run the SAME statement as ${fam.user}${fam.db ? ` on ${fam.db}` : ''} — one client looping or retrying, not ${fam.procs.length} humans`,
      `ages ${ages.slice(0, 6).map(secs).join(' · ')}${ages.length > 6 ? ' …' : ''} (oldest ${secs(ages[0])})`,
    ];
    if (fam.growing > 0) {
      reasons.push(`${fam.growing} of them aged${watched.length ? ` +${secs(Math.max(...watched))}` : ''} while this popup watched — they are stuck, not finishing`);
    } else {
      reasons.push('not yet watched across two polls — leave the popup open a second to confirm they keep ageing');
    }
    if (fam.maxTime < minAge) {
      reasons.push(`still young (oldest ${secs(fam.maxTime)}) — flagged because they are ageing together, not because of their age`);
    }
    return {
      ids: fam.procs.sort((a, b) => b.time - a.time).map(p => p.id),
      mode: 'query',
      headline: `rogue family: ${fam.procs.length}× ${oneLine(fam.label, 60)}`,
      reasons,
      confidence: fam.growing > 0 ? 'high' : 'medium',
      blockers: [],
    };
  }

  // 3 ── one old statement, on its own
  const lone = busy.filter(p => p.time >= loneAge).sort((a, b) => b.time - a.time)[0];
  if (lone) {
    return {
      ids: [lone.id],
      mode: 'query',
      headline: `one long statement: #${lone.id} running ${secs(lone.time)}`,
      reasons: [
        `no family, no blocking chain — just #${lone.id} (${lone.user}${lone.db ? `@${lone.db}` : ''}) at ${secs(lone.time)}`,
        `state: ${lone.state || '—'}`,
        'a single old query is often legitimate (a report, a backup) — check the statement before killing',
      ],
      confidence: 'low',
      blockers: [],
    };
  }

  // 4 ── an idle transaction nobody is waiting on yet, but that still holds locks
  const idleTrx = live.filter(p => isIdleInTrx(p) && p.trxAge >= idleTrxAge)
    .sort((a, b) => b.trxAge - a.trxAge)[0];
  if (idleTrx) {
    return {
      ids: [idleTrx.id],
      mode: 'connection',
      headline: `idle transaction open ${secs(idleTrx.trxAge)} (#${idleTrx.id})`,
      reasons: [
        `#${idleTrx.id} (${idleTrx.user}) is idle but inside a transaction started ${secs(idleTrx.trxAge)} ago`
          + (idleTrx.rowsLocked > 0 ? ` holding ${idleTrx.rowsLocked} locked rows` : ''),
        'it blocks purge and will block writers the moment they touch its rows',
        'KILL QUERY cannot help an idle thread — the connection has to go',
      ],
      confidence: 'medium',
      blockers: [],
    };
  }

  return null;
}

// ── the popup's row list ─────────────────────────────────────────────────────

/** One row as the popup keeps it: the thread, and whether it is still there. */
export interface RowState {
  id: number;
  proc: ProcInfo;
  /** the thread is no longer on the server (it finished, or we killed it) */
  gone: boolean;
}

export interface MergeOptions {
  /**
   * This is the FIRST real poll of a viewing session. The list is then rebuilt
   * from scratch, ordered by age: whatever was on screen before (a cached
   * snapshot painted for instant feedback) is display-only and must not
   * survive — otherwise a *previous* run's threads, including ones you just
   * killed, reappear at the top of a brand-new `kill` / `killall`.
   */
  first: boolean;
  /** How many finished threads may linger before the oldest are retired. */
  goneKeep: number;
  /** Hard cap on the list. */
  max: number;
}

/**
 * Fold a poll into the visible row list.
 *
 * The contract that makes the popup safe to aim at:
 *   - the list is **always sorted** by `compareRows` — running work first,
 *     longest first. It is re-sorted on every poll because a thread's age is
 *     NOT monotonic: a connection that finishes a statement and starts another
 *     keeps its thread id but resets `TIME` to zero, so a frozen order drifts
 *     away from reality within a second (a 2 s statement sitting above a 30 s
 *     one was exactly that bug);
 *   - reordering is safe because the selection is a **thread id**, not a row
 *     index: the highlight stays glued to its thread, and ⏎ can never hit a
 *     different one than the one under it;
 *   - a thread that disappears while you WATCH stays in the list, marked
 *     `gone`, so you see the kill land — it just sinks below the live rows
 *     instead of holding a place at the top;
 *   - that applies only to threads seen alive in THIS session: on the first
 *     poll the list is rebuilt, so nothing stale is ever inherited;
 *   - corpses are budgeted (oldest retired first) and live rows are never
 *     evicted by them.
 */
export function mergeRows(prev: RowState[], list: ProcInfo[], opts: MergeOptions): RowState[] {
  if (opts.first) {
    return orderProcs(list)
      .map(p => ({ id: p.id, proc: p, gone: false }))
      .slice(0, opts.max);
  }

  const live = new Map(list.map(p => [p.id, p]));
  const merged: RowState[] = prev.map(r => {
    const p = live.get(r.id);
    live.delete(r.id);
    return p ? { ...r, proc: p, gone: false } : (r.gone ? r : { ...r, gone: true });
  });
  for (const p of live.values()) merged.push({ id: p.id, proc: p, gone: false });
  merged.sort(compareRows);

  // Eviction order is always: corpses first (oldest of them first), live rows
  // only as a last resort. Retiring by budget AND by cap in one pass matters —
  // capping afterwards would drop the row just appended, which is a LIVE one.
  const goneCount = merged.filter(r => r.gone).length;
  let dropGone = Math.max(0, Math.min(
    goneCount,
    Math.max(goneCount - opts.goneKeep, merged.length - opts.max),
  ));
  const kept = dropGone === 0 ? merged : merged.filter(r => {
    if (r.gone && dropGone > 0) { dropGone -= 1; return false; }
    return true;
  });
  // Still over the cap: everything left is live, so keep the oldest (the first
  // poll ordered by age, and that order never changes).
  return kept.length > opts.max ? kept.slice(0, opts.max) : kept;
}

// ── logging ──────────────────────────────────────────────────────────────────

export interface KillLogInput {
  id: number;
  mode: KillMode;
  /** the statement actually issued, as reported by the backend */
  statement: string;
  ok: boolean;
  error?: string | null;
  /** the row as last polled — everything we knew about the victim */
  proc?: ProcInfo;
  /** seconds the thread aged while the popup watched it */
  agedSecs?: number | null;
  /** where the kill came from: the popup, killall's recommendation, a panel */
  source?: string;
}

/**
 * One line per kill, with every fact we had about the victim at the moment we
 * killed it — the whole point of the popup is that you can prove afterwards
 * what you hit. Never multi-line: statements and errors are flattened.
 */
export function killLogLine(k: KillLogInput): string {
  const p = k.proc;
  const parts: string[] = [];
  parts.push(`${k.mode === 'query' ? 'KILL QUERY' : 'KILL'} #${k.id}`);
  parts.push(k.ok ? 'ok' : `FAILED: ${oneLine(k.error || 'unknown error', 160)}`);
  if (p) {
    parts.push(`${p.user || '?'}@${p.host || '?'}`);
    parts.push(`db=${p.db || '—'}`);
    const aged = k.agedSecs != null && k.agedSecs > 0 ? ` aged +${k.agedSecs}s` : '';
    parts.push(`${p.command || '?'}${p.state ? `/${p.state}` : ''} ${p.time}s${aged}`);
    if (p.trxAge >= 0) {
      parts.push(`trx ${p.trxAge}s${p.rowsLocked > 0 ? `, ${p.rowsLocked} rows locked` : ''}`);
    }
    if (p.blocking.length) parts.push(`was blocking ${p.blocking.map(i => `#${i}`).join(',')}`);
    if (p.blockedBy.length) parts.push(`was blocked by ${p.blockedBy.map(i => `#${i}`).join(',')}`);
    if (p.isSystem) parts.push('server thread');
    parts.push(p.info ? oneLine(p.info, 200) : '(no statement)');
  } else {
    parts.push('(thread was not in the last poll — no detail captured)');
  }
  parts.push(`issued: ${oneLine(k.statement, 100)}`);
  if (k.source) parts.push(`via ${k.source}`);
  return parts.join(' · ').replace(/\s+/g, ' ');
}

/**
 * Why `killall` came up empty — with the numbers, so "nothing looks rogue" is a
 * finding instead of a shrug. Only called when `recommend` returned null.
 */
export function noVerdictReason(
  procs: ProcInfo[],
  hist: History = new Map(),
  opts: AnalyzeOptions = {},
): string {
  const minAge = opts.minAge ?? 5;
  const loneAge = opts.loneAge ?? 60;
  const live = killable(procs);
  if (live.length === 0) {
    return 'Nothing to look at: this server has no other client backends right now.';
  }
  const busy = live.filter(p => !isIdle(p));
  if (busy.length === 0) {
    return `All ${live.length} backend(s) are idle — nothing is running, so there is nothing to abort.`;
  }
  const biggest = families(busy, hist)[0];
  const oldest = Math.max(...busy.map(p => p.time));
  const parts: string[] = ['No blocking chain, and no family qualifies.'];
  if (biggest && biggest.procs.length >= 2) {
    parts.push(`The biggest family is ${biggest.procs.length}× “${oneLine(biggest.label, 50)}” `
      + `(oldest ${secs(biggest.maxTime)}, ${biggest.growing} seen ageing) — it needs either `
      + `${secs(minAge)} of age or two members watched ageing across polls.`);
  } else {
    parts.push(`Every running statement is unique — a family needs 2+ threads on the SAME statement `
      + `(same user and db).`);
  }
  parts.push(`Oldest running statement: ${secs(oldest)} (a lone one is only flagged past ${secs(loneAge)}).`);
  parts.push('Pick a thread manually if you disagree — an empty verdict is a real answer.');
  return parts.join(' ');
}

// ── filtering / ordering for the popup ───────────────────────────────────────

/** Does the typed filter match this row? Digits = id prefix, text = anywhere. */
export function matchProc(p: ProcInfo, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  if (/^\d+$/.test(f)) return String(p.id).startsWith(f);
  return [p.user, p.host, p.db, p.command, p.state, p.info]
    .some(v => (v || '').toLowerCase().includes(f));
}

/**
 * Ordering tier — lower comes first. Age alone is not an order: MySQL's `TIME`
 * is "seconds in the current state", so an idle connection that has been
 * sleeping for an hour would outrank a query that has been running for a
 * minute. What a DBA wants at the top is **actual work, longest first**.
 *
 *   0  a killable thread that is running something   ← the ones you came for
 *   1  a killable thread that is idle                ← nothing to abort
 *   2  TxUI's own connection / the server's own threads
 *   3  gone (it finished, or you killed it)          ← sinks out of the way
 */
export function procRank(p: ProcInfo, gone = false): number {
  if (gone) return 3;
  if (p.isSelf || p.isSystem) return 2;
  if (isIdle(p)) return 1;
  return 0;
}

/** Anything the popup can order: a thread, plus whether it is still there. */
export interface OrderableRow { proc: ProcInfo; gone?: boolean }

/**
 * A **total** order: tier, then age descending, then thread id ascending.
 *
 * The id tie-break is not cosmetic — without it, threads of equal age would
 * swap places on every poll (comparator ties are unstable across differently
 * ordered inputs), and the list would shimmer once a second.
 */
export function compareRows(a: OrderableRow, b: OrderableRow): number {
  const ra = procRank(a.proc, a.gone), rb = procRank(b.proc, b.gone);
  if (ra !== rb) return ra - rb;
  if (a.proc.time !== b.proc.time) return b.proc.time - a.proc.time;
  return a.proc.id - b.proc.id;
}

/** Rows in popup order (see `compareRows`), filtered by what the user typed. */
export function orderProcs(procs: ProcInfo[], filter = ''): ProcInfo[] {
  return procs
    .filter(p => matchProc(p, filter))
    .map(proc => ({ proc }))
    .sort(compareRows)
    .map(r => r.proc);
}
