/**
 * Watch — one panel for the three shapes of the same verb: poll something on
 * an interval and show how it moves.
 *
 *   - **Metrics** — re-run a query every N seconds and track numeric values
 *     (MonitorPanel: current value, Δ/s rate, sparkline);
 *   - **Statement** — run one statement on a watched connection and follow its
 *     live phase and progress % (LongQueryPanel), or pin a thread that was
 *     started ELSEWHERE — the "watch this thread" action in Processes — and
 *     follow it read-only;
 *   - **Wait profile** — sample pg_stat_activity into a live wait-event
 *     histogram (PgWaitEventsPanel).
 *
 * An honest wrapper, not a merge: the modes poll different sources and draw
 * different things, so each keeps its own implementation and toolbar, and this
 * panel is only the mode switcher above them (the FindPanel scope pattern).
 * The Statement mode is engine-gated (`longQueryWatch` in utils/engineCaps),
 * the Wait profile reads a PostgreSQL view; a mode the engine cannot serve is
 * greyed with the reason on hover, never hidden — the menu can offer this
 * panel on every engine because Metrics always works.
 */
import { useEffect, useState } from 'react';
import type { Session } from '../types';
import { can, ENGINE_LABELS } from '../utils/engineCaps';
import type { EngineCaps } from '../utils/engineCaps';
import { useSessionPrivileges } from '../store/sessionPrivileges';
import { privilegeTip } from '../utils/privileges';
import { MonitorPanel } from './MonitorPanel';
import { LongQueryPanel } from './LongQueryPanel';
import { PgWaitEventsPanel } from './PgWaitEventsPanel';

export type WatchMode = 'metrics' | 'statement' | 'waitprofile';

/** A mode-carrying open — optionally pinned to an existing server thread. */
export interface WatchTarget {
  mode: WatchMode;
  /** Processes' "watch this thread": follow this thread id read-only. */
  threadId?: number | null;
}

interface ModeDef {
  id: WatchMode;
  label: string;
  tip: string;
  /** Engine capability the mode needs — Metrics needs none. */
  cap?: keyof EngineCaps;
  /** Literal engine gate, where no capability exists for it (the pgwait one). */
  engine?: string;
  /** What the mode does, for the greyed tab's "why not" tip. */
  does: string;
}

const MODES: ModeDef[] = [
  {
    id: 'metrics', label: 'Metrics',
    tip: 'Re-run a query every N seconds — current value, Δ/s rate, sparkline',
    does: '',
  },
  {
    id: 'statement', label: 'Statement', cap: 'longQueryWatch',
    tip: 'Run a statement and watch its live phase + progress % — or pin a thread started elsewhere',
    does: 'polls the processlist and the engine\'s progress catalogs '
      + '(performance_schema stages, pg_stat_progress_*, dm_exec_requests), '
      + 'which only MySQL, PostgreSQL and SQL Server publish in that shape',
  },
  {
    id: 'waitprofile', label: 'Wait profile', engine: 'postgres',
    tip: 'Sample pg_stat_activity into a live wait-event histogram',
    does: 'reads wait events out of pg_stat_activity, a PostgreSQL view',
  },
];

interface Props {
  session: Session;
  /** Preselected mode (+ optional pinned thread), from an opener that knows
      which watch it wants. */
  target?: WatchTarget | null;
  onTargetConsumed?: () => void;
  onClose: () => void;
}

export function WatchPanel({ session, target, onTargetConsumed, onClose }: Props) {
  const engineLabel = ENGINE_LABELS[session.engine] ?? session.engine;
  // The Statement mode reads the full processlist — the same role gate the
  // standalone long-query panel carried, applied at mode level so Metrics
  // stays reachable without it (unknown means allowed, as everywhere).
  const privs = useSessionPrivileges(session.sessionId, session.engine);
  const stmtPrivBlocked = privilegeTip(privs, 'processlist-all', 'Statement');
  /** Why this mode is unusable here — engine first, then role; null when fine. */
  const blocked = (m: ModeDef): string | null => {
    if ((m.cap && !can(session.engine, m.cap)) || (m.engine && session.engine !== m.engine))
      return `${m.label} — not available for ${engineLabel}: this mode ${m.does}`;
    if (m.id === 'statement' && stmtPrivBlocked) return stmtPrivBlocked;
    return null;
  };
  const modeOk = (m: ModeDef) => blocked(m) === null;
  // The default is the first mode — Metrics always works, so every engine has
  // at least one mode to open on.
  const [active, setActive] = useState<WatchMode>(() => {
    const wanted = target && MODES.find(m => m.id === target.mode);
    return (wanted && modeOk(wanted) ? wanted : MODES.find(modeOk)!).id;
  });
  /** The pinned foreign thread for Statement mode, if one arrived. */
  const [pin, setPin] = useState<number | null>(target?.threadId ?? null);

  // A target-carrying open ("watch this thread") applies to the panel already
  // mounted, exactly like the Find panel's scopes: the mode switch is React's
  // sanctioned adjust-state-during-render, and the consume happens in an
  // effect so the parent's clear never fires during this render. Consumed back
  // to null re-arms the same target for a later open.
  const [seenTarget, setSeenTarget] = useState<WatchTarget | null>(target ?? null);
  if (target !== seenTarget) {
    setSeenTarget(target ?? null);
    const def = target && MODES.find(m => m.id === target.mode);
    if (def && modeOk(def)) {
      setActive(def.id);
      if (target.threadId != null) setPin(target.threadId);
    }
  }
  useEffect(() => {
    if (target) onTargetConsumed?.();
  }, [target, onTargetConsumed]);

  const activeDef = MODES.find(m => m.id === active)!;
  const activeOk = modeOk(activeDef);

  return (
    <div className="proc-panel">
      <div className="mnt-tabs" role="tablist">
        {MODES.map(m => {
          const reason = blocked(m);
          return (
            <button key={m.id} role="tab" aria-selected={active === m.id}
              className={`mnt-tab${active === m.id ? ' active' : ''}${reason ? ' unavail' : ''}`}
              data-tip={reason ?? m.tip}
              onClick={() => { if (!reason) setActive(m.id); }}>
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="watch-mode-body">
        {/* Reachable only via a preselected mode this engine cannot serve —
            the tabs themselves refuse the click. */}
        {!activeOk && (
          <div className="db-error">
            {blocked(activeDef)} The Metrics mode works everywhere.
          </div>
        )}
        {activeOk && active === 'metrics' && (
          <MonitorPanel sessionId={session.sessionId} engine={session.engine} onClose={onClose} />
        )}
        {activeOk && active === 'statement' && (
          <LongQueryPanel session={session} pinnedThread={pin} onUnpin={() => setPin(null)} onClose={onClose} />
        )}
        {activeOk && active === 'waitprofile' && (
          <PgWaitEventsPanel session={session} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
