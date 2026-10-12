/**
 * Certification-conflict analytics for the cluster panel — the multi-writer
 * pain counters the poll already carries but nothing rates:
 *
 * - `wsrep_local_cert_failures` — a LOCAL transaction failed certification:
 *   this node originated a write that conflicted with a replicated write-set
 *   (same-row multi-writer evidence, originating side).
 * - `wsrep_local_bf_aborts` — a LOCAL transaction was brute-force aborted BY
 *   a conflicting replicated write-set: this node is the victim; its writers
 *   lose to writers elsewhere.
 *
 * Both are cumulative counters, so everything here is rate math against the
 * previous poll's snapshot (the panel's snapsRef) plus a consecutive-poll
 * streak (the panel keeps the streaks in a ref, the trackStateSince
 * pattern): a single-poll blip is normal certification behaviour on any
 * busy cluster and earns nothing — the findings need a rate sustained over
 * ≥2 consecutive polls.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import { parseGaleraStatus } from './galeraStatus.ts';
import type { ClusterFinding, NodeSnapshot } from './galeraCluster.ts';

/** Per-node conflict rates for one poll interval; null = no baseline or a
 *  counter reset (server restart / FLUSH STATUS) made the interval unreadable. */
export interface ConflictRates {
  certPerSec: number | null;
  bfPerSec: number | null;
}

/** Consecutive polls with a positive rate, per counter. */
export interface ConflictStreak {
  cert: number;
  bf: number;
}

/** A positive rate this many polls in a row is "sustained". */
export const CONFLICT_MIN_STREAK = 2;

/** One node's counters vs the previous poll. A decreasing counter is a
 *  restart or FLUSH STATUS: unreadable interval, not a negative rate. */
export function conflictRates(
  cur: NodeSnapshot,
  prev: NodeSnapshot | undefined,
): ConflictRates {
  const none: ConflictRates = { certPerSec: null, bfPerSec: null };
  if (!cur.ok || !prev || !prev.ok) return none;
  const dtSec = (cur.polledAtMs - prev.polledAtMs) / 1000;
  if (dtSec <= 0) return none;
  const c = parseGaleraStatus(cur.statusRows, cur.variableRows);
  const p = parseGaleraStatus(prev.statusRows, prev.variableRows);
  const rate = (cur: number | null, prev: number | null): number | null =>
    cur !== null && prev !== null && cur >= prev ? (cur - prev) / dtSec : null;
  return {
    certPerSec: rate(c.localCertFailures, p.localCertFailures),
    bfPerSec: rate(c.localBfAborts, p.localBfAborts),
  };
}

/**
 * Advance the streaks by one poll: positive rate increments, a zero or
 * unreadable rate resets — "sustained" means EVERY poll in the run, which is
 * what keeps a one-off blip from ever reaching the findings.
 */
export function trackConflictStreaks(
  rates: Map<string, ConflictRates>,
  prev: Record<string, ConflictStreak>,
): Record<string, ConflictStreak> {
  const next: Record<string, ConflictStreak> = {};
  for (const [connectionId, r] of rates) {
    const p = prev[connectionId] ?? { cert: 0, bf: 0 };
    next[connectionId] = {
      cert: r.certPerSec !== null && r.certPerSec > 0 ? p.cert + 1 : 0,
      bf: r.bfPerSec !== null && r.bfPerSec > 0 ? p.bf + 1 : 0,
    };
  }
  return next;
}

/**
 * The two cluster-level findings. `originators` is the display names of
 * nodes originating writes this poll (from utils/galeraWriteSources.ts) —
 * passed in rather than recomputed so this module stays single-purpose.
 */
export function conflictFindings(
  nodes: { connectionId: string; display: string }[],
  streaks: Record<string, ConflictStreak>,
  originators: string[] = [],
): ClusterFinding[] {
  const findings: ClusterFinding[] = [];
  const certHot = nodes.filter(n => (streaks[n.connectionId]?.cert ?? 0) >= CONFLICT_MIN_STREAK);
  if (certHot.length > 1) {
    findings.push({
      level: 'warn',
      title: `Multi-writer hotspot: certification failures rising on ${certHot.map(n => n.display).join(', ')}`,
      detail: 'wsrep_local_cert_failures is climbing on more than one node, sustained ' +
        'across polls — several nodes are writing the same rows and each node\'s ' +
        'conflicting transactions roll back at COMMIT. Route same-row writes to one ' +
        'node (or shard the hot rows); certification cannot make concurrent same-row ' +
        'writers cheap.',
    });
  }
  const victims = nodes.filter(n => (streaks[n.connectionId]?.bf ?? 0) >= CONFLICT_MIN_STREAK);
  if (victims.length === 1 && nodes.length > 1) {
    const others = originators.length > 0
      ? originators.filter(o => o !== victims[0].display)
      : nodes.filter(n => n !== victims[0]).map(n => n.display);
    findings.push({
      level: 'warn',
      title: `${victims[0].display} is the conflict victim — its writers lose to ${others.join(', ') || 'the other nodes'}`,
      detail: 'wsrep_local_bf_aborts is climbing on this node alone, sustained across ' +
        'polls: replicated write-sets from the other nodes keep brute-force aborting ' +
        'its local transactions. The aborting side is healthy by definition — the fix ' +
        'belongs on the write routing, not on this node.',
    });
  }
  return findings;
}

/** The per-node card stat: "cert 0.3/s · bf 0.0/s", dash without a baseline. */
export function formatConflictStat(r: ConflictRates | undefined): string | null {
  if (!r || (r.certPerSec === null && r.bfPerSec === null)) return null;
  const fmt = (v: number | null) => (v === null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)}/s`);
  return `cert ${fmt(r.certPerSec)} · bf ${fmt(r.bfPerSec)}`;
}
