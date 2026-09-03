/**
 * Wait-for graph from the InnoDB `LATEST DETECTED DEADLOCK` section.
 *
 * The Locks panel shows the section as text; this module turns it into the
 * structure a deadlock analyzer draws: one node per transaction, one directed
 * edge per lock wait (waiter → holder), the rollback victim, and the wait
 * cycle the server broke.
 *
 * What the section actually gives us, per `*** (N) TRANSACTION:` block:
 * the transaction id, state and statement, the `*** (N) HOLDS THE LOCK(S):`
 * list and the single `*** (N) WAITING FOR THIS LOCK TO BE GRANTED:` lock.
 * It does NOT say who holds the lock a transaction waits on — that edge is
 * resolved by matching the waited lock's table (and index, when both sides
 * name one) against every other transaction's HOLDS list, with the trivial
 * two-transaction deadlock (the overwhelmingly common case) resolving to "the
 * other one". A wait whose holder cannot be resolved keeps `to: null` and is
 * drawn as an unresolved edge rather than guessed — the graph may show less
 * than the truth, never more.
 *
 * Pure — no React/Tauri imports; unit-tested with node --test
 * (tests/deadlockGraph.test.ts) against realistic captured sections.
 */
import { splitSections, getSection } from './innodbStatus.ts';

export interface DeadlockLock {
  kind: 'record' | 'table';
  /** `db`.`table`, as printed (backticks kept — quoting is the truth here). */
  table: string;
  index: string | null;
  /** e.g. "X locks rec but not gap" (the trailing "waiting" stripped). */
  mode: string;
  /** First word of the mode: X, S, IX, … — the short edge label. */
  modeShort: string;
}

export interface DeadlockTxn {
  /** The (N) ordinal InnoDB assigned in the report. */
  ordinal: number;
  trxId: string | null;
  /** e.g. "ACTIVE 6 sec starting index read". */
  status: string | null;
  threadId: string | null;
  host: string | null;
  user: string | null;
  /** The statement it was running, when the section carries one. */
  query: string | null;
  holds: DeadlockLock[];
  waitingFor: DeadlockLock | null;
}

export interface DeadlockEdge {
  /** Ordinal of the waiting transaction. */
  from: number;
  /** Ordinal of the holder, or null when the text cannot tell us. */
  to: number | null;
  lock: DeadlockLock;
}

export interface DeadlockGraph {
  /** The timestamp line that opens the section, verbatim. */
  when: string;
  transactions: DeadlockTxn[];
  edges: DeadlockEdge[];
  /** Ordinal of the transaction InnoDB rolled back, when reported. */
  victim: number | null;
  /** Ordinals forming the wait cycle, in wait order, or null when the resolved
   *  edges do not close a loop (unresolved holders can break it). */
  cycle: number[] | null;
  /** The whole section, kept for the raw view and for history rows. */
  raw: string;
}

// ── Lock lines ───────────────────────────────────────────────────────────────

/**
 * The two lock-line shapes the section prints:
 *   RECORD LOCKS space id 412 page no 4 n bits 72 index `PRIMARY` of table
 *     `shop`.`accounts` trx id 1056807 lock_mode X locks rec but not gap waiting
 *   TABLE LOCK table `shop`.`accounts` trx id 1056808 lock mode IX
 * Everything defensive: a wording drift yields null, not a throw.
 */
