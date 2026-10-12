/**
 * Ghost-member / arbitrator (garbd) awareness for the cluster panel.
 *
 * A Galera arbitrator (garbd) joins the cluster, appears in every node's
 * `wsrep_incoming_addresses` and counts toward `wsrep_cluster_size` — but
 * never answers SQL, because there is no mysqld to poll. (The same shape,
 * far rarer, is a node whose galera library is up while its mysqld is down.)
 * Without this module such a member is invisible-or-confusing: the union of
 * incoming addresses names a member no polled node corresponds to.
 *
 * Detection is address matching against the SAME canonical form the
 * discovery banner uses (utils/galeraDiscover.ts): a "ghost" is an
 * incoming-address token matched by NO polled connection config — saved or
 * ad-hoc, answering or not. A polled-but-down node is covered by its config
 * and stays the existing "unreachable node" finding, never a ghost.
 *
 * Classification needs persistence, so the scan is fed the previous poll's
 * consecutive-count map (the panel keeps it in a ref, exactly like
 * trackStateSince): a ghost seen in ≥2 consecutive polls whose reachable
 * nodes all report cluster_size == ok-nodes + ghosts is a
 * `likely_arbitrator` — the size math only works when the unseen member is a
 * real cluster member that answers gcomm. Anything else is an
 * `unknown_member`, the one shape that earns a (info-level) finding.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { ClusterFinding, NodeSummary } from './galeraCluster.ts';
import { normalizeHostPort, splitHostPort } from './galeraDiscover.ts';

export interface GhostMember {
  /** The normalized host:port token as it appears in wsrep_incoming_addresses. */
  address: string;
  /** Consecutive polls this address has been a ghost (1 = first sighting). */
  polls: number;
  classification: 'likely_arbitrator' | 'unknown_member';
}

export interface GhostScan {
  ghosts: GhostMember[];
  /** Next consecutive-poll counts, keyed by address — caller keeps this ref. */
  nextPolls: Record<string, number>;
}

/** Ghosts must persist this many consecutive polls before the arbitrator
 *  classification (and the unknown-member finding) engages — a single-poll
 *  sighting is a membership flap, not a topology. */
export const GHOST_MIN_POLLS = 2;

/** Normalize a covered-set token (already-normalized config host:ports pass
 *  through; anything unparseable degrades to trimmed lowercase — it can only
 *  ever mismatch, which is the safe side). */
function normToken(token: string): string {
  const hp = splitHostPort(token);
  return hp ? normalizeHostPort(hp.host, hp.port) : token.trim().toLowerCase();
}

/**
 * One poll's ghost scan. `coveredTokens` is the normalized host:port of every
 * POLLED connection config (selected saved + ad-hoc), answering or not.
 */
export function scanGhosts(
  nodes: NodeSummary[],
  coveredTokens: Iterable<string>,
  prevPolls: Record<string, number>,
): GhostScan {
  const live = nodes.filter(n => n.reachable && n.detected);
  const covered = new Set<string>();
  for (const t of coveredTokens) covered.add(normToken(t));

  // The union of what the reachable nodes SEE, minus everything we poll.
  // Unparseable tokens (a stray AUTO/blank) are skipped, never ghosts.
  const seen = new Set<string>();
  for (const n of live) {
    for (const token of n.incomingAddresses) {
      const hp = splitHostPort(token);
      if (!hp) continue;
      const norm = normalizeHostPort(hp.host, hp.port);
      if (!covered.has(norm)) seen.add(norm);
    }
  }

  const nextPolls: Record<string, number> = {};
  for (const addr of seen) nextPolls[addr] = (prevPolls[addr] ?? 0) + 1;

  // The arbitrator size identity: every reachable node with a readable size
  // reports ok-nodes + ghosts. garbd counts toward wsrep_cluster_size; a
  // member whose galera side is up while mysqld is down does too — but the
  // persistence requirement separates both from a flap.
  const sizes = live.map(n => n.clusterSize).filter((s): s is number => s !== null);
  const sizeMatchesArbitrator = sizes.length > 0
    && sizes.every(s => s === live.length + seen.size);

  const ghosts: GhostMember[] = [...seen].sort().map(address => {
    const polls = nextPolls[address];
    const classification = polls >= GHOST_MIN_POLLS && sizeMatchesArbitrator
      ? 'likely_arbitrator'
      : 'unknown_member';
    return { address, polls, classification };
  });
  return { ghosts, nextPolls };
}

/**
 * The cluster-level findings ghosts earn — deliberately quiet: a
 * `likely_arbitrator` is a HEALTHY topology (the greyed card says what it
 * is), only an `unknown_member` persistent enough to classify gets an info.
 */
export function ghostFindings(ghosts: GhostMember[]): ClusterFinding[] {
  return ghosts
    .filter(g => g.classification === 'unknown_member' && g.polls >= GHOST_MIN_POLLS)
    .map(g => ({
      level: 'info',
      title: `Member ${g.address} is in the component but unreachable and not an arbitrator pattern — investigate`,
      detail: `Every reachable node lists ${g.address} in wsrep_incoming_addresses ` +
        `(${g.polls} consecutive polls), but no polled or saved connection answers there ` +
        'and the cluster size does not account for it as a voting member. If it is an ' +
        'arbitrator (garbd) the size identity should hold; since it does not, this is ' +
        'more likely a node whose galera library is up while its mysqld is down — ' +
        'check the host before the membership confuses a quorum decision.',
    }));
}

/** The greyed ghost card's explanatory tooltip. */
export function ghostCardTip(g: GhostMember): string {
  const base = `Answers Galera (gcomm) but not SQL for ${g.polls} poll${g.polls === 1 ? '' : 's'}`;
  if (g.classification === 'likely_arbitrator') {
    return `${base} — most likely an arbitrator (garbd), possibly a node with mysqld down. ` +
      'Cluster size counts it toward quorum.';
  }
  return `${base} — and the cluster size does not account for it as a voting member, ` +
    'so the arbitrator pattern does not hold. Investigate the host.';
}
