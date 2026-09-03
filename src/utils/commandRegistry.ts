/**
 * Editor command registry — the single, addressable list of everything the SQL
 * editor can do from a keystroke.
 *
 * The editor grew dozens of shortcut-only commands (expand *, run-to-cursor,
 * the whole line-operations family), none of them discoverable without reading
 * the source. This registry gives each one a STABLE id, a human label, a
 * category and its keybinding, so a "Find Action" palette can list and fuzzy-
 * search them — and so a future macro feature (§5.9) can name a command by id
 * and dispatch it programmatically instead of synthesising keystrokes.
 *
 * The metadata here is pure and dependency-light (only the platform key labels),
 * which keeps it testable with `node --test`. SqlEditor owns the actual `run`
 * closures — it maps each id to the editor command that already exists — so the
 * keymap stays the source of truth and this list is kept in sync beside it.
 */
import { keyLabels } from './platform.ts';
import type { Platform } from './platform.ts';
import { fuzzyScore } from './fuzzy.ts';

/** Pure, serialisable description of an editor command. */
export interface CommandSpec {
  /** Stable, namespaced identifier — the address a macro (§5.9) records. */
  id: string;
  /** Human label shown in the palette. */
  label: string;
  /** Grouping label; also searchable so "lines" surfaces the line ops. */
  category: string;
  /**
   * CodeMirror key string (e.g. `Mod-Shift-8`), kept identical to the keymap
   * binding. Absent for commands reachable only from a menu. Rendered for the
   * current platform with {@link formatKeys}.
   */
  keys?: string;
}

/** A registry entry bound to its runnable action (assembled in SqlEditor). */
export interface EditorCommand extends CommandSpec {
  run: () => void;
}

/**
 * The canonical command list, kept in sync with SqlEditor's `keymap.of([…])`.
 * Ids are the contract: never rename one once shipped — a macro or a rebound
 * key may reference it. Add new commands at the end of their category.
 */
