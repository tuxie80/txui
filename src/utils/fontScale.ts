/**
 * App-wide font scaling. The Settings window stores a base font size
 * (px, default 13); this module publishes it as a `--font-scale` custom
 * property on <html> (= size / 13), and every font-size rule in App.css
 * (plus the CodeMirror themes, which emit CSS verbatim) is written as
 * `calc(Npx * var(--font-scale, 1))` so the whole UI rescales live.
 *
 * Kept free of React/Tauri imports (like themes.ts) so the pure clamp
 * stays unit-testable with node --test. The storage key mirrors
 * PREFS.appFontSize in store/preferences.ts — keep the two in sync.
 */

export const FONT_SIZE_KEY = 'dbgui.appFontSize';
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_BASE = 13;

/** Clamp a font-size setting to the supported range, snapping to whole px. */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_BASE;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

function readSize(): number {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY);
    const n = Number(raw);
    return clampFontSize(raw === null ? FONT_SIZE_BASE : n);
  } catch {
    return FONT_SIZE_BASE;
  }
}

/** Set `--font-scale` on <html> from a base px size (clamped 10–20). */
export function applyFontScale(size: number): void {
  const scale = clampFontSize(size) / FONT_SIZE_BASE;
  document.documentElement.style.setProperty('--font-scale', String(scale));
}

/**
 * The currently effective `--font-scale` multiplier (1 when unset / off-DOM).
 * Canvas measurements (FastGrid column auto-width) need a RESOLVED px font —
 * CSS `calc()` can't feed `ctx.font` — so they read this and recompute.
 */
export function readFontScale(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--font-scale');
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/** Apply the persisted size and re-apply on pref changes — call once at startup.
 *  Returns an unsubscribe function. */
export function initFontScale(): () => void {
  applyFontScale(readSize());
  const on = (e: Event) => {
    if ((e as CustomEvent<{ key: string }>).detail?.key === FONT_SIZE_KEY) {
      applyFontScale(readSize());
    }
  };
  window.addEventListener('dbgui:prefs-changed', on);
  return () => window.removeEventListener('dbgui:prefs-changed', on);
}
