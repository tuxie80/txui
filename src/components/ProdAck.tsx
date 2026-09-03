/**
 * Shown once per app run per connection when a session to a prod-tagged
 * connection is opened: the hard rules that are active (per the connection's
 * opt-out flags), the soft row cap, and an explicit "I understand" before the
 * workspace appears. Cancelling aborts the open (the backend session is
 * closed by the caller). Styled after WriteConfirm.
 */
import { useEffect, useRef } from 'react';

export interface ProdAckRequest {
  connectionName: string;
  /** connection opted out of the destructive-DDL block */
  allowDdl: boolean;
  /** connection opted out of the no-WHERE UPDATE/DELETE block */
  allowUnfiltered: boolean;
  /** soft prod row cap (Settings → Safety); 0 = off */
  rowCap: number;
}

interface Props {
  request: ProdAckRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ProdAck({ request, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal wc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">⚠ PRODUCTION — {request.connectionName}</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="wc-body">
          <ul className="wc-facts">
            {request.allowDdl ? (
              <li className="wc-warn">
                Destructive DDL (DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE) is <b>ALLOWED</b> —
                this connection opted out of the prod block.
              </li>
            ) : (
              <li>Destructive DDL (DROP/TRUNCATE/ALTER/RENAME/GRANT/REVOKE) is <b>blocked</b>.</li>
            )}
            {request.allowUnfiltered ? (
              <li className="wc-warn">
                UPDATE/DELETE without a WHERE clause is <b>ALLOWED</b> —
                this connection opted out of the prod block.
              </li>
            ) : (
              <li>UPDATE/DELETE without a WHERE clause is <b>blocked</b>.</li>
            )}
            <li>
              {request.rowCap > 0
                ? <>SELECTs without their own LIMIT are capped at <b>{request.rowCap.toLocaleString()} rows</b> (soft — the status-bar Default LIMIT choice overrides it).</>
                : 'No prod row cap — SELECTs without a LIMIT stream in full.'}
            </li>
            <li>Every write still asks for confirmation with a live row count.</li>
          </ul>
        </div>

        <div className="wc-actions">
          <button ref={cancelRef} className="toolbar-btn wc-cancel" onClick={onCancel}>
            Cancel (Esc)
          </button>
          <div style={{ flex: 1 }} />
          <button className="toolbar-btn wc-run" onClick={onConfirm}>
            I understand — production
          </button>
        </div>
      </div>
    </div>
  );
}
