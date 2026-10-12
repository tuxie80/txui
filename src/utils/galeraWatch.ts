/**
 * Galera BACKGROUND cluster watch — the pure half.
 *
 * The first feature that polls and writes history with no panel open: the
 * user opts a cluster in from the ❖ Galera cluster panel, and a frontend
 * store (`store/galeraWatch.ts` — the impure half: timers, invoke,
 * localStorage, OS notifications) keeps polling its nodes every N seconds
 * while the app runs. This module owns every decision so it stays testable
 * under `node --test`:
 *
 *  - config shaping: parse/serialize the persisted watch list, clamp the
 *    poll interval, derive the stable watch id from the node selection;
 *  - round processing: diff one poll round (per-node snapshots, exactly as
 *    `galera_cluster_poll` streams them) into (a) timeline events to persist
 *    via `record_galera_event` — reusing `galeraEventsFromTransition` per
 *    node plus reachability transitions — and (b) OS notifications, reusing
 *    `mergeCluster` for the cross-node findings no single node can see;
 *  - notification policy: crit/warn-level events only (split-brain
 *    suspicion, member loss, node unreachable for 3+ consecutive rounds,
 *    flow control crossing the critical threshold, SST begin/end pairing),
 *    rate-limited per notification key so a persistent condition reminds,
 *    it does not spam.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import {
  galeraEventsFromTransition, parseGaleraStatus,
  type GaleraStatus, type GaleraLevel, type NewGaleraEvent,
} from './galeraStatus.ts';
import { mergeCluster, type NodeSnapshot } from './galeraCluster.ts';

// ── Watch configuration ─────────────────────────────────────────────────────

export const WATCH_INTERVAL_DEFAULT_SECS = 30;
export const WATCH_INTERVAL_MIN_SECS = 15;
export const WATCH_INTERVAL_MAX_SECS = 120;
/** The interval choices the panel's popover offers. */
export const WATCH_INTERVAL_CHOICES = [15, 30, 60, 120] as const;

/**
 * A node must fail this many consecutive poll rounds before "unreachable" is
 * worth a notification and a timeline row — one dropped probe is a network
 * blip, three in a row is a down node (">2 consecutive rounds").
 */
export const UNREACHABLE_NOTIFY_STREAK = 3;

/**
 * Per-notification-key rate limit: the same notification does not re-fire
 * within this window. Split-brain stays split for an hour → one notification
 * per 15 min, not one per poll round.
 */
export const NOTIFY_DEDUPE_MS = 15 * 60_000;

/** One cluster being watched in the background, as persisted. */
export interface GaleraWatchConfig {
  /** Stable id derived from the node selection — see watchIdFor. */
  id: string;
  /** Display name: the shared folder name, or "N-node cluster". */
  name: string;
  /** Saved-connection ids of the cluster's nodes (the poll fan-out). */
  connectionIds: string[];
  /** Poll interval, clamped to 15..120. */
  intervalSecs: number;
  enabled: boolean;
}

/** The watch's identity IS its node set: same selection, same watch. */
export function watchIdFor(connectionIds: string[]): string {
  return 'galera-watch:' + [...new Set(connectionIds)].sort().join('+');
}

/**
 * A display name for the watch: the shared folder when every selected
 * connection sits in one ("the 3 nodes are already a folder" is the common
 * case), otherwise a count.
 */
export function watchNameFor(
  conns: { id: string; group?: string | null }[],
  connectionIds: string[],
): string {
  const picked = conns.filter(c => connectionIds.includes(c.id));
  const groups = new Set(picked.map(c => (c.group ?? '').trim()).filter(g => g !== ''));
  if (groups.size === 1 && picked.length > 0
      && picked.every(c => (c.group ?? '').trim() === [...groups][0])) {
    return [...groups][0];
  }
  return `${connectionIds.length}-node cluster`;
}

/** Round to the nearest legal interval; garbage input gets the default. */
export function clampWatchInterval(secs: number): number {
  if (!Number.isFinite(secs)) return WATCH_INTERVAL_DEFAULT_SECS;
  return Math.min(WATCH_INTERVAL_MAX_SECS, Math.max(WATCH_INTERVAL_MIN_SECS, Math.round(secs)));
}

/**
 * Parse the persisted watch list. Anything malformed is dropped, not
 * repaired: a watch with a bogus node list or interval must never start
 * polling on the next app run. Ids are RE-derived from the node set, so a
 * hand-edited or stale id cannot collide with another watch.
 */
