/**
 * AI assistant modal: generate SQL from a natural-language request, explain the
 * current statement, or propose a fix for a failed one. Talks to the backend
 * (utils/aiClient) which supplies the vault-stored key. Explain/Fix run on open;
 * Generate waits for a prompt. Result is always reviewable before it lands in
 * the editor — nothing is auto-run.
 */
import { useEffect, useRef, useState } from 'react';
import { errorDisplay } from '../utils/appError';
import { shortcuts } from '../utils/platform';
import { aiGenerateSql, aiExplainSql, aiFixSql, unfenceSql, aiHasKey } from '../utils/aiClient';

export type AiMode = 'generate' | 'explain' | 'fix';

interface Props {
  engine: string;
  mode: AiMode;
  /** The statement, for explain/fix. */
  sql?: string;
  /** The error text, for fix. */
  error?: string;
  onInsert: (sql: string) => void;
  onClose: () => void;
}

const TITLE: Record<AiMode, string> = {
  generate: '✦ Generate SQL',
  explain: '✦ Explain statement',
  fix: '✦ Fix statement',
};

export function AiAssistModal({ engine, mode, sql, error, onInsert, onClose }: Props) {
  const [request, setRequest] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noKey, setNoKey] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isSqlResult = mode !== 'explain'; // generate/fix return SQL; explain returns prose

  const run = async (prompt?: string) => {
    setBusy(true); setErr(null);
    try {
      let out: string;
      if (mode === 'generate') out = unfenceSql(await aiGenerateSql(prompt ?? request, engine));
      else if (mode === 'explain') out = await aiExplainSql(sql ?? '', engine);
      else out = unfenceSql(await aiFixSql(sql ?? '', error ?? '', engine));
      setResult(out);
    } catch (e) {
      setErr(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  };

  // Check the key once; explain/fix run immediately, generate waits for input.
  useEffect(() => {
    aiHasKey().then(has => {
      if (!has) { setNoKey(true); return; }
      if (mode !== 'generate') void run();
      else inputRef.current?.focus();
    }).catch(() => setNoKey(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal ai-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{TITLE[mode]}</span>
          <span className="dv-desc">{engine}</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>

        {noKey ? (
          <div className="ai-body">
            <p className="form-hint">
              No AI key is set. Add a provider, endpoint, model and API key in <b>Settings → AI</b>,
              then try again.
            </p>
          </div>
        ) : (
          <div className="ai-body">
            {mode === 'generate' && (
              <>
                <textarea ref={inputRef} className="ai-input" rows={3}
                  placeholder="Describe the query — e.g. “top 10 customers by total order value in 2025”"
                  value={request} onChange={e => setRequest(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(); }} />
                <div className="ai-actions">
                  <button className="primary" disabled={busy || !request.trim()} onClick={() => void run()}>
                    {busy ? 'Generating…' : `Generate (${shortcuts().run})`}
                  </button>
                </div>
              </>
            )}

            {(mode === 'explain' || mode === 'fix') && sql && (
              <pre className="ai-source">{sql}</pre>
            )}

            {busy && mode !== 'generate' && <div className="ai-loading">Thinking…</div>}
            {err && <div className="proc-error-bar">{err}</div>}

            {result && (
              <>
                <pre className={isSqlResult ? 'ai-result ai-result-sql' : 'ai-result'}>{result}</pre>
                <div className="ai-actions">
                  <button className="toolbar-btn" onClick={() => navigator.clipboard.writeText(result)}>Copy</button>
                  {isSqlResult && (
                    <button className="primary" onClick={() => { onInsert(result); onClose(); }}>
                      Insert into editor
                    </button>
                  )}
                  {mode === 'generate' && (
                    <button className="toolbar-btn" disabled={busy} onClick={() => void run()}>Regenerate</button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
