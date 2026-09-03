/**
 * Standardized color themes — palettes drawn from the well-known schemes
 * shared across iTerm2, Zed, Notepad++, VS Code, etc. Each theme is just a set
 * of the app's CSS custom properties; applying one rewrites the tokens on
 * <html> and the whole UI re-themes live. Selection is persisted and driven
 * from the native menu bar (View → Theme).
 *
 * NOTE: the theme id/name list is mirrored in src-tauri/src/lib.rs so the
 * native menu can list them — keep the two in sync.
 */

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  /**
   * CSS custom-property values (without the leading `--`). The editor caret
   * color (`--cursor`) is NOT here on purpose — it is derived from `dark` by
   * cursorColor(), so nobody has to keep N per-theme values in sync.
   */
  vars: {
    bg: string; bg2: string; bg3: string; border: string;
    text: string; text2: string; accent: string; accent2: string;
    green: string; red: string; yellow: string;
  };
}

/**
 * The editor caret/cursor color, derived from the theme kind: a bright orange
 * on dark backgrounds, a deep high-contrast orange on light ones (both read
 * against every shipped theme's bg range). Derived, not per-theme data.
 */
export function cursorColor(dark: boolean): string {
  return dark ? '#ffa94d' : '#c2500a';
}

export const THEMES: Theme[] = [
  { id: 'txui-dark', name: 'TxUI Dark', dark: true, vars: {
    bg:'#1a1a1f', bg2:'#22222a', bg3:'#2a2a35', border:'#333344',
    text:'#e0e0ec', text2:'#9090a8', accent:'#6c8fff', accent2:'#4a6eee',
    green:'#4caf73', red:'#e05555', yellow:'#e0b050' } },

  { id: 'one-dark', name: 'One Dark', dark: true, vars: {
    bg:'#282c34', bg2:'#21252b', bg3:'#323842', border:'#3b4048',
    text:'#abb2bf', text2:'#5c6370', accent:'#61afef', accent2:'#528bce',
    green:'#98c379', red:'#e06c75', yellow:'#e5c07b' } },

  { id: 'dracula', name: 'Dracula', dark: true, vars: {
    bg:'#282a36', bg2:'#21222c', bg3:'#343746', border:'#44475a',
    text:'#f8f8f2', text2:'#6272a4', accent:'#bd93f9', accent2:'#9d74e0',
    green:'#50fa7b', red:'#ff5555', yellow:'#f1fa8c' } },

  { id: 'nord', name: 'Nord', dark: true, vars: {
    bg:'#2e3440', bg2:'#272c36', bg3:'#3b4252', border:'#434c5e',
    text:'#d8dee9', text2:'#7b88a1', accent:'#88c0d0', accent2:'#5e81ac',
    green:'#a3be8c', red:'#bf616a', yellow:'#ebcb8b' } },

  { id: 'gruvbox-dark', name: 'Gruvbox Dark', dark: true, vars: {
    bg:'#282828', bg2:'#1d2021', bg3:'#3c3836', border:'#504945',
    text:'#ebdbb2', text2:'#928374', accent:'#83a598', accent2:'#458588',
    green:'#b8bb26', red:'#fb4934', yellow:'#fabd2f' } },

  { id: 'monokai', name: 'Monokai', dark: true, vars: {
    bg:'#272822', bg2:'#1e1f1c', bg3:'#3e3d32', border:'#49483e',
    text:'#f8f8f2', text2:'#75715e', accent:'#66d9ef', accent2:'#4fb3cc',
    green:'#a6e22e', red:'#f92672', yellow:'#e6db74' } },

  { id: 'solarized-dark', name: 'Solarized Dark', dark: true, vars: {
    bg:'#002b36', bg2:'#073642', bg3:'#0a4351', border:'#094b57',
    text:'#93a1a1', text2:'#586e75', accent:'#268bd2', accent2:'#2075b5',
    green:'#859900', red:'#dc322f', yellow:'#b58900' } },

  { id: 'tomorrow-night', name: 'Tomorrow Night', dark: true, vars: {
    bg:'#1d1f21', bg2:'#232528', bg3:'#373b41', border:'#404552',
    text:'#c5c8c6', text2:'#969896', accent:'#81a2be', accent2:'#5f819d',
    green:'#b5bd68', red:'#cc6666', yellow:'#f0c674' } },

  { id: 'tokyo-night', name: 'Tokyo Night', dark: true, vars: {
    bg:'#1a1b26', bg2:'#16161e', bg3:'#292e42', border:'#3b4261',
    text:'#c0caf5', text2:'#565f89', accent:'#7aa2f7', accent2:'#5a7fd6',
    green:'#9ece6a', red:'#f7768e', yellow:'#e0af68' } },

  { id: 'github-dark', name: 'GitHub Dark', dark: true, vars: {
    bg:'#0d1117', bg2:'#161b22', bg3:'#21262d', border:'#30363d',
    text:'#c9d1d9', text2:'#8b949e', accent:'#58a6ff', accent2:'#388bfd',
    green:'#3fb950', red:'#f85149', yellow:'#d29922' } },

  { id: 'ayu-dark', name: 'Ayu Dark', dark: true, vars: {
    bg:'#0f1419', bg2:'#0d1017', bg3:'#1c2230', border:'#232a37',
    text:'#bfbdb6', text2:'#565b66', accent:'#59c2ff', accent2:'#39bae6',
    green:'#7fd962', red:'#f26d78', yellow:'#ffb454' } },

  { id: 'solarized-light', name: 'Solarized Light', dark: false, vars: {
    bg:'#fdf6e3', bg2:'#eee8d5', bg3:'#e3ddc6', border:'#d7d2bd',
    text:'#586e75', text2:'#93a1a1', accent:'#268bd2', accent2:'#2075b5',
    green:'#859900', red:'#dc322f', yellow:'#b58900' } },

  { id: 'github-light', name: 'GitHub Light', dark: false, vars: {
    bg:'#ffffff', bg2:'#f6f8fa', bg3:'#eaeef2', border:'#d0d7de',
    text:'#1f2328', text2:'#656d76', accent:'#0969da', accent2:'#0860c9',
    green:'#1a7f37', red:'#cf222e', yellow:'#9a6700' } },

  { id: 'one-light', name: 'One Light', dark: false, vars: {
    bg:'#fafafa', bg2:'#f0f0f0', bg3:'#e5e5e6', border:'#d4d4d4',
    text:'#383a42', text2:'#a0a1a7', accent:'#4078f2', accent2:'#2f66d0',
    green:'#50a14f', red:'#e45649', yellow:'#c18401' } },

  { id: 'ayu-light', name: 'Ayu Light', dark: false, vars: {
    bg:'#fcfcfc', bg2:'#f3f4f5', bg3:'#e7e8e9', border:'#d9dadb',
    text:'#5c6166', text2:'#8a9199', accent:'#399ee6', accent2:'#2d8fd6',
    green:'#6cbf43', red:'#f07171', yellow:'#f2ae49' } },
];

