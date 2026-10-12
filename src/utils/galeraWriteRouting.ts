/**
 * Write routing for the cluster panel — WHERE writes should go, the
 * recommendation half of galeraWriteSources' observation half. The poll
 * already knows everything that decides it: node state (Synced /
 * Donor/Desynced / Joiner), flow-control paused ratio, apply/send queues and
 * each node's share of originated writes. This module turns that into a
 * ranked write-suitability list, so "pin the writers to one node" can finally
 * say WHICH node.
 *
 * Eligibility is strict because a wrong writer is worse than no advice: only
 * a reachable Galera node that is Synced (never guessed — synced null means
 * unreadable, and unreadable means ineligible) and not mid SST/IST qualifies.
 * Scoring then prefers the node writes already land on (moving the writer
 * creates NEW cross-node conflicts) and punishes the slow-node signals in the
 * panel's own warn vocabulary — the same FC_WARN / QUEUE_WARN /
 * QUEUE_AVG_WARN thresholds galeraStatus.ts rules fire on.
 *
 * Deterministic across polls: the tie-break is share, then display name —
 * no flicker.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { ClusterFinding, NodeSummary } from './galeraCluster.ts';
import type { WriteShare } from './galeraWriteSources.ts';
import { FC_INFO, FC_WARN, QUEUE_AVG_WARN, QUEUE_WARN } from './galeraStatus.ts';

export interface WriteTarget {
  connectionId: string;
  /** "name (wsrep node)" or name — the panel's display string. */
  display: string;
  eligible: boolean;
  /** Higher = better write target; -Infinity when ineligible. */
  score: number;
  /** Human strings, good and bad, for the badge tooltip / finding detail. */
  reasons: string[];
  /** Why the node is excluded (donor, joiner, unreachable…); null when eligible. */
  ineligibleReason: string | null;
}

function ineligible(target: Omit<WriteTarget, 'eligible' | 'score' | 'ineligibleReason'>, why: string): WriteTarget {
  return { ...target, eligible: false, score: -Infinity, ineligibleReason: why };
}

/**
 * The ranked write-suitability list for one poll, best first. Ineligible
 * nodes sink to the bottom (score -Infinity) with their reason set — they are
 * data for the finding, never a recommendation.
 */
export function rankWriteTargets(
  nodes: { connectionId: string; display: string; summary: NodeSummary }[],
  shares: Map<string, WriteShare>,
): WriteTarget[] {
  const targets = nodes.map(({ connectionId, display, summary }) => {
    const base = { connectionId, display, reasons: [] as string[] };
    if (!summary.reachable) return ineligible(base, 'unreachable this poll');
    if (!summary.detected) return ineligible(base, 'no wsrep provider — not a Galera node');
    if (summary.synced !== true) {
      return ineligible(base, summary.synced === null
        ? 'local state unreadable this poll — never guessed'
        : `not Synced (${summary.localState ?? 'unknown state'})`);
    }
    if (summary.transfer !== null || summary.ist !== null) {
      return ineligible(base, 'mid SST/IST transfer');
    }

    let score = 0;
    const reasons: string[] = [];
    const share = shares.get(connectionId)?.share ?? null;
    if (share !== null) {
      // Keeping writes where they already land avoids NEW cross-node
      // conflicts; an idle cluster (share null) scores everyone 0 here.
      score += 2 * share;
      if (share > 0) reasons.push(`the current writer (${Math.round(share * 100)}% of writes)`);
    }
    const fc = summary.flowControlPaused;
    if (fc !== null && fc > FC_WARN) {
      score -= 3;
      reasons.push(`flow control paused ${Math.round(fc * 100)}% of the interval`);
    } else if (fc !== null && fc > FC_INFO) {
      score -= 1;
      reasons.push(`flow control paused ${Math.round(fc * 100)}% of the interval`);
    }
    if (summary.recvQueueAvg !== null && summary.recvQueueAvg > QUEUE_AVG_WARN) {
      score -= 2;
      reasons.push(`apply queue averaging ${summary.recvQueueAvg.toFixed(1)} — falling behind`);
    }
    if (summary.recvQueue !== null && summary.recvQueue > QUEUE_WARN) {
      score -= 1;
      reasons.push(`${summary.recvQueue.toLocaleString()} events queued for apply`);
    }
    if (summary.sendQueue !== null && summary.sendQueue > QUEUE_WARN) {
      score -= 1;
      reasons.push(`${summary.sendQueue.toLocaleString()} events queued for send`);
    }
    return { ...base, reasons, eligible: true, score, ineligibleReason: null };
  });

  const shareOf = (t: WriteTarget) => shares.get(t.connectionId)?.share ?? 0;
  return targets.sort((a, b) =>
    b.score - a.score || shareOf(b) - shareOf(a) || a.display.localeCompare(b.display));
}

/** The top eligible target, or null when no node qualifies this poll. */
export function recommendedWriter(targets: WriteTarget[]): WriteTarget | null {
  return targets.find(t => t.eligible) ?? null;
}

/**
 * The cluster-level finding. Warn when writes land dominantly (≥ half) on a
 * node that is NOT the recommendation — that is the multi-writer advice with
 * a name on it; otherwise an info naming the recommendation. Null when
 * routing is meaningless (< 2 live Galera nodes) or nothing is eligible (the
 * other findings already scream — unreachable/split-brain fire first).
 */
export function writeRoutingFinding(
  nodes: { connectionId: string; display: string }[],
  shares: Map<string, WriteShare>,
  targets: WriteTarget[],
): ClusterFinding | null {
  if (nodes.length < 2) return null;
  const rec = recommendedWriter(targets);
  if (!rec) return null;

  let dominant: { connectionId: string; display: string; share: number } | null = null;
  for (const n of nodes) {
    const share = shares.get(n.connectionId)?.share ?? null;
    if (share !== null && share >= 0.5 && (dominant === null || share > dominant.share)) {
      dominant = { connectionId: n.connectionId, display: n.display, share };
    }
  }

  if (dominant && dominant.connectionId !== rec.connectionId) {
    const dom = targets.find(t => t.connectionId === dominant.connectionId);
    const domWhy = dom?.ineligibleReason
      ?? (dom && dom.reasons.length > 0 ? dom.reasons.join('; ') : 'scores worse this poll');
    const recWhy = rec.reasons.length > 0
      ? rec.reasons.join('; ')
      : 'synced, no flow control, idle queues';
    return {
      level: 'warn',
      title: `Writes land on ${dominant.display} but ${rec.display} is the healthier write target`,
      detail: `${dominant.display} originates ${Math.round(dominant.share * 100)}% of the ` +
        `cluster's writes — ${domWhy}. Point the writers at ${rec.display} instead (${recWhy}); ` +
        'a single writer is the topology Galera is happiest with.',
    };
  }

  return {
    level: 'info',
    title: `Recommended write target: ${rec.display}`,
    detail: (rec.reasons.length > 0
      ? rec.reasons.join('; ')
      : 'Synced, no flow control, idle queues') +
      (dominant ? ` — writes already land here (${Math.round(dominant.share * 100)}%).` : '.'),
  };
}