export const EDITOR_COMMANDS: readonly CommandSpec[] = [
  // ── Run ──
  { id: 'editor.run',           label: 'Run statement / selection',   category: 'Run', keys: 'Mod-Enter' },
  { id: 'editor.runAll',        label: 'Run entire script',           category: 'Run', keys: 'Mod-Shift-Enter' },
  { id: 'editor.runToCursor',   label: 'Run to cursor',               category: 'Run', keys: 'Mod-Alt-Enter' },
  { id: 'editor.runAllNoResults', label: 'Run entire script (no result tabs)', category: 'Run', keys: 'F9' },
  { id: 'editor.explain',       label: 'Explain statement',           category: 'Run', keys: 'Mod-e' },

  // ── Navigate ──
  { id: 'editor.goToObject',    label: 'Go to table under cursor',    category: 'Navigate', keys: 'F12' },
  { id: 'editor.peekObject',    label: 'Quick definition (peek DDL)', category: 'Navigate', keys: 'Mod-y' },
  // The F12 companion: go-to-object opens the object, this flashes it in the
  // sidebar's schema tree. No chord of its own — F12 and the palette are how
  // you reach it (dispatched as `dbgui:reveal-object`; SchemaTree listens).
  { id: 'editor.revealObject',  label: 'Reveal in database tree',     category: 'Navigate' },
  { id: 'editor.aiGenerate',    label: 'AI: generate SQL…',           category: 'Run', keys: 'Mod-i' },
  { id: 'editor.aiExplain',     label: 'AI: explain statement',       category: 'Run' },
  { id: 'editor.optimizerTrace', label: 'Optimizer trace (MySQL)',     category: 'Run' },
  { id: 'editor.prevStatement', label: 'Go to previous statement',    category: 'Navigate', keys: 'Mod-Alt-ArrowUp' },
  { id: 'editor.nextStatement', label: 'Go to next statement',        category: 'Navigate', keys: 'Mod-Alt-ArrowDown' },
  { id: 'editor.gotoLine',      label: 'Go to line…',                 category: 'Navigate', keys: 'Mod-g' },
  { id: 'editor.matchingBracket', label: 'Jump to matching bracket',  category: 'Navigate', keys: 'Mod-Shift-\\' },
  // Palette-only: the bookmark chords (F2 / Shift-F2) already own the "jump
  // between points of interest" muscle memory, and the Mod-Alt family is full
  // (statements, expand/shrink, sort, dedupe) — a TODO chord nobody can guess
  // is worse than a palette row that says its name.
  { id: 'editor.nextTodo',      label: 'Jump to next TODO / FIXME',   category: 'Navigate' },
  { id: 'editor.prevTodo',      label: 'Jump to previous TODO / FIXME', category: 'Navigate' },

  // ── Search ──
  { id: 'editor.replace',       label: 'Find and replace…',           category: 'Search', keys: 'Mod-Alt-f' },

  // ── Format ──
  { id: 'editor.format',        label: 'Format SQL (whole document)', category: 'Format', keys: 'Mod-Shift-f' },
  { id: 'editor.beautify',      label: 'Beautify statement / selection', category: 'Format', keys: 'Shift-Alt-f' },
  { id: 'editor.expandStar',    label: 'Expand * to column list',     category: 'Format', keys: 'Mod-Shift-8' },
  { id: 'editor.renameAlias',   label: 'Rename symbol (table / column / alias / CTE)', category: 'Format', keys: 'Shift-F6' },
  { id: 'editor.wrapInSubquery', label: 'Wrap in subquery (SELECT * FROM …)', category: 'Format' },
  { id: 'editor.extractCte',    label: 'Extract selection to CTE',    category: 'Format' },
  // Statement transforms (utils/sqlRefactor selectTo*): turn the SELECT at the
  // caret into the statement that acts on its rows. No keys of their own —
  // the context menu's Transform section and this palette are how you reach them.
  { id: 'editor.selectToInsert', label: 'Transform SELECT → INSERT INTO … SELECT', category: 'Format' },
  { id: 'editor.selectToCreateTable', label: 'Transform SELECT → CREATE TABLE AS', category: 'Format' },
  { id: 'editor.selectToCreateView', label: 'Transform SELECT → CREATE VIEW AS', category: 'Format' },
  { id: 'editor.selectToDelete', label: 'Transform SELECT → DELETE (same WHERE)', category: 'Format' },
  { id: 'editor.selectToUpdate', label: 'Transform SELECT → UPDATE skeleton', category: 'Format' },

  // ── Selection & multi-cursor ──
  { id: 'editor.selectNextOccurrence', label: 'Add next occurrence to selection', category: 'Selection', keys: 'Mod-d' },
  { id: 'editor.selectAllOccurrences', label: 'Select all occurrences of selection', category: 'Selection', keys: 'Mod-Shift-l' },
  { id: 'editor.splitSelectionIntoLines', label: 'Split selection into lines (cursor per line)', category: 'Selection', keys: 'Shift-Alt-i' },
  // Mod-Alt-W was the obvious chord (DataGrip's ⌘W family) but App.tsx's
  // close-tab listener fires on Mod+'w' without excluding Alt — on Windows/
  // Linux that chord would close the tab. The Mod-Alt-arrow family was free.
  { id: 'editor.expandSelection', label: 'Expand selection (word → string → parens → statement)', category: 'Selection', keys: 'Mod-Alt-ArrowRight' },
  { id: 'editor.shrinkSelection', label: 'Shrink selection (retrace last expansion)', category: 'Selection', keys: 'Mod-Alt-ArrowLeft' },

  // ── Edit ──
  { id: 'editor.toggleComment', label: 'Toggle line comment',         category: 'Edit', keys: 'Mod-/' },
  { id: 'editor.indentMore',    label: 'Indent more',                 category: 'Edit', keys: 'Mod-]' },
  { id: 'editor.indentLess',    label: 'Indent less',                 category: 'Edit', keys: 'Mod-[' },
  { id: 'editor.lowerCase',     label: 'Convert to lowercase',        category: 'Edit', keys: 'Mod-u' },
  { id: 'editor.upperCase',     label: 'Convert to UPPERCASE',        category: 'Edit', keys: 'Mod-Shift-u' },
  { id: 'editor.pasteHistory',  label: 'Paste from history…',         category: 'Edit', keys: 'Mod-Shift-v' },
  { id: 'editor.quickFix',      label: 'Apply quick fix',             category: 'Edit', keys: 'Mod-.' },
  // Mod-Alt-; was verified free: not in this keymap, not in CM's default /
  // search / history / fold / autocomplete keymaps (those take Mod-Alt-g,
  // Cmd/Ctrl-Alt-[, ], Ctrl-Alt-h), and App.tsx's global Alt handlers only
  // claim z/Z and 0.
  { id: 'editor.completeStatement', label: 'Complete current statement', category: 'Edit', keys: 'Mod-Alt-;' },

  // ── Lines ──
  { id: 'editor.moveLineUp',      label: 'Move line up',              category: 'Lines', keys: 'Alt-ArrowUp' },
  { id: 'editor.moveLineDown',    label: 'Move line down',            category: 'Lines', keys: 'Alt-ArrowDown' },
  { id: 'editor.copyLineUp',      label: 'Duplicate line up',         category: 'Lines', keys: 'Shift-Alt-ArrowUp' },
  { id: 'editor.copyLineDown',    label: 'Duplicate line down',       category: 'Lines', keys: 'Shift-Alt-ArrowDown' },
  { id: 'editor.deleteLine',      label: 'Delete line',               category: 'Lines', keys: 'Shift-Mod-k' },
  { id: 'editor.joinLines',       label: 'Join lines',                category: 'Lines', keys: 'Mod-j' },
  { id: 'editor.sortLinesAsc',    label: 'Sort lines A→Z',            category: 'Lines', keys: 'Mod-Alt-s' },
  { id: 'editor.sortLinesDesc',   label: 'Sort lines Z→A',            category: 'Lines', keys: 'Mod-Alt-Shift-s' },
  { id: 'editor.sortLinesNumeric', label: 'Sort lines numerically',   category: 'Lines' },
  { id: 'editor.dedupeLines',     label: 'Remove duplicate lines',    category: 'Lines', keys: 'Mod-Alt-u' },
  { id: 'editor.keepDuplicates',  label: 'Keep only duplicated lines', category: 'Lines' },
  { id: 'editor.removeBlankLines', label: 'Remove blank lines',       category: 'Lines' },
  { id: 'editor.trimTrailing',    label: 'Trim trailing whitespace',  category: 'Lines' },
  { id: 'editor.reverseLines',    label: 'Reverse line order',        category: 'Lines' },
  { id: 'editor.shuffleLines',    label: 'Shuffle lines',             category: 'Lines' },
  { id: 'editor.indentToTabs',    label: 'Convert indentation to tabs', category: 'Lines' },
  { id: 'editor.indentToSpaces',  label: 'Convert indentation to spaces', category: 'Lines' },
  { id: 'editor.insertNumberSequence', label: 'Insert number sequence', category: 'Lines', keys: 'Mod-Alt-n' },

  // ── Bookmarks ──
  { id: 'editor.bookmarkToggle', label: 'Toggle bookmark',            category: 'Bookmarks', keys: 'Mod-F2' },
  { id: 'editor.bookmarkNext',   label: 'Next bookmark',              category: 'Bookmarks', keys: 'F2' },
  { id: 'editor.bookmarkPrev',   label: 'Previous bookmark',          category: 'Bookmarks', keys: 'Shift-F2' },

  // ── Macro (§5.9) ──
  // Record a sequence of the commands above and replay it — for repetitive
  // multi-step edits a single regex can't express. Both ids are excluded from
  // recording by utils/macroRecorder (a macro can't capture its own controls).
  { id: 'editor.macroRecordToggle', label: 'Record macro (toggle)',   category: 'Macro', keys: 'Mod-Shift-m' },
  { id: 'editor.macroPlay',         label: 'Play last macro',         category: 'Macro', keys: 'Mod-Shift-,' },

  // ── View ──
  { id: 'editor.wordWrap',       label: 'Toggle word wrap',           category: 'View', keys: 'Alt-z' },
  // Distraction-free mode: hides the connections sidebar and the status bar.
  // App-level (body.zen), not an editor command — the chord and the View menu
  // item both dispatch `dbgui:toggle-zen`, which App listens for. Mod-Alt-0 is
  // free: Mod-0 is zoom-reset, Mod-Alt-Z is the word-wrap fallback, and the
  // Mod-digit session switcher only claims 1–9.
  { id: 'editor.zenMode',        label: 'Toggle zen mode',            category: 'View', keys: 'Mod-Alt-0' },
  { id: 'editor.zoomIn',         label: 'Zoom in',                    category: 'View', keys: 'Mod-=' },
  { id: 'editor.zoomOut',        label: 'Zoom out',                   category: 'View', keys: 'Mod--' },
  { id: 'editor.zoomReset',      label: 'Reset zoom',                 category: 'View', keys: 'Mod-0' },
];

