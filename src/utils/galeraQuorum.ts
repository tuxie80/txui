/**
 * Quorum advisor for the cluster panel — the one number a DBA should never
 * have to compute in their head during an incident: how many members this
 * component can lose before it loses quorum. The model is deliberately the
 * simple one: majority of the CURRENT (Primary) component — Galera's actual
 * rule is majority of the last PRIMARY component, and this panel only ever
 * looks at the live one.
 *
 * The arbitrator payoff: a garbd counts toward wsrep_cluster_size, so a
 * 2-node + garbd cluster reports size 3 and reads "survives losing 1" — the
 * CORRECT even-looking setup, and this module must NOT warn on it. The
 * ghost-awareness (utils/galeraGhosts.ts) is what makes "3" trustworthy
 * enough to say so; when the size is unreadable the caller adds the
 * classified arbitrator ghosts to the ok-node count itself.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import type { ClusterFinding } from './galeraCluster.ts';

/** Quorum survives the loss iff the remainder is a strict majority. */
export function quorumAfterLoss(totalSize: number, lostCount: number): boolean {
  return totalSize - lostCount > totalSize / 2;
}

/** The most members losable while keeping quorum: 3→1, 4→1, 5→2, 2→0, 1→0. */
export function lossTolerance(size: number): number {
  if (size <= 1) return 0;
  return Math.floor((size - 1) / 2);
}

/**
 * The compact header line. `arbitrators` is how many of `size` are (likely)
 * garbd rather than mysqld — for phrasing only; the math already counts them.
 */
export function quorumSummary(size: number, arbitrators = 0): string {
  if (size <= 0) return 'quorum unknown — no live member answered';
  const who = arbitrators > 0
    ? `${size - arbitrators} node${size - arbitrators === 1 ? '' : 's'} + ` +
      `${arbitrators} arbitrator${arbitrators === 1 ? '' : 's'}`
    : `${size} node${size === 1 ? '' : 's'}`;
  if (size === 1) return `${who} — no redundancy`;
  const tol = lossTolerance(size);
  if (tol === 0) return `${who} — losing ANY node loses quorum`;
  return `${who} — survives losing ${tol}`;
}

/**
 * The topology findings. Even sizes are the trap: a tie has no majority, and
 * the two-node case is the one where ANY network break reads as split-brain
 * to both sides. Odd sizes and single nodes (info only) earn no warning.
 */
export function quorumFinding(size: number, arbitrators = 0): ClusterFinding | null {
  if (size <= 0) return null;
  if (size === 1) {
    return {
      level: 'info',
      title: 'Single-node component — no redundancy',
      detail: 'The whole component is one member. It keeps quorum by definition ' +
        '(1 of 1), but any failure is a full outage and every restart risks the ' +
        'wrong-node-bootstrap problem.',
    };
  }
  if (size % 2 !== 0) return null;
  const arbNote = arbitrators > 0
    ? ' The arbitrator already votes, and it is STILL even — add another member either way.'
    : '';
  if (size === 2) {
    return {
      level: 'warn',
      title: 'Two-node component without a voting majority — any network break reads as split-brain',
      detail: 'With 2 voting members neither side of a partition can prove majority, ' +
        'so BOTH go Non-Primary (or worse, an operator bootstraps the wrong side). ' +
        'This is the setup garbd exists for: run an arbitrator, or add a third ' +
        `node.${arbNote}`,
    };
  }
  return {
    level: 'warn',
    title: `Even-sized component (${size}) — a tie has no majority`,
    detail: 'Any partition that splits the membership exactly in half leaves both ' +
      'sides one vote short of quorum. Odd sizes degrade gracefully; even sizes ' +
      'fail symmetric. Run an arbitrator (garbd) or add a node — an arbitrator is ' +
      `the cheap fix precisely because it votes without storing data.${arbNote}`,
  };
}