const STORAGE_KEY = 'dbgui:theme';
export const DEFAULT_THEME_ID = 'txui-dark';

export function themeById(id: string): Theme | undefined {
  return THEMES.find(t => t.id === id);
}

/** Apply a theme's tokens to <html> and remember it. Falls back to default. */
/**
 * Tell the native menu which theme is active, so its tick follows.
 *
 * The menu is built in Rust before the frontend loads and cannot read
 * localStorage, so it has to be told — at startup and on every change.
 */
function syncMenu(id: string) {
  const theme = themeById(id);
  void import('@tauri-apps/api/core')
    // `dark` rides along for the Rust side to persist as `theme-scheme` —
    // apply_toolkit_theme() reads it next launch to set GTK_THEME before GTK
    // initializes (native popups follow the toolkit theme, not page CSS).
    .then(({ invoke }) => invoke('set_active_theme', { id, dark: theme?.dark ?? true }))
    .catch(() => { /* menu tick is cosmetic; never break theming over it */ });
}

export function applyTheme(id: string): void {
  const theme = themeById(id) ?? themeById(DEFAULT_THEME_ID)!;
  const el = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) {
    el.style.setProperty(`--${k}`, v);
  }
  // The editor caret is derived, not per-theme data (see cursorColor).
  el.style.setProperty('--cursor', cursorColor(theme.dark));
  // `data-theme` carries light/dark so components (and the CodeMirror wrapper)
  // can make kind-specific tweaks; the actual colors come from the vars above.
  el.dataset.theme = theme.dark ? 'dark' : 'light';
  el.dataset.themeId = theme.id;
  try { localStorage.setItem(STORAGE_KEY, theme.id); } catch { /* ignore */ }
  syncMenu(theme.id);
}

/** Apply the persisted theme (or the default) — call once at startup. */
export function initTheme(): void {
  let saved = DEFAULT_THEME_ID;
  try { saved = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME_ID; } catch { /* ignore */ }
  applyTheme(saved);
}