/**
 * Render a CodeMirror key string for the given platform:
 * `Mod-Shift-8` → `⌘⇧8` on mac, `Ctrl+Shift+8` elsewhere.
 *
 * Modifier order matches platform.shortcut (mod, alt, shift) so a keybinding
 * shown here reads the same as the ones baked into the shortcut table.
 */
export function formatKeys(keys: string, p?: Platform): string {
  const l = keyLabels(p);
  const parts = keys.split('-');
  const raw = parts.pop() ?? '';
  const mods = parts;
  const out: string[] = [];
  if (mods.some(m => m === 'Mod' || m === 'Cmd' || m === 'Ctrl' || m === 'Meta')) out.push(l.mod);
  if (mods.includes('Alt')) out.push(l.alt);
  if (mods.includes('Shift')) out.push(l.shift);
  const key = raw === 'Enter' ? l.enter
    : raw === 'ArrowUp' ? '↑'
    : raw === 'ArrowDown' ? '↓'
    : raw === 'ArrowLeft' ? '←'
    : raw === 'ArrowRight' ? '→'
    : raw.length === 1 ? raw.toUpperCase()
    : raw;
  out.push(key);
  return out.join(l.sep);
}

/**
 * Fuzzy-rank a list of searchable entries against a query, best first.
 *
 * An empty query returns the list unchanged (registry order). A match is scored
 * on the label; a hit that only lands on the `keywords` text (the category)
 * still counts but is pushed below any real label match, so typing "lines"
 * surfaces the line-ops group without burying a command whose name you typed.
 *
 * Pure and generic so both the palette and the tests use the identical ranking.
 */
export function searchCommands<T extends { label: string; keywords?: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return [...items];
  const KEYWORD_PENALTY = 5; // a category hit is weaker evidence than a name hit
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const labelScore = fuzzyScore(q, item.label);
    let score = labelScore;
    if (item.keywords) {
      const kwScore = fuzzyScore(q, item.keywords);
      if (kwScore !== null) {
        const adjusted = kwScore - KEYWORD_PENALTY;
        score = score === null ? adjusted : Math.max(score, adjusted);
      }
    }
    if (score !== null) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).map(s => s.item);
}
