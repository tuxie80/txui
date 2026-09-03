/**
 * The DBA panels a MongoDB session can host, and the gate that decides.
 *
 * Same role as utils/redisPanels.ts: a MongoDB session mounts `MongoBrowser`,
 * not `QueryTabs`, so the Tools menu's `dbgui:toggle-panel` events land on a
 * different listener — but "may this panel open on this engine" must have the
 * same answer in both places. The set is deliberately small: what genuinely
 * works over the Mongo driver's read-only v1 surface (currentOp, buildInfo,
 * serverStatus). Each id carries the same `engineCaps` capability QueryTabs'
 * PANEL_ENGINE_CAP consults, so the table stays the source of truth.
 *
 * Privileges are NOT gated here: MongoDB roles are not modelled in
 * store/sessionPrivileges.ts, so every capability is `unknown`, and unknown
 * means allowed.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { can } from './engineCaps.ts';
import type { EngineCaps } from './engineCaps.ts';

export interface MongoPanel {
  /** The `dbgui:toggle-panel` id, shared with QueryTabs' PANEL_META keys. */
  id: string;
  icon: string;
  label: string;
  /** The engine capability that must hold, or undefined for "every engine". */
  cap: keyof EngineCaps | undefined;
}

/**
 * What a MongoDB session can open, in tab order. `currentOp`/`killOp` back
 * Processes; buildInfo/serverStatus back Server. No tuner (no rule set), no
 * DBA views (the curated view sets are SQL run through monitor_query).
 */
export const MONGO_PANELS: readonly MongoPanel[] = [
  { id: 'processes',  icon: '⚡', label: 'Processes',  cap: 'processList' },
  { id: 'serverinfo', icon: 'ⓘ', label: 'Server',     cap: 'serverInfo' },
];

/**
 * May this toggle-panel id open on this engine? Anything not in MONGO_PANELS
 * is refused — a SQL-only panel dispatched while a MongoDB session is active
 * is ignored, exactly as QueryTabs' PANEL_ENGINE_CAP gate ignores the panels
 * an engine does not have.
 */
export function mongoPanelAllowed(engine: string, panel: string): boolean {
  const p = MONGO_PANELS.find(mp => mp.id === panel);
  if (!p) return false;
  return p.cap ? can(engine, p.cap) : true;
}

/** Look up a hostable panel by toggle id. */
export function mongoPanel(panel: string): MongoPanel | undefined {
  return MONGO_PANELS.find(mp => mp.id === panel);
}
