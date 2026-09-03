/**
 * Variable-driven CodeMirror theme. Every color references an app CSS token
 * (`var(--bg)`, `var(--accent)`, …), so the editor re-themes **live** with the
 * active scheme (View → Theme) — no per-scheme editor config and no
 * reconfiguration on switch, because CodeMirror emits the values verbatim into
 * its stylesheet and the browser resolves the vars dynamically.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const chrome = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--cursor)' },
  // Bolder than CM's 1.2px default, and orange (var(--cursor)) — the accent
  // blue vanished into half the themes. Drop cursor matches.
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cursor)', borderLeftWidth: '2.5px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--accent) 32%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--bg2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  // Search/replace panel controls — themed so they're readable on dark schemes.
  '.cm-panel.cm-search': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', padding: '4px 6px' },
  // Font sizes use calc(Npx * var(--font-scale, 1)) so panels follow the
  // app-wide font size live, like the rest of the UI.
  '.cm-panel.cm-search label': { fontSize: 'calc(11px * var(--font-scale, 1))', color: 'var(--text2)' },
  '.cm-textfield': {
    backgroundColor: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)',
    borderRadius: '4px', padding: '3px 7px', fontSize: 'calc(12px * var(--font-scale, 1))',
  },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-button': {
    backgroundColor: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)',
    borderRadius: '4px', padding: '2px 9px', fontSize: 'calc(12px * var(--font-scale, 1))', cursor: 'pointer', backgroundImage: 'none',
  },
  '.cm-button:hover': { backgroundColor: 'var(--border)' },
  '.cm-panel.cm-search .cm-button[name=close], .cm-panel button[name=close]': { color: 'var(--text2)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--yellow) 35%, transparent)', outline: '1px solid color-mix(in srgb, var(--yellow) 60%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--yellow) 60%, transparent)' },
  // "3 of 17" badge injected next to the prev/next buttons (searchCount.ts).
  '.cm-search-count': {
    fontSize: 'calc(11px * var(--font-scale, 1))', color: 'var(--text2)',
    padding: '0 6px', whiteSpace: 'nowrap', userSelect: 'none',
  },
  '.cm-search-count.cm-search-count-none': { color: 'var(--red)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg3) 45%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket':
    { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)', outline: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)' },
  '.cm-nonmatchingBracket': { color: 'var(--red)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text2)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg3)', color: 'var(--text)' },
  // Every selection-covered line's number — same weight as the active line,
  // no line singled out while a selection exists.
  '.cm-selLineGutter': { backgroundColor: 'var(--bg3)', color: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-tooltip-autocomplete > ul > li': { color: 'var(--text)' },
});

/**
 * SQL syntax colors. Only app CSS tokens are used (with color-mix for derived
 * hues), so the scheme stays coherent across ALL shipped themes — dark and
 * light alike — and re-themes live with View → Theme.
 *
 * lang-sql emits: keyword, typeName, standard(name) for builtins/functions,
 * string, special(string) for `quoted`/"identifiers", number, bool, null,
 * name, special(name) for @@vars, comments, operator, punctuation, and
 * paren/brace/squareBracket. More specific tags win over their bases.
 */
const highlight = HighlightStyle.define([
  // Keywords: strong accent, bold — the skeleton of the statement.
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--accent)', fontWeight: '600' },
  // Functions/builtins: a distinct violet derived from accent+red, NOT bold.
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.name), t.macroName],
    color: 'color-mix(in srgb, var(--accent) 55%, var(--red))' },
  // Strings/values: warm (yellow→red), italic — "values read like prose".
  { tag: [t.string, t.regexp], color: 'color-mix(in srgb, var(--yellow) 65%, var(--red))', fontStyle: 'italic' },
  // Quoted identifiers are special(string) in lang-sql: identifier tint, upright.
  { tag: t.special(t.string), color: 'color-mix(in srgb, var(--accent2) 60%, var(--text))', fontStyle: 'normal' },
  // Numbers: yellow, upright.
  { tag: t.number, color: 'var(--yellow)' },
  // Atoms (NULL / TRUE / FALSE): muted-but-noticeable, italic.
  { tag: [t.bool, t.null, t.atom], color: 'color-mix(in srgb, var(--yellow) 55%, var(--text2))', fontStyle: 'italic' },
  // Comments: muted gray-green, italic.
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'color-mix(in srgb, var(--green) 30%, var(--text2))', fontStyle: 'italic' },
  // Types (INT, VARCHAR, …): green, upright.
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--green)' },
  // Operators: subtle but readable; punctuation/brackets a step dimmer.
  { tag: t.operator, color: 'color-mix(in srgb, var(--text2) 85%, var(--text))' },
  { tag: [t.punctuation, t.separator], color: 'color-mix(in srgb, var(--text2) 75%, transparent)' },
  { tag: [t.paren, t.brace, t.squareBracket, t.bracket], color: 'color-mix(in srgb, var(--text2) 85%, transparent)' },
  // Session/bind variables (@@x, :name): a whisper of accent.
  { tag: t.special(t.name), color: 'color-mix(in srgb, var(--accent) 45%, var(--text))' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--text)' },
  { tag: [t.variableName, t.labelName], color: 'var(--text)' },
  { tag: t.invalid, color: 'var(--red)' },
]);

/** Drop-in replacement for the old `oneDark` — matches the active app theme. */
export const appEditorTheme = [chrome, syntaxHighlighting(highlight)];
