/**
 * Write-source distribution for the cluster panel — WHERE the writes enter
 * the cluster. `wsrep_replicated` counts write-sets ORIGINATED by a node;
 * `wsrep_received` counts what arrived from peers. Diffed across polls, the
 * replicated delta is the node's originated-writes rate, and its share of
 * the cluster total is the single most important Galera topology fact: a
 * single-writer cluster is the healthy norm, writes landing on several
 * nodes is where certification conflicts come from.
 *
 * Everything is rate math against the previous poll's snapshots (the panel's
 * snapsRef) — no new probe, and bytes alone would not do: a share of BYTES
 * cannot say how many transactions it represents.
 *
 * "Spam" note: the findings strip recomputes from scratch every poll (the
 * same finding simply re-renders in place, exactly like mergeCluster's own
 * findings), so the single-writer info needs no once-per-session guard —
 * it is stable text, not a re-fired event.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import { parseGaleraStatus } from './galeraStatus.ts';
import type { ClusterFinding, NodeSnapshot } from './galeraCluster.ts';

export interface WriteShare {
  /** Originated write-sets/sec vs the previous poll; null without a baseline
   *  or on a counter reset (restart / FLUSH STATUS). */
  ratePerSec: number | null;
  /** This node's share of the cluster's total originated rate (0..1); null
   *  without a baseline or while the cluster is idle (total rate 0 — there
   *  is no distribution of nothing). */
  share: number | null;
}

/** Per-node originated-write rates and shares for one poll interval. */
export function writeSources(
  cur: NodeSnapshot[],
  prev: NodeSnapshot[],
): Map<string, WriteShare> {
  const prevById = new Map(prev.map(p => [p.connectionId, p]));
  const rates = new Map<string, number | null>();
  let total = 0;
  for (const s of cur) {
    let rate: number | null = null;
    const p = prevById.get(s.connectionId);
    if (s.ok && p?.ok) {
      const dtSec = (s.polledAtMs - p.polledAtMs) / 1000;
      if (dtSec > 0) {
        const c = parseGaleraStatus(s.statusRows, s.variableRows);
        const q = parseGaleraStatus(p.statusRows, p.variableRows);
        if (c.replicated !== null && q.replicated !== null && c.replicated >= q.replicated) {
          rate = (c.replicated - q.replicated) / dtSec;
        }
      }
    }
    rates.set(s.connectionId, rate);
    if (rate !== null) total += rate;
  }
  const out = new Map<string, WriteShare>();
  for (const [connectionId, ratePerSec] of rates) {
    out.set(connectionId, {
      ratePerSec,
      share: ratePerSec !== null && total > 0 ? ratePerSec / total : null,
    });
  }
  return out;
}

/**
 * The two cluster-level findings. `certOffenders` is the display names of
 * nodes with sustained certification failures (utils/galeraConflicts.ts) —
 * passed in so the multi-writer warning only fires when the pain is
 * observable, not merely possible.
 */
export function writeSourceFindings(
  nodes: { connectionId: string; display: string }[],
  shares: Map<string, WriteShare>,
  certOffenders: string[] = [],
): ClusterFinding[] {
  const findings: ClusterFinding[] = [];
  const writers = nodes.filter(n => (shares.get(n.connectionId)?.ratePerSec ?? 0) > 0);
  if (writers.length > 1 && certOffenders.length > 0) {
    findings.push({
      level: 'warn',
      title: `Writes landing on ${writers.length} nodes (${writers.map(n => n.display).join(', ')}) with certification failures on ${certOffenders.join(', ')}`,
      detail: 'The originated-write distribution shows several active writers while ' +
        'wsrep_local_cert_failures climbs — the classic Galera multi-writer pain: ' +
        'concurrent same-row writes certify against each other and somebody rolls ' +
        'back at COMMIT. Pin the writers to one node, or shard so each node owns ' +
        'its rows.',
    });
  } else if (writers.length === 1 && nodes.length > 1) {
    findings.push({
      level: 'info',
      title: `Single-writer cluster — writes only via ${writers[0].display}`,
      detail: 'Every write-set in the last interval originated on one node; the ' +
        'others are pure appliers. That is the topology Galera is happiest with — ' +
        'no certification conflicts are possible while it holds.',
    });
  }
  return findings;
}

/** The per-node card stat: "62%", dash without a baseline or while idle. */
export function formatWriteShare(share: number | null): string | null {
  if (share === null) return null;
  return `${Math.round(share * 100)}%`;
}
