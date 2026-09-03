/**
 * One table on the ER canvas.
 *
 * Its own component, and memoised, for a specific reason: hover state used to
 * live in `ErDiagram`, so moving the mouse over a single column re-rendered
 * every node on the canvas — roughly six thousand elements on a 400-table
 * schema. Each node now receives only what concerns it (`hoverCol` is null for
 * all but one), so a hover touches two nodes instead of all of them.
 *
 * That means the props here must stay referentially stable across renders.
 * `relCols` and the handlers are memoised by the parent; passing a fresh
 * object or arrow function would silently undo the memo and put the cost
 * straight back.
 */
import { memo } from 'react';
import { ER_NODE_W, visibleColumns } from '../utils/erLayout';
import type { ErTable } from '../utils/erLayout';
import type { Density } from '../utils/diagramModel';

interface Props {
  table: ErTable;
  x: number;
  y: number;
  density: Density;
  /** Header tint, or null for the default. */
  color: string | null;
  selected: boolean;
  /** Something else is focused and this is not part of it. */
  dimmed: boolean;
  /** Matches the current search. */
  matched: boolean;
  /** Column hovered *on this node*, else null — this is what keeps the memo working. */
  hoverCol: string | null;
  /** Columns that take part in a relationship, so hover can be offered on them. */
  relCols: Set<string>;
  /** Schema-drift status vs the snapshot: new table, or changed columns. */
  drift?: 'added' | 'changed';
  onDown: (e: React.MouseEvent, table: string) => void;
  onOpen: (table: string) => void;
  onContext: (e: React.MouseEvent, table: string) => void;
  onHoverCol: (table: string | null, col: string | null) => void;
}

function ErNodeInner({
  table, x, y, density, color, selected, dimmed, matched, hoverCol, relCols, drift,
  onDown, onOpen, onContext, onHoverCol,
}: Props) {
  const cols = visibleColumns(table.columns, density);
  const hidden = table.columns.length - cols.length;

  const cls = 'er-node'
    + (selected ? ' er-selected' : '')
    + (dimmed ? ' er-dim' : '')
    + (matched ? ' er-match' : '')
    + (drift ? ` er-drift-${drift}` : '');

  return (
    <div
      className={cls}
      style={{ left: x, top: y, width: ER_NODE_W }}
      onMouseDown={e => onDown(e, table.name)}
      onDoubleClick={() => onOpen(table.name)}
      onContextMenu={e => onContext(e, table.name)}
    >
      <div
        className="er-node-head"
        style={color ? { background: color, borderColor: color } : undefined}
        title={`${table.name} — drag to move, double-click to browse`}
      >
        <span className="er-node-icon">▦</span>
        <span className="er-node-name">{table.name}</span>
        <span className="er-node-count">{table.columns.length}</span>
      </div>

      {cols.map(c => {
        const hot = hoverCol === c.name;
        return (
          <div
            key={c.name}
            className={`er-col${hot ? ' er-col-hot' : ''}${c.pk ? ' er-col-pk' : ''}`}
            onMouseEnter={() => relCols.has(c.name) && onHoverCol(table.name, c.name)}
            onMouseLeave={() => onHoverCol(null, null)}
          >
            <span className={`er-col-badge ${c.pk ? 'er-badge-pk' : c.fk ? 'er-badge-fk' : c.unique ? 'er-badge-uq' : ''}`}>
              {c.pk ? '🔑' : c.fk ? '↗' : c.unique ? '◆' : ''}
            </span>
            <span className={`er-col-name ${c.pk ? 'er-pk' : ''}`}>{c.name}</span>
            <span className="er-col-type">{c.type}</span>
          </div>
        );
      })}

      {/* Say what is not being shown. A node that silently drops 56 columns
          looks like a table with four columns. */}
      {hidden > 0 && density !== 'header' && (
        <div className="er-col er-col-more">+{hidden} more</div>
      )}
    </div>
  );
}

export const ErNode = memo(ErNodeInner);