function parseLockLine(line: string): DeadlockLock | null {
  let m = line.match(/RECORD LOCKS\b.*?\bof table\s+(`[^`]+`\.`[^`]+`)/i);
  if (m) {
    const idx = line.match(/\bindex\s+`?([^\s`]+)`?\s+of table/i);
    const mode = line.match(/\block_mode\s+(.+)$/i);
    if (!mode) return null;
    return {
      kind: 'record',
      table: m[1],
      index: idx ? idx[1] : null,
      mode: cleanMode(mode[1]),
      modeShort: shortMode(mode[1]),
    };
  }
  m = line.match(/TABLE LOCK\s+table\s+(`[^`]+`\.`[^`]+`).*?\block mode\s+(.+)$/i);
  if (m) {
    return {
      kind: 'table',
      table: m[1],
      index: null,
      mode: cleanMode(m[2]),
      modeShort: shortMode(m[2]),
    };
  }
  return null;
}

/** "X locks rec but not gap waiting" → "X locks rec but not gap". */
function cleanMode(mode: string): string {
  return mode.trim().replace(/\s+waiting$/i, '');
}

function shortMode(mode: string): string {
  return mode.trim().split(/\s+/)[0] ?? '';
}

/** One-line edge label: "X · `shop`.`accounts` · idx PRIMARY". */
export function lockLabel(lock: DeadlockLock): string {
  return [lock.modeShort, lock.table, lock.index ? `idx ${lock.index}` : null]
    .filter(Boolean).join(' · ');
}

// ── Transaction blocks ───────────────────────────────────────────────────────

function parseTxnHeader(part: string, ordinal: number): DeadlockTxn {
  const trx = part.match(/TRANSACTION\s+(\d+)\s*,(.*)/);
  const thread = part.match(/MySQL thread id\s+(\d+)(.*)/);
  let host: string | null = null;
  let user: string | null = null;
  let query: string | null = null;
  if (thread) {
    // "…, query id 4401 10.0.0.21 app updating" → host 10.0.0.21, user app.
    const who = thread[2].match(/query id\s+\d+\s+(\S+)\s+(\S+)/);
    if (who) { host = who[1]; user = who[2]; }
    // The statement follows the thread-id line and runs to the end of the
    // header part (it may wrap over several lines).
    const lines = part.split('\n');
    const ti = lines.findIndex(l => /MySQL thread id\s+\d+/.test(l));
    if (ti >= 0 && ti + 1 < lines.length) {
      const q = lines.slice(ti + 1).join('\n').trim();
      query = q.length ? q : null;
    }
  }
  return {
    ordinal,
    trxId: trx ? trx[1] : null,
    status: trx ? trx[2].trim() || null : null,
    threadId: thread ? thread[1] : null,
    host,
    user,
    query,
    holds: [],
    waitingFor: null,
  };
}

function parseTxn(chunk: string, ordinal: number): DeadlockTxn {
  // Cut the trailing "*** WE ROLL BACK TRANSACTION (N)" if the split left it.
  const body = chunk.split(/\*\*\* WE ROLL BACK/)[0];
  // Sub-parts: the header (transaction info), then "*** (N) HOLDS THE
  // LOCK(S):" and "*** (N) WAITING FOR THIS LOCK TO BE GRANTED:" sections.
  const parts = body.split(/\*\*\* \(\d+\) /);
  const txn = parseTxnHeader(parts[0], ordinal);
  for (const p of parts.slice(1)) {
    const nl = p.indexOf('\n');
    if (nl < 0) continue;
    const tag = p.slice(0, nl).toUpperCase();
    const text = p.slice(nl + 1);
    const locks = text.split('\n')
      .map(parseLockLine)
      .filter((l): l is DeadlockLock => l !== null);
    if (tag.startsWith('HOLDS THE LOCK')) {
      txn.holds = locks;
    } else if (tag.startsWith('WAITING FOR THIS LOCK')) {
      txn.waitingFor = locks[0] ?? null;
    }
  }
  return txn;
}

// ── Edges & cycle ────────────────────────────────────────────────────────────

/**
 * Resolve each wait to its holder. Preference: another transaction holding
 * the same table AND index, then the same table, then — only in the
 * two-transaction case — the other transaction outright (a two-node deadlock
 * is a mutual wait by construction; the lock lines just corroborate it).
 */
export function resolveEdges(txns: DeadlockTxn[]): DeadlockEdge[] {
  const edges: DeadlockEdge[] = [];
  for (const t of txns) {
    const w = t.waitingFor;
    if (!w) continue;
    const others = txns.filter(o => o.ordinal !== t.ordinal);
    const holder =
      others.find(o => o.holds.some(h => h.table === w.table && w.index !== null && h.index === w.index))
      ?? others.find(o => o.holds.some(h => h.table === w.table))
      ?? (others.length === 1 ? others[0] : undefined);
    edges.push({ from: t.ordinal, to: holder ? holder.ordinal : null, lock: w });
  }
  return edges;
}

/**
 * The wait cycle, in wait order ([1, 2] reads "1 waits on 2 waits on 1").
 * DFS with a path stack; the first back-edge found closes the reported loop.
 * Unresolved edges (to: null) simply do not participate.
 */
export function findCycle(edges: DeadlockEdge[]): number[] | null {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    if (e.to === null) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const state = new Map<number, 'open' | 'done'>();
  const stack: number[] = [];
  const visit = (n: number): number[] | null => {
    state.set(n, 'open');
    stack.push(n);
    for (const next of adj.get(n) ?? []) {
      if (state.get(next) === 'open') {
        return stack.slice(stack.indexOf(next));
      }
      if (state.get(next) !== 'done') {
        const hit = visit(next);
        if (hit) return hit;
      }
    }
    stack.pop();
    state.set(n, 'done');
    return null;
  };
  for (const n of adj.keys()) {
    if (!state.has(n)) {
      const hit = visit(n);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Section parse ────────────────────────────────────────────────────────────

/**
 * Parse a full `SHOW ENGINE INNODB STATUS` output into a wait-for graph, or
 * null when it carries no LATEST DETECTED DEADLOCK section (no deadlock has
 * happened since server start / status reset).
 */
export function parseDeadlockGraph(statusText: string | null | undefined): DeadlockGraph | null {
  const raw = getSection(splitSections(statusText), 'LATEST DETECTED DEADLOCK');
  if (!raw) return null;
  const when = raw.split('\n')[0]?.trim() ?? '';

  // "*** (1) TRANSACTION:" … "*** (2) TRANSACTION:" — split keeping ordinals.
  const parts = raw.split(/\*\*\* \((\d+)\) TRANSACTION:/);
  const transactions: DeadlockTxn[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const ordinal = Number(parts[i]);
    if (Number.isFinite(ordinal)) transactions.push(parseTxn(parts[i + 1], ordinal));
  }
  if (!transactions.length) return null;

  const vm = raw.match(/\*\*\* WE ROLL BACK TRANSACTION \((\d+)\)/);
  const edges = resolveEdges(transactions);
  return {
    when,
    transactions,
    edges,
    victim: vm ? Number(vm[1]) : null,
    cycle: findCycle(edges),
    raw,
  };
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const DL_NODE_W = 200;
export const DL_NODE_H = 64;

export interface DlPos { x: number; y: number }

/**
 * Node positions on an ellipse centered in `width`×`height` (top-left corner
 * coordinates, DL_NODE_W × DL_NODE_H nodes). A deadlock cycle is a small ring
 * — 2 to 6 transactions in practice — so a ring layout is both correct (the
 * cycle shape is visible at a glance) and enough; no force simulation needed.
 * One node centers; two sit left/right; more spread counter-clockwise from
 * the top.
 */
export function layoutDeadlockGraph(
  ordinals: number[],
  width: number,
  height: number,
  pad = 30,
): Map<number, DlPos> {
  const pos = new Map<number, DlPos>();
  const n = ordinals.length;
  if (!n) return pos;
  const cx = width / 2, cy = height / 2;
  if (n === 1) {
    pos.set(ordinals[0], { x: cx - DL_NODE_W / 2, y: cy - DL_NODE_H / 2 });
    return pos;
  }
  const rx = Math.max(0, cx - DL_NODE_W / 2 - pad);
  const ry = Math.max(0, cy - DL_NODE_H / 2 - pad);
  ordinals.forEach((ord, i) => {
    // Two nodes (the common case) sit left/right, which reads as a standoff;
    // a larger ring starts at the top so the first transaction leads it.
    const a = n === 2 ? Math.PI + i * Math.PI : -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pos.set(ord, {
      x: Math.round(cx + rx * Math.cos(a) - DL_NODE_W / 2),
      y: Math.round(cy + ry * Math.sin(a) - DL_NODE_H / 2),
    });
  });
  return pos;
}

/** Is this edge part of the reported cycle? (Both endpoints on it.) */
export function edgeInCycle(e: DeadlockEdge, cycle: number[] | null): boolean {
  return !!cycle && e.to !== null && cycle.includes(e.from) && cycle.includes(e.to);
}
