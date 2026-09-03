import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import {
  GridSettingsContext, DEFAULT_SETTINGS, STORAGE_KEY, loadSettings,
} from './gridSettings';
import type { GridSettings } from './gridSettings';

export function GridSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GridSettings>(loadSettings);

  const update = useCallback((patch: Partial<GridSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* quota */ }
  }, []);

  return (
    <GridSettingsContext.Provider value={{ settings, update, reset }}>
      {children}
    </GridSettingsContext.Provider>
  );
}
