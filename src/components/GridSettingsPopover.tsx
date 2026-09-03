/**
 * "Aa" popover: grid appearance settings — font, size, density, decorations.
 * Changes apply live (CSS variables), no grid re-mount.
 */
import { useEffect, useRef, useState } from 'react';
import { useGridSettings, FONT_PRESETS } from '../store/gridSettings';
import type { GridDensity } from '../store/gridSettings';

const SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];
const DENSITIES: { value: GridDensity; label: string }[] = [
  { value: 'compact',     label: 'Compact' },
  { value: 'normal',      label: 'Normal' },
  { value: 'comfortable', label: 'Comfortable' },
];

export function GridSettingsPopover() {
  const { settings, update, reset } = useGridSettings();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="gsp-root" ref={rootRef}>
      <button
        className={`toolbar-btn ${open ? 'active' : ''}`}
        title="Grid appearance"
        onClick={() => setOpen(o => !o)}
      >Aa</button>

      {open && (
        <div className="gsp-panel">
          <div className="gsp-row">
            <label>Font</label>
            <select
              value={settings.fontFamily}
              onChange={e => update({ fontFamily: e.target.value })}
            >
              {FONT_PRESETS.map(f => (
                <option key={f.label} value={f.value}>{f.label}</option>
              ))}
              {!FONT_PRESETS.some(f => f.value === settings.fontFamily) && (
                <option value={settings.fontFamily}>Custom</option>
              )}
            </select>
          </div>

          <div className="gsp-row">
            <label>Size</label>
            <select
              value={settings.fontSize}
              onChange={e => update({ fontSize: Number(e.target.value) })}
            >
              {SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
            </select>
          </div>

          <div className="gsp-row">
            <label>Density</label>
            <div className="gsp-seg">
              {DENSITIES.map(d => (
                <button
                  key={d.value}
                  className={settings.density === d.value ? 'active' : ''}
                  onClick={() => update({ density: d.value })}
                >{d.label}</button>
              ))}
            </div>
          </div>

          <div className="gsp-row gsp-toggles">
            <label className="gsp-check">
              <input
                type="checkbox"
                checked={settings.showRowNumbers}
                onChange={e => update({ showRowNumbers: e.target.checked })}
              /> Row numbers
            </label>
            <label className="gsp-check">
              <input
                type="checkbox"
                checked={settings.zebraStripes}
                onChange={e => update({ zebraStripes: e.target.checked })}
              /> Zebra stripes
            </label>
            <label className="gsp-check">
              <input
                type="checkbox"
                checked={settings.verticalLines}
                onChange={e => update({ verticalLines: e.target.checked })}
              /> Vertical lines
            </label>
          </div>

          <div className="gsp-footer">
            <button className="toolbar-btn" onClick={() => { reset(); }}>
              Reset to defaults
            </button>
            <span className="gsp-preview" style={{ fontFamily: settings.fontFamily, fontSize: settings.fontSize }}>
              SELECT 42
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
