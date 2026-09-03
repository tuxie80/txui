import { useEffect, useState } from 'react';
import { answerDialog, subscribeDialogs, type DialogRequest } from '../utils/appDialog.ts';

/**
 * Renders the pending appDialog request in-DOM. Mounted once in App.tsx.
 *
 * This replaces window.confirm/prompt/alert everywhere in the app: on Linux
 * WebKitGTK those never reach the screen (confirm resolves as if ACCEPTED —
 * verified live with a DROP DATABASE that ran with no prompt), so a native
 * dialog is not a safety gate, it is the absence of one. Behaviour is
 * identical on all three desktops by construction.
 *
 * Dismissal rules: Enter confirms, Escape cancels, and the backdrop dismisses
 * alerts only — a confirmation (especially a `danger` one) needs an explicit
 * button click, because an accidental click must not read as consent.
 */
export function AppDialogHost() {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => subscribeDialogs(r => {
    setReq(r);
    setValue(r?.defaultValue ?? '');
  }), []);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      answerDialog(req, req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined);
    };
    // Capture phase: an open editor must not see the Escape that closed a dialog.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req]);

  if (!req) return null;

  const cancelValue = req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined;
  const confirmValue = req.kind === 'prompt' ? value : req.kind === 'confirm' ? true : undefined;
  const title = req.opts.title ?? (req.kind === 'alert' ? 'Alert' : req.kind === 'prompt' ? 'Input' : 'Confirm');
  // An alert dismisses from the backdrop; a confirmation never does.
  const backdropClick = req.kind === 'alert'
    ? (e: React.MouseEvent) => { if (e.target === e.currentTarget) answerDialog(req, undefined); }
    : undefined;

  return (
    <div className="modal-overlay appdialog-overlay" onClick={backdropClick}>
      <div className="modal appdialog" role={req.opts.danger || req.kind === 'alert' ? 'alertdialog' : 'dialog'}
        aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={() => answerDialog(req, cancelValue)}>×</button>
        </div>
        <div className="appdialog-message">{req.message}</div>
        {req.kind === 'prompt' && (
          <div style={{ padding: '0 16px 12px' }}>
            <input autoFocus value={value} onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') answerDialog(req, value); }}
              style={{ width: '100%', boxSizing: 'border-box' }} />
          </div>
        )}
        <div className="modal-footer">
          {req.kind !== 'alert' && (
            <button autoFocus={!!req.opts.danger} onClick={() => answerDialog(req, cancelValue)}>
              {req.opts.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button className={req.opts.danger ? 'danger' : 'primary'}
            autoFocus={!req.opts.danger && req.kind !== 'prompt'}
            onClick={() => answerDialog(req, confirmValue)}>
            {req.opts.okLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