export function parseWatchConfigs(raw: string | null): GaleraWatchConfig[] {
  if (raw === null || raw.trim() === '') return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: GaleraWatchConfig[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const w = item as Record<string, unknown>;
    const ids = Array.isArray(w.connectionIds)
      ? w.connectionIds.filter((x): x is string => typeof x === 'string' && x !== '')
      : [];
    if (ids.length === 0) continue;
    const id = watchIdFor(ids);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof w.name === 'string' && w.name.trim() !== '' ? w.name : `${ids.length}-node cluster`,
      connectionIds: [...new Set(ids)].sort(),
      intervalSecs: clampWatchInterval(typeof w.intervalSecs === 'number' ? w.intervalSecs : NaN),
      enabled: w.enabled === true,
    });
  }
  return out;
}

export function serializeWatchConfigs(list: GaleraWatchConfig[]): string {
  return JSON.stringify(list);
}

/** Battery kindness: stop when EVERY watched connection has been deleted. */
export function allConnectionsGone(watchIds: string[], existingIds: string[]): boolean {
  const have = new Set(existingIds);
  return watchIds.every(id => !have.has(id));
}

// ── Round processing ────────────────────────────────────────────────────────

/** A notification the watch wants to fire (already rate-limited). */
export interface WatchNotice {
  /** Rate-limit key — the same key does not re-fire inside the window. */
  key: string;
  level: GaleraLevel;
  title: string;
  body: string;
}

/** What the store must remember between poll rounds. */
export interface WatchRoundState {
  /** Last ANSWERED snapshot per connection — the transition baseline. Kept
   *  across an outage so a recovered node diffs against its pre-outage self. */
  prevParsed: Record<string, GaleraStatus>;
  /** Consecutive failed rounds per connection. */
  unreachableStreaks: Record<string, number>;
  /** Donor→joiner pair keys seen last round (SST begin/end detection). */
  pairKeys: string[];
  /** Notice key → last-fired epoch ms. */
  firedNotices: Record<string, number>;
}

export function emptyWatchRoundState(): WatchRoundState {
  return { prevParsed: {}, unreachableStreaks: {}, pairKeys: [], firedNotices: {} };
}

export interface WatchRoundResult {
  state: WatchRoundState;
  /** Timeline rows to persist via record_galera_event, grouped by node. */
  timeline: { connectionId: string; events: NewGaleraEvent[] }[];
  /** Notifications to fire now. */
  notices: WatchNotice[];
}

/**
 * Should this per-node TRANSITION interrupt the user? Conservative by
 * design: member loss (warn), flow control crossing the CRITICAL threshold
 * (crit), and a changed cluster state UUID — the split-brain suspicion a
 * single node can see (crit). Everything else is timeline-only: a Synced →
 * Donor flap is information, not an alarm (the SST begin/end pairing notices
 * cover the transfer story), a size GROWTH is a recovery, a warn-level FC
 * crossing is a trend the sparkline already shows.
 */
export function transitionNoticeLevel(ev: NewGaleraEvent): GaleraLevel | null {
  if (ev.ok) return null;
  if (ev.eventType === 'cluster_size') return 'warn';
  if (ev.eventType === 'cluster_view') return 'crit';
  if (ev.eventType === 'flow_control' && ev.summary.includes('critical')) return 'crit';
  return null;
}

function whereabouts(s: GaleraStatus): string {
  return [s.clusterName ? `cluster ${s.clusterName}` : '', s.nodeName ? `node ${s.nodeName}` : '']
    .filter(Boolean).join(' · ');
}

/**
 * Process one poll round: diff per node against the last answered snapshot
 * (timeline events + per-node notices), merge the round for the cross-node
 * findings (split-brain CRITs), track unreachable streaks (>2 consecutive
 * rounds → one notice + one timeline row, recovery → one row) and the
 * donor↔joiner pairing (a pair appearing is "SST started", vanishing is
 * "SST finished"). Notices are rate-limited per key inside the returned
 * state; the FIRST round establishes baselines and fires nothing, matching
 * galeraEventsFromTransition's prev-null rule.
 */
