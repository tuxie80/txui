/**
 * The outline beside the SQL editor.
 *
 * Forty statements in a migration is normal, and scrolling is a poor way to
 * answer the question you actually have about one: *where does this script
 * change things?* So the list leads with classification — a coloured weight
 * stripe and the object each statement touches — rather than with the text,
 * which the editor is already showing.
 *
 * All the analysis is in utils/sqlOutline; this only draws it.
 */
import { useEffect, useMemo, useState } from 'react';
import { outline, outlineSummary, itemAt } from '../utils/sqlOutline';
import type { OutlineItem, OutlineWeight } from '../utils/sqlOutline';
import { getPref, PREFS } from '../store/preferences';

interface Props {
  sql: string;
  /** Caret offset, so the current statement can be marked. */
  caret?: number;
  /** Bookmarked lines — a statement containing one is flagged. */
  bookmarks?: number[];
  /** Jump the editor to a statement. */
  onGoto: (from: number, to: number) => void;
  onClose: () => void;
}

/** A glyph per weight — shape as well as colour, for the same reason as always. */
const MARK: Record<OutlineWeight, string> = {
  read: '·', write: '✎', ddl: '⚑', destructive: '⚠', neutral: '·',
};

export function SqlOutline({ sql, caret, bookmarks = [], onGoto, onClose }: Props) {
  const [filter, setFilter] = useState('');

  // Outlining a large script on every keystroke would make typing janky, so it
  // trails the buffer by a beat. The editor is the source of truth meanwhile.
  const [debounced, setDebounced] = useState(sql);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(sql), 150);
    return () => clearTimeout(t);
  }, [sql]);

  const items = useMemo(
    () => outline(debounced, getPref(PREFS.sqlDelimiter)), [debounced]);
  const current = useMemo(
    () => (caret === undefined ? undefined : itemAt(items, caret)), [items, caret]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.label.toLowerCase().includes(q)
      || i.kind.includes(q)
      || (i.target ?? '').toLowerCase().includes(q));
  }, [items, filter]);

  return (
    <aside className="sqo">
      <div className="sqo-head">
        <span className="sqo-title">Outline</span>
        <button className="icon-btn" onClick={onClose} title="Hide outline">×</button>
      </div>
      <div className="sqo-summary">{outlineSummary(items)}</div>
      {items.length > 6 && (
        <input
          className="sqo-filter"
          placeholder="Filter…"
          value={filter}
          spellCheck={false}
          onChange={e => setFilter(e.target.value)}
        />
      )}
      <div className="sqo-list">
        {shown.length === 0 && (
          <div className="sqo-empty">
            {items.length ? 'Nothing matches.' : 'Nothing to outline yet.'}
          </div>
        )}
        {shown.map(item => (
          <OutlineRow
            key={item.index}
            item={item}
            active={current?.index === item.index}
            marked={bookmarks.some(l => l >= item.line
              && l <= item.line + (debounced.slice(item.from, item.to).split('\n').length - 1))}
            onGoto={onGoto}
          />
        ))}
      </div>
    </aside>
  );
}

function OutlineRow(
  { item, active, marked, onGoto }:
  { item: OutlineItem; active: boolean; marked: boolean;
    onGoto: (from: number, to: number) => void },
) {
  return (
    <button
      className={`sqo-row w-${item.weight}${active ? ' active' : ''}${marked ? ' marked' : ''}`}
      onClick={() => onGoto(item.from, item.to)}
      title={`${item.label}\nline ${item.line}`}
    >
      <span className="sqo-n">{item.index}</span>
      <span className="sqo-mark">{MARK[item.weight]}</span>
      <span className="sqo-body">
        <span className="sqo-kind">{item.kind}</span>
        {item.target && <span className="sqo-target">{item.target}</span>}
        <span className="sqo-label">{item.label}</span>
      </span>
      <span className="sqo-line">{marked ? '🔖' : ''}{item.line}</span>
    </button>
  );
}
