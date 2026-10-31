import { getPref, PREFS } from '../store/preferences.ts';

export interface MonoFontChoice {
  id: string;
  label: string;
  stack: string;
}

export const MONO_FONTS: readonly MonoFontChoice[] = [
  { id: 'txui-mono', label: 'TxUI Mono', stack: "'TxUI Mono', monospace" },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: "'JetBrains Mono', monospace" },
  { id: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', ui-monospace, monospace" },
  { id: 'menlo', label: 'Menlo', stack: 'Menlo, monospace' },
  { id: 'fira-code', label: 'Fira Code', stack: "'Fira Code', monospace" },
  { id: 'system-mono', label: 'System mono', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { id: 'system-ui', label: 'System UI', stack: '-apple-system, BlinkMacSystemFont, sans-serif' },
];

export const DEFAULT_MONO_FONT = 'txui-mono';

export function monoFontStack(id: string): string {
  return (MONO_FONTS.find(font => font.id === id) ?? MONO_FONTS[0]).stack;
}

export function applyMonoFont(id: string): void {
  document.documentElement.style.setProperty('--font-mono', monoFontStack(id));
}

export function initMonoFont(): void {
  applyMonoFont(getPref(PREFS.monoFontFamily));
}
