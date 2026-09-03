/**
 * ⇄ Compare SQL — two scripts side-by-side with a live diff.
 *
 * Point it at two dumps, or an up-migration against its down, and the changed
 * lines light up between the panes. Each side loads from a file or is edited
 * in place (paste and go); a swap flips the two so "what changed" and "what it
 * changed back to" are one click apart.
 *
 * The diff itself is CodeMirror's `MergeView`: two real editors sharing a
 * scroll, with per-chunk highlighting and collapsed stretches of unchanged
 * text. It is imperative and lives outside React's render — built once on
 * mount, fed through `dispatch`, torn down on unmount — while React owns only
 * the toolbar, the side labels and the change tally. Engine-agnostic: the two
 * scripts never touch a connection, so nothing here runs SQL.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { MergeView } from '@codemirror/merge';
import { EditorView, lineNumbers } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { sql, MSSQL, MySQL, PostgreSQL, StandardSQL } from '@codemirror/lang-sql';
import { appEditorTheme } from '../utils/editorTheme';
import { baseName } from '../utils/sqlFile';
import { diffStats, summarizeDiff } from '../utils/diffStats';
import type { Session, Engine } from '../types';

interface Props {
  session: Session;
  onClose: () => void;
}

type Side = 'a' | 'b';

/** lang-sql dialect for the connection's engine — generic SQL when unknown. */
function dialectExtension(engine: Engine): Extension {
  // The main editor already resolves `sqlserver` to MSSQL; this one fell
  // through to StandardSQL, so a T-SQL script being diffed lost its
  // `[bracketed]` names and `@variables` to the wrong highlighter.
  const dialect = engine === 'mysql' ? MySQL
    : engine === 'postgres' ? PostgreSQL
    : engine === 'sqlserver' ? MSSQL
    : StandardSQL;
  return sql({ dialect, upperCaseKeywords: false });
}

export function SqlComparePanel({ session, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);

  // React mirrors the two docs purely so the toolbar tally stays live as the
  // user edits, loads or swaps — the editors remain the source of truth.
  const [leftText, setLeftText] = useState('');
  const [rightText, setRightText] = useState('');
  const [leftName, setLeftName] = useState('Left');
  const [rightName, setRightName] = useState('Right');
  const [error, setError] = useState<string | null>(null);

  // Build the MergeView once. Recreated only if the engine changes (the SQL
  // dialect is baked into each editor's extensions at construction).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const sideExtensions = (onDoc: (text: string) => void): Extension[] => [
      lineNumbers(),
      appEditorTheme,
      dialectExtension(session.engine),
      EditorView.lineWrapping,
      EditorView.updateListener.of(u => {
        if (u.docChanged) onDoc(u.state.doc.toString());
      }),
    ];

    const mv = new MergeView({
      parent: host,
      a: { doc: '', extensions: sideExtensions(setLeftText) },
      b: { doc: '', extensions: sideExtensions(setRightText) },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    mergeRef.current = mv;
    return () => {
      mv.destroy();
      mergeRef.current = null;
    };
  }, [session.engine]);

  /** Replace one side's whole document. */
  const setDoc = useCallback((side: Side, text: string) => {
    const mv = mergeRef.current;
    if (!mv) return;
    const view = side === 'a' ? mv.a : mv.b;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, []);

  const loadFile = useCallback(async (side: Side) => {
    setError(null);
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }],
      });
      if (typeof path !== 'string') return; // cancelled
      const text = await invoke<string>('read_text_file', { path });
      setDoc(side, text);
      const label = baseName(path);
      if (side === 'a') setLeftName(label); else setRightName(label);
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [setDoc]);

  const swap = useCallback(() => {
    const mv = mergeRef.current;
    if (!mv) return;
    const a = mv.a.state.doc.toString();
    const b = mv.b.state.doc.toString();
    setDoc('a', b);
    setDoc('b', a);
    setLeftName(rightName);
    setRightName(leftName);
  }, [setDoc, leftName, rightName]);

  const clear = useCallback(() => {
    setError(null);
    setDoc('a', '');
    setDoc('b', '');
    setLeftName('Left');
    setRightName('Right');
  }, [setDoc]);

  const stats = useMemo(() => diffStats(leftText, rightText), [leftText, rightText]);
  const bothEmpty = leftText.length === 0 && rightText.length === 0;

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">⇄ Compare SQL</span>
        <span className="dv-desc">{session.connectionName}</span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" onClick={() => void loadFile('a')} title="Load the left side from a file">
          Load left…
        </button>
        <button className="toolbar-btn" onClick={() => void loadFile('b')} title="Load the right side from a file">
          Load right…
        </button>
        <button className="toolbar-btn" onClick={swap} title="Swap the two sides">
          ⇄ Swap
        </button>
        <button className="toolbar-btn" onClick={clear} title="Clear both sides">
          Clear
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="proc-toolbar" style={{ background: 'var(--bg)' }}>
        <span className="dv-desc" style={{ flex: 1, minWidth: 0 }}>◀ {leftName}</span>
        <span
          className="dv-desc"
          style={{ color: bothEmpty ? undefined : stats.identical ? 'var(--green)' : 'var(--yellow)' }}
        >
          {bothEmpty ? 'Load or paste two scripts to compare' : summarizeDiff(stats)}
        </span>
        <span className="dv-desc" style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>{rightName} ▶</span>
      </div>

      <div className="sqlcmp-host" ref={hostRef} />
    </div>
  );
}
