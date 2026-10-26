import { drawSelection, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { getPref, PREFS } from '../store/preferences';

export const CURSOR_PREF_KEYS: readonly string[] = [
  PREFS.editorCursorStyle.key,
  PREFS.editorCursorBlink.key,
  PREFS.editorCursorBlinkMs.key,
  PREFS.editorCursorColor.key,
  PREFS.editorCursorBorderColor.key,
  PREFS.editorCursorOpacity.key,
];

function cursorColor(value: string, fallback: string): string {
  return value === 'transparent' || /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function editorCursorExtension(): Extension[] {
  const style = getPref(PREFS.editorCursorStyle);
  const blinking = getPref(PREFS.editorCursorBlink);
  const blinkMs = Math.max(200, Math.min(10000, Math.round(getPref(PREFS.editorCursorBlinkMs))));
  const color = cursorColor(getPref(PREFS.editorCursorColor), PREFS.editorCursorColor.default);
  const borderColor = cursorColor(
    getPref(PREFS.editorCursorBorderColor), PREFS.editorCursorBorderColor.default,
  );
  const opacity = Math.max(0, Math.min(100, Math.round(getPref(PREFS.editorCursorOpacity))));
  const fill = `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
  const cursor: Record<string, string> = style === 'block' ? {
    '--txui-cursor-width': '0.65em',
    '--txui-cursor-color': fill,
    '--txui-cursor-background': fill,
    '--txui-cursor-border': `1px solid ${borderColor}`,
    '--txui-cursor-underline': '0px solid transparent',
    '--txui-cursor-margin': '0px',
  } : style === 'underline' ? {
    '--txui-cursor-width': '0px',
    '--txui-cursor-color': fill,
    '--txui-cursor-background': 'transparent',
    '--txui-cursor-border': 'none',
    '--txui-cursor-underline': `2px solid ${fill}`,
    '--txui-cursor-margin': '0px',
  } : {
    '--txui-cursor-width': '2.5px',
    '--txui-cursor-color': fill,
    '--txui-cursor-background': fill,
    '--txui-cursor-border': `1px solid ${borderColor}`,
    '--txui-cursor-underline': '0px solid transparent',
    '--txui-cursor-margin': '-1.25px',
  };
  const theme: Record<string, Record<string, string>> = { '&': cursor };
  if (!blinking) theme['&.cm-focused > .cm-scroller > .cm-cursorLayer'] = { animation: 'none' };
  return [
    drawSelection({ cursorBlinkRate: blinking ? blinkMs : 0 }),
    EditorView.theme(theme),
  ];
}
