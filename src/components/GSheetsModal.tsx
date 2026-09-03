/**
 * Export the current grid to Google Sheets (Export ▾ → Google Sheets…).
 *
 * Service-account flow only — there is no user OAuth: the user points at a
 * service-account JSON key once (remembered in localStorage), and either names
 * an existing spreadsheet (which must be shared with the SA's client_email) or
 * leaves the id empty and gets a new one the SA owns outright.
 *
 * Payload shaping lives in utils/gsheets.ts (pure); this component is the I/O
 * half — the file pick, the invoke, the remembered key path.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { errorDisplay } from '../utils/appError';
import { buildSheetValues, sanitizeSheetName } from '../utils/gsheets';

const KEY_PREF = 'dbgui.gsheetsKeyPath';

interface Props {
  getData: () => { columns: string[]; rows: unknown[][] };
  /** Export base name — default spreadsheet title and tab name */
  tableName?: string;
  onClose: () => void;
}

export function GSheetsModal({ getData, tableName = 'result', onClose }: Props) {
  const [keyPath, setKeyPath] = useState(() => localStorage.getItem(KEY_PREF) ?? '');
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [sheet, setSheet] = useState(() => sanitizeSheetName(tableName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function pickKey() {
    const p = await openDialog({
      multiple: false,
      filters: [{ name: 'Service-account key', extensions: ['json'] }],
    });
    if (typeof p === 'string') setKeyPath(p);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { columns, rows } = getData();
      const values = buildSheetValues(columns, rows);
      // Header rides the columns arg; rows carry the shaped scalars.
      const [header, ...body] = values;
      const tab = sanitizeSheetName(sheet);
      if (keyPath.trim()) localStorage.setItem(KEY_PREF, keyPath.trim());
      const link = await invoke<string>('gsheets_export', {
        keyPath: keyPath.trim(),
        spreadsheetId: spreadsheetId.trim() || null,
        title: tableName,
        sheet: tab,
        columns: header,
        rows: body,
      });
      setUrl(link);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal gsh-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Export to Google Sheets</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="gsh-body">
          <label className="gsh-label">
            Service-account key (.json)
            <div className="gsh-keyrow">
              <input
                value={keyPath}
                onChange={e => setKeyPath(e.target.value)}
                placeholder="/path/to/service-account.json"
                spellCheck={false}
              />
              <button className="toolbar-btn" onClick={() => void pickKey()}>Pick…</button>
            </div>
          </label>

          <label className="gsh-label">
            Spreadsheet ID <span className="form-hint">empty = create a new spreadsheet</span>
            <input
              value={spreadsheetId}
              onChange={e => setSpreadsheetId(e.target.value)}
              placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
              spellCheck={false}
            />
          </label>

          <label className="gsh-label">
            Sheet (tab) name
            <input value={sheet} onChange={e => setSheet(e.target.value)} spellCheck={false} />
          </label>

          {error && (
            <div className="proc-error-bar">
              {error}
              <div className="gsh-errhint">
                Make sure the spreadsheet is shared with the service-account's
                client_email and the Google Sheets API is enabled for its project.
              </div>
            </div>
          )}

          {url && (
            <div className="gsh-done">
              <div className="gsh-label">Exported — your spreadsheet:</div>
              <div className="gsh-keyrow">
                <input readOnly value={url} onFocus={e => e.target.select()} />
                <button className="toolbar-btn" onClick={() => navigator.clipboard.writeText(url)}>
                  Copy link
                </button>
              </div>
            </div>
          )}

          <p className="form-hint gsh-setup">
            One-time setup: create a Google Cloud service account, download its JSON
            key, and enable the Google Sheets API on its project. Share the target
            spreadsheet with the service account's email — or leave the ID empty
            and share nothing: the account owns the sheets it creates.
          </p>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>{url ? 'Close' : 'Cancel'}</button>
          {!url && (
            <button
              className="primary"
              disabled={busy || !keyPath.trim()}
              onClick={() => void submit()}
            >{busy ? 'Exporting…' : 'Export'}</button>
          )}
        </div>
      </div>
    </div>
  );
}
