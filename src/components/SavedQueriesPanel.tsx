/**
 * Saved queries / snippets — SQLite-backed, folder-organized, searchable.
 * Click inserts into the editor; ⭐ saves the current editor buffer.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { fuzzyScore } from '../utils/fuzzy';

export interface SavedQuery {
  id: number;
  name: string;
  folder: string;
  sql: string;
  updated_at: string;
}

interface Props {
  /** Current editor buffer — offered when saving */
  currentSql: string;
  onInsert: (sql: string) => void;
  onClose: () => void;
}

export function SavedQueriesPanel({ currentSql, onInsert, onClose }: Props) {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveFolder, setSaveFolder] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<SavedQuery[]>('list_saved_queries').then(setQueries).catch(e => setError(errorDisplay(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return queries;
    return queries
      .map(item => ({ item, score: fuzzyScore(q, `${item.folder} ${item.name}`) }))
      .filter((m): m is { item: SavedQuery; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score)
      .map(m => m.item);
  }, [queries, search]);

  const folders = useMemo(() => {
    const map = new Map<string, SavedQuery[]>();
    for (const item of filtered) {
      const f = item.folder || '';
      if (!map.has(f)) map.set(f, []);
      map.get(f)!.push(item);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  async function handleSave() {
    setError(null);
    try {
      await invoke('save_query', {
        id: null, name: saveName.trim(), folder: saveFolder.trim(), sql: currentSql,
      });
      setSaving(false);
      setSaveName('');
      load();
      window.dispatchEvent(new CustomEvent('dbgui:saved-queries-changed'));
    } catch (e) {
      setError(errorDisplay(e));
    }
  }

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke('delete_saved_query', { id }).catch(() => {});
    setQueries(prev => prev.filter(q => q.id !== id));
    window.dispatchEvent(new CustomEvent('dbgui:saved-queries-changed'));
  }

  return (
    <div className="history-panel">
      <div className="history-header">
        <span className="history-title">Saved queries</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="toolbar-btn"
            disabled={!currentSql.trim()}
            title={currentSql.trim() ? 'Save the current editor content' : 'Editor is empty'}
            onClick={() => { setSaving(s => !s); setSaveName(''); }}
          >⭐ Save current</button>
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
      </div>

      {saving && (
        <div className="sq-save-row">
          <input
            autoFocus
            placeholder="Name"
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && saveName.trim()) handleSave(); }}
          />
          <input
            placeholder="Folder (optional)"
            value={saveFolder}
            onChange={e => setSaveFolder(e.target.value)}
          />
          <button className="primary" disabled={!saveName.trim()} onClick={handleSave}>Save</button>
        </div>
      )}

      {error && <div className="proc-error-bar">{error}</div>}

      <div className="sq-alias-hint">
        💡 Aliases: include <code>:1</code> <code>:2</code> … in a saved query, then run it from the
        editor as <code>name val1 val2</code> — parameters substitute as typed.
      </div>

      <div className="history-search">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search saved queries…"
        />
      </div>

      <div className="history-list">
        {queries.length === 0 && (
          <div className="history-empty">Nothing saved yet — write a query and hit ⭐ Save current.</div>
        )}
        {folders.map(([folder, items]) => (
          <div key={folder || '(root)'}>
            {folder && <div className="sq-folder">{folder}</div>}
            {items.map(item => (
              <div key={item.id} className="history-item" onClick={() => onInsert(item.sql)}>
                <div className="sq-name">{item.name}</div>
                <pre className="history-sql">{item.sql.length > 160 ? item.sql.slice(0, 160) + '…' : item.sql}</pre>
                <div className="history-meta">
                  <span>{item.updated_at.replace('T', ' ').slice(0, 16)}</span>
                  <button
                    className="history-delete"
                    onClick={e => handleDelete(item.id, e)}
                    title="Delete"
                  >×</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
