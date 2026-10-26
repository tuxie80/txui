/**
 * Watch — interval Metrics on every engine, plus a PostgreSQL wait-event profile.
 * Thread progress lives in Processes' on-demand dialog, not in a static mode here.
 */
import { useState } from 'react';
import type { Session } from '../types';
import { MonitorPanel } from './MonitorPanel';
import { PgWaitEventsPanel } from './PgWaitEventsPanel';

export type WatchMode = 'metrics' | 'waitprofile';

interface ModeDef {
  id: WatchMode;
  label: string;
  tip: string;
}

const MODES: ModeDef[] = [
  {
    id: 'metrics', label: 'Metrics',
    tip: 'Re-run a query every N seconds — current value, Δ/s rate, sparkline',
  },
  {
    id: 'waitprofile', label: 'Wait profile',
    tip: 'Sample pg_stat_activity into a live wait-event histogram',
  },
];

interface Props {
  session: Session;
  onClose: () => void;
}

export function WatchPanel({ session, onClose }: Props) {
  const [active, setActive] = useState<WatchMode>('metrics');
  const postgres = session.engine === 'postgres';

  return (
    <div className="proc-panel">
      <div className="mnt-tabs" role="tablist">
        {MODES.map(mode => {
          const blocked = mode.id === 'waitprofile' && !postgres;
          const reason = blocked
            ? 'Wait profile — available only for PostgreSQL: it reads pg_stat_activity wait events'
            : null;
          return (
            <button key={mode.id} role="tab" aria-selected={active === mode.id}
              className={`mnt-tab${active === mode.id ? ' active' : ''}${reason ? ' unavail' : ''}`}
              data-tip={reason ?? mode.tip}
              onClick={() => { if (!reason) setActive(mode.id); }}>
              {mode.label}
            </button>
          );
        })}
      </div>
      <div className="watch-mode-body">
        {active === 'metrics' && (
          <MonitorPanel sessionId={session.sessionId} engine={session.engine} onClose={onClose} />
        )}
        {active === 'waitprofile' && postgres && (
          <PgWaitEventsPanel session={session} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
