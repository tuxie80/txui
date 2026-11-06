import type { Session } from '../types';
import { safeOperationUnavailableReason } from '../utils/operationSupport';
import { StatusIcon } from './StatusIcon';

interface Props {
  session: Session;
  onClose: () => void;
}

export function QueryLabPanel({ session, onClose }: Props) {
  const unavailable = safeOperationUnavailableReason(session.engine, 'querylab');
  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">Query Optimization Lab</span>
        <span className="dv-desc">{session.connectionName}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>
      <div className="dg-body">
        <div className="mnt-warn">
          <StatusIcon kind={unavailable ? 'error' : 'pending'} />
          <span>{unavailable ?? 'The workflow contract is ready. Estimated and measured experiments are not operational yet.'}</span>
        </div>
        <p className="dv-desc">Compare plans, index candidates and rewrites without confusing estimates with measured evidence. No database action is available in this checkpoint.</p>
      </div>
    </div>
  );
}
