/**
 * Record view (roadmap A4): the selected row transposed into a
 * column → value list, with copy-as-JSON. Docks on the right of the grid.
 */
import { cellText } from '../utils/exporters';
import { copyToClipboard } from '../utils/exportersIo';

interface Props {
  columns: { name: string }[];
  row: unknown[];
  rowIndex: number;
  onClose: () => void;
}

export function RecordView({ columns, row, rowIndex, onClose }: Props) {
  const asJson = () => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => { obj[c.name] = row[i] ?? null; });
    return JSON.stringify(obj, null, 2);
  };
  return (
    <div className="rv-panel">
      <div className="rv-head">
        <span className="rv-title">Record · row {rowIndex + 1}</span>
        <button className="toolbar-btn" onClick={() => copyToClipboard(asJson())}>Copy JSON</button>
        <button className="modal-close" onClick={onClose}>×</button>
      </div>
      <div className="rv-body">
        {columns.map((c, i) => (
          <div key={c.name} className="rv-row">
            <div className="rv-key">{c.name}</div>
            <div className={`rv-val ${row[i] === null || row[i] === undefined ? 'rv-null' : ''}`}>
              {row[i] === null || row[i] === undefined ? 'NULL' : cellText(row[i])}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
