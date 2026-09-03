/**
 * ⌘K "Open Anything" palette — ONE fuzzy surface over commands, connections,
 * sessions, schema objects (tables / views / routines), columns and saved
 * queries. Results are sectioned and ranked by utils/openAnything (the same
 * code the tests drive). ⌘P is this same palette pre-filtered to the
 * table/column sections — the go-to-table muscle memory preserved.
 *
 * SqlEditor's Find Action reuses the component without sections; items
 * carry no `section`, so no headers render and the flat ranking matches the
 * old behaviour. Keyboard-first: arrows navigate, Enter runs, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchOpenAnything } from '../utils/openAnything';
import type { OpenEntry, OpenSection } from '../utils/openAnything';

export interface PaletteItem extends OpenEntry {
  hint?: string;    // right-aligned context (engine, group, shortcut)
  /** Glyph before the label — an emoji string or a <PanelIcon> element. */
  icon?: React.ReactNode;
  action: () => void;
}

interface Props {
  items: PaletteItem[];
  onClose: () => void;
  /** Restrict the listed sections — ⌘P passes ['table', 'column']. */
  onlySections?: readonly OpenSection[];
  /** Per-section cap override (go-to-table browses deeper than ⌘K). */
  perSection?: number;
  placeholder?: string;
}

export function CommandPalette({ items, onClose, onlySections, perSection, placeholder }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Sectioned ranking (utils/openAnything) — pure, capped, and identical to
  // what the unit tests assert.
  const groups = useMemo(
    () => searchOpenAnything(items, query, { onlySections, perSection }),
    [items, query, onlySections, perSection]);
  const matches = useMemo(() => groups.flatMap(g => g.items), [groups]);
  // Headers only when the caller sectioned its items — Find Action didn't.
  const sectioned = useMemo(() => items.some(i => i.section), [items]);

  const sel = Math.min(cursor, Math.max(0, matches.length - 1));

  function run(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    item.action();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape')    { e.preventDefault(); onClose(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, matches.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); run(matches[sel]); }
  }

  // Keep the selected row in view
  useEffect(() => {
    listRef.current
      ?.querySelector('.cp-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [sel, matches]);

  let flat = 0;

  return (
    <div className="cp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp-modal">
        <input
          ref={inputRef}
          className="cp-input"
          placeholder={placeholder ?? 'Open anything — commands, connections, tables, columns, saved queries…'}
          value={query}
          onChange={e => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={handleKey}
        />
        <div className="cp-list" ref={listRef}>
          {matches.length === 0 && <div className="cp-empty">No matches</div>}
          {groups.map(g => (
            <div key={g.section}>
              {sectioned && <div className="cp-section">{g.title}</div>}
              {g.items.map(item => {
                const i = flat++;
                return (
                  <div
                    key={item.id}
                    className={`cp-item ${i === sel ? 'selected' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onMouseDown={e => { e.preventDefault(); run(item); }}
                  >
                    {item.icon && <span className="cp-icon">{item.icon}</span>}
                    <span className="cp-label">{item.label}</span>
                    {item.hint && <span className="cp-hint">{item.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
