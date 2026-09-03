import { errorDisplay } from '../utils/appError';
import { useState, useRef, useCallback, useEffect } from 'react';
import type { QueryResult, Session } from '../types';
import { QueryStore } from '../store/query';
import { ResultGrid } from './ResultGrid';
import { shortcuts } from '../utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

interface Props {
  session: Session;
  /** Parent passes a ref; we write our insertText function into it */
  insertTextRef?: React.MutableRefObject<((text: string) => void) | null>;
}

export function QueryEditor({ session, insertTextRef }: Props) {
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Register the insert function into the parent's ref
  useEffect(() => {
    if (!insertTextRef) return;
    insertTextRef.current = (text: string) => {
      const ta = textareaRef.current;
      if (!ta) { setSql(prev => prev + text); return; }
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const next  = sql.substring(0, start) + text + sql.substring(end);
      setSql(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + text.length;
      });
    };
    return () => { if (insertTextRef) insertTextRef.current = null; };
  }, [sql, insertTextRef]);

  const runQuery = useCallback(async () => {
    const query = sql.trim();
    if (!query || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await QueryStore.execute(session.sessionId, query);
      setResult(res);
    } catch (err) {
      setError(errorDisplay(err));
    } finally {
      setRunning(false);
    }
  }, [sql, session.sessionId, running]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current!;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const next  = sql.substring(0, start) + '  ' + sql.substring(end);
      setSql(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  return (
    <div className="query-editor">
      <div className="editor-toolbar">
        <span className="session-badge">{session.connectionName} ({session.engine})</span>
        <button
          className="primary run-btn"
          onClick={runQuery}
          disabled={running || !sql.trim()}
          title={`Run (${SC.run})`}
        >
          {running ? '⏳ Running…' : '▶ Run'}
        </button>
      </div>

      <textarea
        ref={textareaRef}
        className="sql-textarea"
        value={sql}
        onChange={e => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={session.engine === 'redis'
          ? 'Enter Redis command, e.g. GET mykey'
          : `SELECT * FROM …   (${SC.run} to run)`}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />

      {error && <div className="query-error">{error}</div>}

      {result && (
        <div className="result-area">
          <div className="result-meta">
            {result.rows_affected != null
              ? `${result.rows_affected} row(s) affected`
              : `${result.rows.length} row(s)`}
            {' · '}{result.execution_ms}ms
          </div>
          {result.columns.length > 0 && <ResultGrid result={result} />}
        </div>
      )}
    </div>
  );
}
