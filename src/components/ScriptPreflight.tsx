/**
 * What a script would do, before any of it runs.
 *
 * The window that stops the twenty-statement script from failing at statement
 * seven with six already applied. Every statement is listed with its position,
 * its line and — where there is one — the reason it would be refused.
 *
 * Two shapes, and the difference is the whole point:
 *
 *  - **Something would be refused.** There is no Run button. Not a disabled
 *    one, not a confirmation with a warning: the script cannot run as written,
 *    and offering a control that does nothing invites people to keep clicking
 *    it. The list says which statements and why; the only way forward is to
 *    change the script or the connection.
 *  - **Nothing would be refused, but some statements are worth seeing.** A
 *    prod write, a WHERE-less DELETE. Run is offered, and the list is what you
 *    are agreeing to.
 */
import { useEffect, useRef } from 'react';
import type { PreflightReport } from '../utils/preflight';

interface Props {
  report: PreflightReport;
  connectionName: string;
  environment?: string | null;
  readOnly?: boolean;
  onRun: () => void;
  onCancel: () => void;
}

export function ScriptPreflight({
  report, connectionName, environment, readOnly, onRun, onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel is the default here as it is in the write confirmation: the safe
  // action is the one Esc and Enter-on-focus both reach.
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal pf-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {report.canRun ? 'Before this script runs' : 'This script cannot run as written'}
          </span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="pf-body">
          <div className={`pf-summary ${report.canRun ? 'pf-warn' : 'pf-blocked'}`}>
            {report.summary}
          </div>

          <ul className="pf-facts">
            <li>
              Connection: <b>{connectionName}</b>
              {environment && <span className={`env-chip env-${environment}`}>{environment.toUpperCase()}</span>}
              {readOnly && <span className="env-chip env-ro">READ-ONLY</span>}
            </li>
            {report.blocked > 0 && (
              <li className="pf-note">
                Nothing has run. Every statement was checked first, so the script has not been
                started and left half-applied.
              </li>
            )}
          </ul>

          <div className="pf-list">
            {report.rows.map(row => (
              <div key={row.index} className={`pf-row pf-${row.verdict}`}>
                <span className="pf-idx">{row.index}</span>
                <span className="pf-line">L{row.line}</span>
                <code className="pf-sql" title={row.preview}>{row.preview}</code>
                {row.reason && <span className="pf-reason">{row.reason}</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="pf-actions">
          <button ref={cancelRef} className="toolbar-btn" onClick={onCancel}>
            {report.canRun ? 'Cancel' : 'Close'}
          </button>
          {/* Deliberately absent when anything is blocked — see the header
              comment. A disabled Run would invite clicking. */}
          {report.canRun && (
            <button className="primary" onClick={onRun}>
              Run {report.total} statement{report.total === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
