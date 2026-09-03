/**
 * Grid appearance settings — font, size, density, decorations.
 * Persisted to localStorage; consumed by FastGrid via context.
 * (Provider component lives in GridSettingsProvider.tsx for Fast Refresh.)
 */
import { createContext, useContext } from 'react';

export type GridDensity = 'compact' | 'normal' | 'comfortable';

export interface GridSettings {
  fontFamily:     string;
  fontSize:       number;        // px, 10–20
  density:        GridDensity;
  showRowNumbers: boolean;
  zebraStripes:   boolean;
  verticalLines:  boolean;
}

export const FONT_PRESETS = [
  { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
  { label: 'SF Mono',        value: "'SF Mono', ui-monospace, monospace" },
  { label: 'Menlo',          value: 'Menlo, monospace' },
  { label: 'Fira Code',      value: "'Fira Code', monospace" },
  { label: 'System mono',    value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { label: 'System UI',      value: '-apple-system, BlinkMacSystemFont, sans-serif' },
];

export const DEFAULT_SETTINGS: GridSettings = {
  fontFamily:     "'JetBrains Mono', monospace",
  fontSize:       12,
  density:        'normal',
  showRowNumbers: true,
  zebraStripes:   true,
  verticalLines:  false,
};

const DENSITY_PAD: Record<GridDensity, number> = {
  compact:     2,
  normal:      6,
  comfortable: 12,
};

/** Row height in px derived from font size + density. Single source of truth. */
export function gridRowHeight(s: GridSettings): number {
  return Math.ceil(s.fontSize * 1.25) + DENSITY_PAD[s.density];
}

export const STORAGE_KEY = 'dbgui.gridSettings.v1';

export function loadSettings(): GridSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface GridSettingsCtx {
  settings: GridSettings;
  update: (patch: Partial<GridSettings>) => void;
  reset: () => void;
}

export const GridSettingsContext = createContext<GridSettingsCtx>({
  settings: DEFAULT_SETTINGS,
  update: () => {},
  reset: () => {},
});

export function useGridSettings(): GridSettingsCtx {
  return useContext(GridSettingsContext);
}
