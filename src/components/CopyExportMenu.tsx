/**
 * Copy ▾ / Export ▾ dropdowns for any grid surface.
 * Operates on the current selection when one exists, else the full result —
 * and every format includes the column header (ASCII/Markdown tables get the
 * full ruled header even for a mid-result selection).
 */
import { errorDisplay } from '../utils/appError';
import { useEffect, useRef, useState } from 'react';
import { serialize, FORMAT_LABELS } from '../utils/exporters';
import { exportAs, copyToClipboard, copyForExcel, exportXlsx, exportParquet } from '../utils/exportersIo';
import type { ExportFormat } from '../utils/exporters';
import { basename } from '../utils/platform';
import { GSheetsModal } from './GSheetsModal';

const FORMATS: ExportFormat[] = [
  'tsv', 'csv', 'json', 'ascii', 'markdown', 'insert', 'html', 'xml', 'latex',
];

interface Props {
  getData: () => { columns: string[]; rows: unknown[][] };
  /** Used for INSERT statements + export file name */
  tableName?: string;
  /** Dialect for the INSERT format (identifier quoting + literal escaping).
   *  Pass the active connection's engine; defaults to MySQL. */
  engine?: string;
  hasSelection?: boolean;
  onNote?: (msg: string) => void;
}

export function CopyExportMenu({ getData, tableName = 'result', engine = 'mysql', hasSelection, onNote }: Props) {
  const [open, setOpen] = useState<'copy' | 'export' | null>(null);
  const [gsheetsOpen, setGsheetsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * File → Export Results… opens this dropdown rather than exporting.
   *
   * The format is the user's choice, and the menu deliberately does not make
   * it for them: an "Export" that silently picks CSV is a different feature
   * from the button next to the grid, and two ways to export that disagree is
   * how one of them ends up wrong.
   *
   * Several grids can be mounted at once (a browser tab per table, panels
   * behind the active one). `offsetParent === null` is true for anything not
   * being displayed, so only the visible one answers — without this every
   * hidden grid would open its dropdown too.
   */
  useEffect(() => {
    const onExport = () => {
      if (rootRef.current?.offsetParent == null) return;
      setOpen('export');
    };
    window.addEventListener('dbgui:grid-export', onExport);
    return () => window.removeEventListener('dbgui:grid-export', onExport);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  async function handleCopy(format: ExportFormat) {
    setOpen(null);
    try {
      const { columns, rows } = getData();
      await copyToClipboard(serialize(format, columns, rows, tableName, engine));
      onNote?.(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'} as ${FORMAT_LABELS[format]}`);
    } catch (e) {
      onNote?.(`Copy failed: ${errorDisplay(e)}`);
    }
  }

  async function handleExport(format: ExportFormat) {
    setOpen(null);
    try {
      const { columns, rows } = getData();
      const path = await exportAs(format, columns, rows, tableName, engine);
      if (path) onNote?.(`Saved ${basename(path)}`);
    } catch (e) {
      onNote?.(`Export failed: ${errorDisplay(e)}`);
    }
  }

  const scope = hasSelection ? 'selection' : 'all rows';

  return (
    <div className="cem-root" ref={rootRef}>
      <button
        className={`toolbar-btn ${open === 'copy' ? 'active' : ''}`}
        onClick={() => setOpen(open === 'copy' ? null : 'copy')}
        title={`Copy ${scope} to clipboard (header included)`}
      >Copy ▾</button>
      <button
        className={`toolbar-btn ${open === 'export' ? 'active' : ''}`}
        onClick={() => setOpen(open === 'export' ? null : 'export')}
        title={`Export ${scope} to a file`}
      >Export ▾</button>

      {open && (
        <div className="cem-menu">
          <div className="cem-scope">{open === 'copy' ? 'Copy' : 'Export'} {scope}</div>
          {FORMATS.map(f => (
            <button
              key={f}
              className="cem-item"
              onClick={() => (open === 'copy' ? handleCopy(f) : handleExport(f))}
            >{FORMAT_LABELS[f]}</button>
          ))}
          {open === 'copy' && (
            <button className="cem-item" onClick={async () => {
              setOpen(null);
              try {
                const { columns, rows } = getData();
                await copyForExcel(columns, rows);
                onNote?.(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'} for Excel`);
              } catch (e) { onNote?.(`Copy failed: ${errorDisplay(e)}`); }
            }}>For Excel / Sheets</button>
          )}
          {open === 'export' && (
            <button className="cem-item" onClick={async () => {
              setOpen(null);
              try {
                const { columns, rows } = getData();
                const path = await exportXlsx(columns, rows, tableName);
                if (path) onNote?.(`Saved ${basename(path)}`);
              } catch (e) { onNote?.(`Export failed: ${errorDisplay(e)}`); }
            }}>Excel (.xlsx)</button>
          )}
          {open === 'export' && (
            <button className="cem-item" onClick={async () => {
              setOpen(null);
              try {
                const { columns, rows } = getData();
                const path = await exportParquet(columns, rows, tableName);
                if (path) onNote?.(`Wrote ${basename(path)} — ${rows.length} row${rows.length === 1 ? '' : 's'}`);
              } catch (e) { onNote?.(`Export failed: ${errorDisplay(e)}`); }
            }}>Parquet (.parquet)</button>
          )}
          {open === 'export' && (
            <button className="cem-item" onClick={() => {
              setOpen(null);
              setGsheetsOpen(true);
            }}>Google Sheets…</button>
          )}
        </div>
      )}
      {gsheetsOpen && (
        <GSheetsModal getData={getData} tableName={tableName} onClose={() => setGsheetsOpen(false)} />
      )}
    </div>
  );
}
