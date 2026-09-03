/**
 * Tab-bar decisions, as pure functions.
 *
 * The workspace has two kinds of tab: SQL tabs and **plugin tabs** (Processes,
 * Playground, …). Plugin panels used to be modal overlays that took over the
 * whole workspace — while one was up, "+" appeared to do nothing because the
 * new SQL tab was created *behind* the overlay. They are ordinary tabs now, and
 * these functions are the rules that make that behave predictably (tested in
 * tests/tabModel.test.ts).
 */

export interface TabLike {
  id: number;
  /** set on a plugin tab; undefined on a SQL tab */
  panel?: string;
  /** shown in the tab bar; `nextSqlLabel` reads the numeric ones */
  label?: string;
}

/** What clicking a plugin's toolbar icon should do. */
export type PanelToggle =
  | { action: 'close'; id: number }     // its tab is already in front
  | { action: 'focus'; id: number }     // its tab exists, behind
  | { action: 'create' };               // no tab yet

/**
 * Clicking the icon of the panel you are looking at closes it (the old toggle
 * feel); any other click brings its tab forward or creates it. Crucially it
 * never touches other tabs — SQL tabs stay exactly as they were.
 */
export function panelToggle<T extends TabLike>(
  tabs: T[], activeId: number | null, panel: string,
): PanelToggle {
  const existing = tabs.find(t => t.panel === panel);
  if (!existing) return { action: 'create' };
  return existing.id === activeId
    ? { action: 'close', id: existing.id }
    : { action: 'focus', id: existing.id };
}

/**
 * Closing a tab: which tabs remain, and which becomes active. A connected
 * session may have ZERO tabs — closing the last one returns an empty list with
 * a `null` active id; it never disconnects anything.
 * The active tab only changes when the CLOSED tab was the active one.
 */
export function closeTab<T extends TabLike>(
  tabs: T[], activeId: number | null, id: number,
): { tabs: T[]; activeId: number | null } {
  const remaining = tabs.filter(t => t.id !== id);
  if (remaining.length === 0) return { tabs: remaining, activeId: null };
  return {
    tabs: remaining,
    activeId: id === activeId ? remaining[remaining.length - 1].id : activeId,
  };
}

/**
 * Which SQL tab a plugin should hand SQL to (History → editor, ⭐ → editor):
 * the one you last had in front, else the newest SQL tab, else `null` — the
 * caller then creates one. A plugin tab is never a target.
 */
export function sqlTabTarget<T extends TabLike>(tabs: T[], lastSqlId: number): T | null {
  const remembered = tabs.find(t => t.id === lastSqlId && !t.panel);
  if (remembered) return remembered;
  const newest = [...tabs].reverse().find(t => !t.panel);
  return newest ?? null;
}

/** Adding a tab always appends it and brings it to the front — panel or not. */
export function addTab<T extends TabLike>(tabs: T[], tab: T): { tabs: T[]; activeId: number } {
  return { tabs: [...tabs, tab], activeId: tab.id };
}

/** Just enough of an activity for the close rule. */
export interface ActivityLike { survives: boolean }

/**
 * Closing a tab: ask first when anything is running, and only offer
 * "close, keep running" when every running thing genuinely survives the tab.
 * Closing the last tab is an ordinary close — the connection is the session's,
 * not the tab's, so nothing here gates on which tab number this was.
 */
export function closeGuard(activities: ActivityLike[]): {
  ask: boolean;
  canKeepRunning: boolean;
} {
  return {
    ask: activities.length > 0,
    canKeepRunning: activities.length > 0 && activities.every(a => a.survives),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * The label the next "+" SQL tab gets: `01` when no SQL tab is open, else one
 * past the highest numeric SQL label. Panel tabs (named labels) and renamed or
 * non-numeric labels (a recovered snapshot is "05 @3h ago") do not count.
 */
export function nextSqlLabel(tabs: TabLike[]): string {
  let max = 0;
  for (const t of tabs) {
    if (t.panel) continue;
    if (t.label && /^\d+$/.test(t.label)) max = Math.max(max, parseInt(t.label, 10));
  }
  return pad2(max + 1);
}