export function processWatchRound(
  snapshots: NodeSnapshot[],
  prev: WatchRoundState,
  nowMs: number,
  opts?: { dedupeWindowMs?: number },
): WatchRoundResult {
  const window = opts?.dedupeWindowMs ?? NOTIFY_DEDUPE_MS;
  const state: WatchRoundState = {
    prevParsed: { ...prev.prevParsed },
    unreachableStreaks: { ...prev.unreachableStreaks },
    pairKeys: [],
    firedNotices: {},
  };
  const timeline: WatchRoundResult['timeline'] = [];
  const notices: WatchNotice[] = [];
  const pushEvent = (connectionId: string, ev: NewGaleraEvent) => {
    let slot = timeline.find(t => t.connectionId === connectionId);
    if (!slot) { slot = { connectionId, events: [] }; timeline.push(slot); }
    slot.events.push(ev);
  };
  // The working rate-limit map: previous round's still-warm entries, so the
  // check below suppresses repeats from EARLIER rounds and from earlier in
  // THIS round (every surviving node reports the same size transition — one
  // incident is one notification).
  const fired: Record<string, number> = {};
  for (const [k, at] of Object.entries(prev.firedNotices)) {
    if (nowMs - at < window) fired[k] = at;
  }
  state.firedNotices = fired;
  const fire = (key: string, level: GaleraLevel, title: string, body: string) => {
    if (fired[key] !== undefined) return;
    fired[key] = nowMs;
    notices.push({ key, level, title, body });
  };

  for (const snap of snapshots) {
    const id = snap.connectionId;
    if (!snap.ok) {
      const streak = (prev.unreachableStreaks[id] ?? 0) + 1;
      state.unreachableStreaks[id] = streak;
      if (streak === UNREACHABLE_NOTIFY_STREAK) {
        const summary = `${snap.connectionName} unreachable for ${streak} consecutive polls`;
        pushEvent(id, {
          eventType: 'reachability', summary,
          detail: (snap.error ?? 'poll failed').split('\n')[0], ok: false,
        });
        fire(`unreach:${id}`, 'warn', `Galera watch — ${snap.connectionName} unreachable`,
          `${summary} (last error: ${(snap.error ?? 'poll failed').split('\n')[0]}). ` +
          'One missed probe is a blip; three in a row is a node to look at.');
      }
      continue;
    }
    const streak = prev.unreachableStreaks[id] ?? 0;
    state.unreachableStreaks[id] = 0;
    const cur = parseGaleraStatus(snap.statusRows, snap.variableRows);
    if (streak >= UNREACHABLE_NOTIFY_STREAK) {
      pushEvent(id, {
        eventType: 'reachability',
        summary: `${snap.connectionName} is reachable again after ${streak} failed polls`,
        detail: whereabouts(cur), ok: true,
      });
    }
    const prevParsed = state.prevParsed[id] ?? null;
    for (const ev of galeraEventsFromTransition(prevParsed, cur)) {
      pushEvent(id, ev);
      const level = transitionNoticeLevel(ev);
      if (level !== null) {
        // Keyed WITHOUT the node id: every surviving node reports the same
        // cluster_size / cluster_view transition, and one incident is one
        // notification — the dedupe collapses the copies.
        fire(`${ev.eventType}:${ev.summary}`, level,
          `Galera watch — ${ev.summary}`, ev.detail);
      }
    }
    state.prevParsed[id] = cur;
  }

  // Cross-node findings: only the CRITs notify (split-brain is the crit tier;
  // warns like "node is unreachable" are already covered by the streak rule
  // with its >2-round hysteresis, which is stricter).
  const view = mergeCluster(snapshots, { nowMs });
  for (const f of view.findings) {
    if (f.level !== 'crit') continue;
    fire(`crit:${f.title}`, 'crit', `Galera watch — ${f.title}`, f.detail);
  }

  // Donor↔joiner pairing: a pair that was not there last round is an SST
  // starting; one that vanished is an SST ending (donor back in rotation or
  // joiner synced). Manual desync is excluded, same as the panel's pairing.
  const donors = view.nodes.filter(n =>
    n.reachable && n.detected && n.transfer?.phase === 'donor' && n.transfer.donorCause !== 'manual');
  const joiners = view.nodes.filter(n => n.reachable && n.detected && n.localState === 'Joining');
  const pairs: { key: string; text: string }[] = [];
  for (const d of donors) {
    for (const j of joiners) {
      pairs.push({
        key: `${d.connectionId}→${j.connectionId}`,
        text: `${d.name} → ${j.name}`,
      });
    }
  }
  state.pairKeys = pairs.map(p => p.key);
  for (const p of pairs) {
    if (!prev.pairKeys.includes(p.key)) {
      fire(`sst-begin:${p.key}`, 'info', 'Galera watch — state transfer started',
        `${p.text}: the donor left Synced to stream a full state transfer to the joiner. ` +
        'Expect degraded writes on the donor until it returns.');
    }
  }
  for (const key of prev.pairKeys) {
    if (!state.pairKeys.includes(key)) {
      fire(`sst-end:${key}`, 'info', 'Galera watch — state transfer finished',
        'The donor↔joiner pairing is gone — the transfer ended (the donor is back in ' +
        'rotation, or the joiner finished and is catching up / Synced).');
    }
  }

  return { state, timeline, notices };
}
