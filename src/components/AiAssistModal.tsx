/**
 * AI assistant modal: generate SQL from a natural-language request, explain the
 * current statement, or propose a fix for a failed one. Talks to the backend
 * (utils/aiClient) which supplies the vault-stored key. Explain/Fix run on open;
 * Generate waits for a prompt. Result is always reviewable before it lands in
 * the editor — nothing is auto-run.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorDisplay } from '../utils/appError';
import { shortcuts } from '../utils/platform';
import { getPref, PREFS } from '../store/preferences';
import { aiGenerateSql, aiExplainSql, aiExplainPlan, aiFixSql, unfenceSql, aiHasKey, aiCancel } from '../utils/aiClient';
import type { AiSchemaContext } from '../utils/aiSchema';
import { aiKeyRequired } from '../utils/aiProviders';

export type AiMode = 'generate' | 'explain' | 'fix' | 'plan';

interface Props {
  engine: string;
  mode: AiMode;
  /** The statement, for explain/fix, or plan evidence for plan mode. */
  sql?: string;
  /** The error text, for fix. */
  error?: string;
  getSchemaContext: (text: string) => Promise<AiSchemaContext>;
  onInsert: (sql: string) => void;
  onClose: () => void;
}

const TITLE: Record<AiMode, string> = {
  generate: '✦ Generate SQL',
  explain: '✦ Explain statement',
  fix: '✦ Fix statement',
  plan: '✦ Explain execution plan',
};

export function AiAssistModal({ engine, mode, sql, error, getSchemaContext, onInsert, onClose }: Props) {
  const [request, setRequest] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noKey, setNoKey] = useState(false);
  const [schemaPreview, setSchemaPreview] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRequest = useRef<string | null>(null);
  const runSeq = useRef(0);
  const previewSeq = useRef(0);

  const isSqlResult = mode === 'generate' || mode === 'fix';

  const cancelActive = useCallback(() => {
    runSeq.current++;
    if (activeRequest.current) void aiCancel(activeRequest.current);
    activeRequest.current = null;
  }, []);
  const close = useCallback(() => {
    cancelActive();
    onClose();
  }, [cancelActive, onClose]);

  const run = async (prompt?: string) => {
    setBusy(true); setErr(null);
    const seq = ++runSeq.current;
    const sourceText = mode === 'generate' ? prompt ?? request : sql ?? '';
    const schema = await getSchemaContext(sourceText);
    if (seq !== runSeq.current) return;
    setSchemaPreview(schema.text);
    const aiRequest = mode === 'generate' ? aiGenerateSql(sourceText, engine, schema.text)
      : mode === 'explain' ? aiExplainSql(sourceText, engine, schema.text)
        : mode === 'plan' ? aiExplainPlan(sourceText, engine, schema.text)
          : aiFixSql(sourceText, error ?? '', engine, schema.text);
    activeRequest.current = aiRequest.requestId;
    try {
      const raw = await aiRequest.promise;
      if (activeRequest.current === aiRequest.requestId) {
        setResult(isSqlResult ? unfenceSql(raw) : raw);
      }
    } catch (e) {
      if (activeRequest.current === aiRequest.requestId) setErr(errorDisplay(e));
    } finally {
      if (activeRequest.current === aiRequest.requestId) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };

  // Hosted presets need a key; OpenAI-compatible local servers may not.
  useEffect(() => {
    aiHasKey().then(has => {
      if (!has && aiKeyRequired(getPref(PREFS.aiProvider), getPref(PREFS.aiBaseUrl))) {
        setNoKey(true); return;
      }
      if (mode !== 'generate') void run();
      else inputRef.current?.focus();
    }).catch(() => setNoKey(true));
    return () => cancelActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode !== 'generate' || !request.trim()) { setSchemaPreview(''); return; }
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      void getSchemaContext(request).then(context => {
        if (seq === previewSeq.current) setSchemaPreview(context.text);
      }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [request, mode, getSchemaContext]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div className="modal ai-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{TITLE[mode]}</span>
          <span className="dv-desc">{engine}</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={close} title="Close">×</button>
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

            {mode !== 'generate' && sql && (
              <pre className="ai-source">{sql}</pre>
            )}

            {schemaPreview && (
              <details className="ai-context">
                <summary>Schema metadata sent to the provider — no row values</summary>
                <pre>{schemaPreview}</pre>
              </details>
            )}
            {busy && mode !== 'generate' && <div className="ai-loading">Thinking…</div>}
            {err && <div className="proc-error-bar">{err}</div>}

            {result && (
              <>
                <pre className={isSqlResult ? 'ai-result ai-result-sql' : 'ai-result'}>{result}</pre>
                <div className="ai-actions">
                  <button className="toolbar-btn" onClick={() => navigator.clipboard.writeText(result)}>Copy</button>
                  {isSqlResult && (
                    <button className="primary" onClick={() => { onInsert(result); close(); }}>
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
