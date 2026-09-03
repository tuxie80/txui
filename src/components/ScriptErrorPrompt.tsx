/**
 * "Statement 4 of 12 failed" — the window that stops a script mid-run and asks
 * what to do about it.
 *
 * A failure partway through a script is genuinely ambiguous. Sometimes the
 * script is a batch of independent statements and one bad one should not bin
 * the other eleven; sometimes it is a sequence where everything after the
 * failure is meaningless. Guessing either way is wrong half the time, so this
 * asks — and remembers "all" for the rest of the run:
 *   • **Ignore**      — record the failure, run the next statement
 *   • **Ignore all**  — and stop asking for the rest of this run
 *   • **Stop**        — abort; remaining statements are marked skipped
 *
 * Skip the window entirely with Settings → Safety → "On a failed statement".
 *
 * When a transaction is open the question changes, so the window says so. On
 * PostgreSQL an unguarded error poisons the transaction outright: everything
 * after it fails and the final COMMIT is silently downgraded to a ROLLBACK, so
 * "ignore" would produce a run that reports partial success having committed
 * nothing. The runner takes a savepoint per statement in exactly that case, and
 * this window reports which of the two situations you are in — the difference
 * decides whether Ignore is safe.
 */
import { useEffect, useRef } from 'react';
import type { ScriptErrorChoice } from './QueryTabs';
import { StatusIcon } from './StatusIcon';

interface Props {
  /** 1-based index of the statement that failed. */
  stmtNo: number;
  total: number;
  sql: string;
  error: string;
  /** A transaction was open when the statement failed. */
  inTransaction?: boolean;
  /** It was savepointed, so ignoring rolls back only this statement. */
  savepointed?: boolean;
  onChoose: (choice: ScriptErrorChoice) => void;
}

/** Enough of the statement to recognise it; the editor has the rest. */
const SQL_PREVIEW_MAX = 600;

export function ScriptErrorPrompt({
  stmtNo, total, sql, error, inTransaction, savepointed, onChoose,
}: Props) {
  const stopRef = useRef<HTMLButtonElement>(null);
  // Stop is the safe default: focused, and Esc picks it. Ignoring a failure is
  // the choice that should take a deliberate click.
  useEffect(() => { stopRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onChoose('stop'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose]);

  const remaining = total - stmtNo;
  const preview = sql.length > SQL_PREVIEW_MAX
    ? sql.slice(0, SQL_PREVIEW_MAX) + '…'
    : sql;

  return (
    <div className="modal-overlay" onClick={() => onChoose('stop')}>
      <div className="modal sep-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            <StatusIcon kind="error" size={15} /> Statement {stmtNo} of {total} failed
          </span>
          <button className="modal-close" onClick={() => onChoose('stop')}>×</button>
        </div>

        <div className="sep-body">
          <div className="sep-error">{error}</div>
          <pre className="sep-sql">{preview}</pre>
          <div className="sep-note">
            {remaining === 0
              ? 'This was the last statement — there is nothing left to run.'
              : `${remaining} statement${remaining === 1 ? '' : 's'} left to run after this one.`}
          </div>
          {inTransaction && (
            savepointed ? (
              <div className="sep-tx">
                <StatusIcon kind="ok" size={13} />
                <span>
                  A transaction is open. This statement was wrapped in a savepoint, so
                  ignoring it rolls back <strong>only this statement</strong> and the rest of
                  the transaction survives. Nothing is durable until you Commit.
                </span>
              </div>
            ) : (
              <div className="sep-tx sep-tx-warn">
                <StatusIcon kind="error" size={13} />
                <span>
                  A transaction is open and this statement was <strong>not</strong> savepointed.
                  Whatever the rest of the run does, nothing is committed until you Commit —
                  and on this connection a failure may already have left the transaction
                  unable to continue.
                </span>
              </div>
            )
          )}
        </div>

        <div className="sep-actions">
          <button ref={stopRef} className="toolbar-btn sep-stop" onClick={() => onChoose('stop')}>
            Stop (Esc)
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="toolbar-btn"
            disabled={remaining === 0}
            onClick={() => onChoose('ignore-all')}
          >Ignore all</button>
          <button
            className="toolbar-btn sep-ignore"
            disabled={remaining === 0}
            onClick={() => onChoose('ignore')}
          >Ignore</button>
        </div>
      </div>
    </div>
  );
}
