/**
 * An in-DOM dropdown that replaces a native `<select>`.
 *
 * Why this exists: a native select is two renderers. The closed control is
 * HTML and follows the app's CSS; the opened list is an OS-toolkit popup —
 * and on Linux/WebKitGTK that means a GTK menu with the desktop's font,
 * ignoring page CSS entirely (the white-popup bug `color-scheme`+`GTK_THEME`
 * fixed, the font mismatch it cannot). macOS and Windows popups are native
 * too, just less jarring. Rendering the list ourselves makes the control look
 * and behave IDENTICALLY on all three desktops — the portability doctrine
 * applied to a widget.
 *
 * Deliberately minimal: click opens, click picks, Esc/outside-click closes,
 * ↑/↓+Enter work when the list is focused. Anchored with position:fixed (the
 * tab bar clips overflow), like the plugin menu.
 */
import { useEffect, useRef, useState } from 'react';

export interface MenuSelectOption {
  value: string;
  label: string;
}

export function MenuSelect({ value, options, onChange, className, title }: {
  value: string;
  options: MenuSelectOption[];
  onChange: (value: string) => void;
  /** Extra class on the wrapper — the control's look (font, colors) comes from
   *  it, so the button and the list always share one font. */
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState<{ left: number; top: number; width: number } | null>(null);
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    listRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (v: string) => { setOpen(null); onChange(v); };

  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    // Opening starts the highlight on the current value — the native behavior.
    setHi(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen({ left: r.left, top: r.bottom + 2, width: r.width });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(options.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter' && options[hi]) { e.preventDefault(); pick(options[hi].value); }
  };

  const current = options.find(o => o.value === value)?.label ?? value;

  return (
    <span className={`mselect${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="mselect-btn"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open !== null}
        onClick={toggle}
      >
        <span className="mselect-value">{current}</span>
        <span className="mselect-caret">▾</span>
      </button>
      {open && (
        <div
          className="mselect-list"
          role="listbox"
          tabIndex={-1}
          ref={listRef}
          style={{ left: open.left, top: open.top, minWidth: open.width }}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value || '∅'}
              role="option"
              aria-selected={o.value === value}
              className={`mselect-item${o.value === value ? ' selected' : ''}${i === hi ? ' hi' : ''}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o.value)}
            >{o.label}</div>
          ))}
        </div>
      )}
    </span>
  );
}
