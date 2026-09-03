/**
 * The DBA panels a Redis session can host, and the gate that decides.
 *
 * A Redis session mounts `RedisBrowser`, not `QueryTabs`, so the Tools menu's
 * `dbgui:toggle-panel` events land on a different listener — but the question
 * "may this panel open on this engine" must have the same answer in both
 * places. This module is that answer for the Redis side: the panel id set is
 * deliberately small (what genuinely works over Redis commands), and each id
 * carries the same `engineCaps` capability `QueryTabs.PANEL_ENGINE_CAP`
 * consults, so the table — not this list — stays the source of truth.
 *
 * Privileges are NOT gated here: Redis has no privilege model TxUI can read
 * (store/sessionPrivileges.ts), so every capability is `unknown`, and unknown
 * means allowed.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { can } from './engineCaps.ts';
import type { EngineCaps } from './engineCaps.ts';

export interface RedisPanel {
  /** The `dbgui:toggle-panel` id, shared with QueryTabs' PANEL_META keys. */
  id: string;
  icon: string;
  label: string;
  /** The engine capability that must hold, or undefined for "every engine". */
  cap: keyof EngineCaps | undefined;
}

/**
 * What a Redis session can open, in tab order. `dbaviews` has no capability
 * in the table (QueryTabs gates it the same way — not at all): the curated
 * Redis view set lives in utils/dbaViews.ts and runs through monitor_query.
 */
export const REDIS_PANELS: readonly RedisPanel[] = [
  { id: 'processes',  icon: '⚡', label: 'Processes',  cap: 'processList' },
  { id: 'serverinfo', icon: 'ⓘ', label: 'Server',     cap: 'serverInfo' },
  { id: 'tuner',      icon: '💊', label: 'Tuner',     cap: 'tuner' },
  { id: 'dbaviews',   icon: '🩺', label: 'DBA views', cap: undefined },
];

/**
 * May this toggle-panel id open on this engine? Anything not in REDIS_PANELS
 * is refused — a SQL-only panel dispatched while a Redis session is active is
 * ignored, exactly as QueryTabs' PANEL_ENGINE_CAP gate ignores the panels an
 * engine does not have.
 */
export function redisPanelAllowed(engine: string, panel: string): boolean {
  const p = REDIS_PANELS.find(rp => rp.id === panel);
  if (!p) return false;
  return p.cap ? can(engine, p.cap) : true;
}

/** Look up a hostable panel by toggle id. */
export function redisPanel(panel: string): RedisPanel | undefined {
  return REDIS_PANELS.find(rp => rp.id === panel);
}
