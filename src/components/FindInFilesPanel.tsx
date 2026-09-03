/**
 * Find in Files — search a folder of `.sql` scripts.
 *
 * The editor could only ever search the buffer in front of you, which is the
 * one thing every editor in the comparison set does *not* limit itself to.
 * A migration lives in a directory, and "which script drops that column" is a
 * question about the directory.
 *
 * The walk, the decoding and the bounds are in the Rust `find_in_files`
 * command; this is the form and the result list. Clicking a hit opens the file
 * in a tab (through the same path-preserving open the File menu uses) and
 * jumps to the line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { errorDisplay } from '../utils/appError';
import { baseName, dirName } from '../utils/sqlFile';

interface FileMatch { path: string; line: number; text: string }
interface FindResult { matches: FileMatch[]; filesSearched: number; truncated: boolean }

const DIR_KEY = 'dbgui.findInFiles.dir';

interface Props {
  /** Folder to start in — the directory of the file in front of you, if any. */
  initialDir?: string;
  onClose: () => void;
}

export function FindInFilesPanel({ initialDir, onClose }: Props) {
  const [dir, setDir] = useState(() => {
    try { return initialDir || localStorage.getItem(DIR_KEY) || ''; } catch { return initialDir || ''; }
  });
  const [query, setQuery] = useState('');
  const [exts, setExts] = useState('sql,txt');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<FindResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => { queryRef.current?.focus(); }, []);

  const pickDir = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === 'string') {
      setDir(picked);
      try { localStorage.setItem(DIR_KEY, picked); } catch { /* quota */ }
    }
  }, []);

  const run = useCallback(async () => {
    if (!dir || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<{ matches: FileMatch[]; files_searched: number; truncated: boolean }>(
        'find_in_files', {
          dir,
          query,
          extensions: exts.split(',').map(e => e.trim().replace(/^\./, '')).filter(Boolean),
          caseSensitive,
        });
      setResult({ matches: r.matches, filesSearched: r.files_searched, truncated: r.truncated });
      try { localStorage.setItem(DIR_KEY, dir); } catch { /* quota */ }
    } catch (e) {
      setError(errorDisplay(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [dir, query, exts, caseSensitive]);

  /** Open the file this hit is in and put the caret on the line. */
  const openHit = useCallback(async (m: FileMatch) => {
    try {
      const f = await invoke<{ text: string; encoding: string; eol: string; mtimeMs: number }>(
        'sqlfile_open', { path: m.path });
      window.dispatchEvent(new CustomEvent('dbgui:open-sql-file', {
        detail: { path: m.path, sql: f.text, encoding: f.encoding, eol: f.eol, mtimeMs: f.mtimeMs },
      }));
      // After the tab exists. A frame is enough and avoids threading a
      // callback through the open event for one cursor move.
      setTimeout(() => window.dispatchEvent(
        new CustomEvent('dbgui:goto-line-number', { detail: { line: m.line } })), 60);
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, []);

  // Group by file, so ten hits in one script read as one script.
  const byFile = new Map<string, FileMatch[]>();
  for (const m of result?.matches ?? []) {
    const list = byFile.get(m.path);
    if (list) list.push(m); else byFile.set(m.path, [m]);
  }

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">🗂 Find in files</span>
        <input
          ref={queryRef}
          className="fif-input"
          placeholder="Text to find…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void run(); }}
        />
        <button className="toolbar-btn" onClick={pickDir} title={dir || 'Choose a folder'}>
          {dir ? `📁 ${baseName(dir) || dir}` : '📁 Folder…'}
        </button>
        <label className="dg-field-inline">
          <span>Types</span>
          <input className="fif-ext" value={exts} onChange={e => setExts(e.target.value)}
            title="Comma-separated extensions; blank searches every file" />
        </label>
        <label className="form-check">
          <input type="checkbox" checked={caseSensitive}
            onChange={e => setCaseSensitive(e.target.checked)} />
          Aa
        </label>
        <button className="toolbar-btn" onClick={() => void run()} disabled={busy || !dir || !query.trim()}>
          {busy ? 'Searching…' : 'Find'}
        </button>
        <span className="dv-desc" style={{ marginLeft: 8 }}>
          {result && `${result.matches.length} in ${byFile.size} of ${result.filesSearched} files`}
          {result?.truncated && ' · partial'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}
      {!dir && !error && (
        <div className="db-error">Choose a folder to search.</div>
      )}
      {/* A truncated list presented as a complete one is a wrong answer, so it
          says so rather than quietly stopping. */}
      {result?.truncated && (
        <div className="er-hint-bar">
          <span>
            Stopped at the result cap — there are more matches than these. Narrow the search
            or pick a deeper folder.
          </span>
        </div>
      )}

      <div className="fif-results">
        {result && result.matches.length === 0 && !busy && (
          <div className="db-error">No matches in {result.filesSearched} files.</div>
        )}
        {[...byFile.entries()].map(([path, hits]) => (
          <div key={path} className="fif-file">
            <div className="fif-file-head" title={path}>
              <strong>{baseName(path)}</strong>
              <span className="fif-dir">{dirName(path)}</span>
              <span className="fif-count">{hits.length}</span>
            </div>
            {hits.map((m, i) => (
              <div
                key={`${m.line}-${i}`}
                className="fif-hit"
                onClick={() => void openHit(m)}
                title="Open this file at this line"
              >
                <span className="fif-line">{m.line}</span>
                <span className="fif-text">{m.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
