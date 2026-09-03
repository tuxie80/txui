/**
 * A script's shape, summarised — the outline beside the editor.
 *
 * Forty statements in a migration is normal and unreadable by scrolling. What
 * makes an outline useful is not the statement text, which you already have,
 * but the *classification*: which of these writes, which is DDL, which one
 * drops something. A list that says `UPDATE orders` where its neighbours say
 * `SELECT` is a list that answers "where does this script actually change
 * things" at a glance.
 *
 * Everything here derives from the statement splitter that already exists, so
 * the outline can never disagree with what will actually run.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import { splitStatements } from './sqlSplit.ts';

export type StatementKind =
  | 'select' | 'insert' | 'update' | 'delete'
  | 'create' | 'alter' | 'drop' | 'truncate'
  | 'grant' | 'transaction' | 'set' | 'call' | 'show' | 'explain' | 'other';

/** How much attention a kind deserves in the margin. */
export type OutlineWeight = 'read' | 'write' | 'ddl' | 'destructive' | 'neutral';

export interface OutlineItem {
  /** Position in the script, 1-based. */
  index: number;
  /** Document offsets, for click-to-jump and highlighting. */
  from: number;
  to: number;
  /** 1-based line the statement starts on. */
  line: number;
  kind: StatementKind;
  weight: OutlineWeight;
  /** The object it acts on, when one can be named. */
  target?: string;
  /** One line, safe to render — never the whole statement. */
  label: string;
}

const WEIGHT: Record<StatementKind, OutlineWeight> = {
  select: 'read', show: 'read', explain: 'read',
  insert: 'write', update: 'write', delete: 'write', call: 'write',
  create: 'ddl', alter: 'ddl', grant: 'ddl',
  drop: 'destructive', truncate: 'destructive',
  transaction: 'neutral', set: 'neutral', other: 'neutral',
};

/**
 * Patterns in priority order.
 *
 * `CREATE OR REPLACE` must be tested before bare `CREATE`, and `INSERT INTO …
 * SELECT` is an insert rather than a select — the leading keyword decides, so
 * the list is anchored and ordered rather than searched.
 */
const RULES: Array<{ kind: StatementKind; re: RegExp; target?: number }> = [
  { kind: 'transaction', re: /^(begin|start\s+transaction|commit|rollback|savepoint)\b/i },
  { kind: 'explain',  re: /^explain\b/i },
  { kind: 'show',     re: /^(show|describe|desc)\b/i },
  { kind: 'select',   re: /^(select|with|table|values)\b/i },
  { kind: 'insert',   re: /^insert\s+(?:ignore\s+)?into\s+([`"\w.]+)/i, target: 1 },
  { kind: 'insert',   re: /^(insert|replace)\b/i },
  { kind: 'update',   re: /^update\s+([`"\w.]+)/i, target: 1 },
  { kind: 'delete',   re: /^delete\s+from\s+([`"\w.]+)/i, target: 1 },
  { kind: 'delete',   re: /^delete\b/i },
  { kind: 'truncate', re: /^truncate\s+(?:table\s+)?([`"\w.]+)/i, target: 1 },
  { kind: 'drop',     re: /^drop\s+\w+\s+(?:if\s+exists\s+)?([`"\w.]+)/i, target: 1 },
  { kind: 'drop',     re: /^drop\b/i },
  { kind: 'alter',    re: /^alter\s+\w+\s+([`"\w.]+)/i, target: 1 },
  { kind: 'alter',    re: /^alter\b/i },
  { kind: 'create',   re: /^create\s+(?:or\s+replace\s+)?(?:unique\s+)?\w+\s+(?:if\s+not\s+exists\s+)?([`"\w.]+)/i, target: 1 },
  { kind: 'create',   re: /^create\b/i },
  { kind: 'grant',    re: /^(grant|revoke)\b/i },
  { kind: 'set',      re: /^(set|use)\b/i },
  { kind: 'call',     re: /^(call|do|exec(ute)?)\b/i },
];

/** Strip comments and collapse whitespace, so classification sees the SQL. */
export function normalise(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/^#[^\n]*/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const unquote = (s: string) => s.replace(/[`"]/g, '');

/** Classify one statement. */
export function classify(text: string): { kind: StatementKind; target?: string } {
  const t = normalise(text);
  if (!t) return { kind: 'other' };
  for (const rule of RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const target = rule.target ? unquote(m[rule.target]) : undefined;
    return { kind: rule.kind, target };
  }
  return { kind: 'other' };
}

/** Longest label the margin can hold before it stops being scannable. */
const LABEL_MAX = 56;

/**
 * A one-line label.
 *
 * The first line of the statement, not the whole thing: an outline entry that
 * wraps to four lines is a worse version of the editor it sits beside.
 */
export function labelFor(text: string): string {
  const first = normalise(text);
  return first.length > LABEL_MAX ? first.slice(0, LABEL_MAX - 1) + '…' : first;
}

/**
 * Outline a whole document.
 *
 * `delimiter` is threaded so the outline splits the same way the runner does —
 * an outline that disagrees with execution would be worse than none.
 */
export function outline(doc: string, delimiter = ';'): OutlineItem[] {
  const out: OutlineItem[] = [];
  const stmts = splitStatements(doc, delimiter);
  let i = 0;
  for (const s of stmts) {
    const text = s.text.trim();
    if (!normalise(text)) continue;   // comment-only chunks are not statements
    i++;
    const { kind, target } = classify(text);
    // Count newlines up to the statement rather than splitting the document,
    // which on a large script is the difference between instant and janky.
    let line = 1;
    for (let k = 0; k < s.from; k++) if (doc[k] === '\n') line++;
    out.push({
      index: i, from: s.from, to: s.to, line, kind,
      weight: WEIGHT[kind], target, label: labelFor(text),
    });
  }
  return out;
}

/** A count per weight, for the header — "12 statements · 3 write · 1 destructive". */
export function outlineSummary(items: OutlineItem[]): string {
  const n = items.length;
  if (n === 0) return 'No statements';
  const by = (w: OutlineWeight) => items.filter(x => x.weight === w).length;
  const parts = [`${n} statement${n === 1 ? '' : 's'}`];
  const write = by('write');
  const ddl = by('ddl');
  const destructive = by('destructive');
  if (write) parts.push(`${write} write`);
  if (ddl) parts.push(`${ddl} DDL`);
  if (destructive) parts.push(`${destructive} destructive`);
  return parts.join(' · ');
}

/** The outline entry containing a caret offset. */
export function itemAt(items: OutlineItem[], pos: number): OutlineItem | undefined {
  for (const it of items) {
    if (pos >= it.from && pos <= it.to) return it;
  }
  // Between statements: the previous one, matching the editor's own rule.
  let prev: OutlineItem | undefined;
  for (const it of items) {
    if (it.to <= pos) prev = it;
    else break;
  }
  return prev;
}


// ── bookmarks ────────────────────────────────────────────────────────────────

/**
 * Marked lines in a buffer.
 *
 * Kept as line NUMBERS rather than offsets. Offsets are exact and become wrong
 * the moment anything above them is edited; a line number drifts too, but it
 * drifts the way a reader expects and can be corrected by eye. The alternative
 * — anchoring to statement text — breaks as soon as the statement is edited,
 * which is when a bookmark is most useful.
 */
export interface Bookmark {
  line: number;
  /** Optional note; the line's text is shown when there is none. */
  label?: string;
}

const BOOKMARK_PREFIX = 'dbgui.bookmarks.';

export function bookmarkKey(connectionId: string, tabId: number): string {
  return `${BOOKMARK_PREFIX}${connectionId}:${tabId}`;
}

/** Read a buffer's bookmarks; anything unparseable reads as none. */
export function loadBookmarks(key: string, storage: Storage): Bookmark[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b: unknown): b is Bookmark =>
        !!b && typeof b === 'object' && Number.isFinite((b as Bookmark).line))
      .sort((a, b) => a.line - b.line);
  } catch {
    return [];
  }
}

export function saveBookmarks(key: string, marks: Bookmark[], storage: Storage): void {
  try {
    if (marks.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(marks));
  } catch { /* quota — a lost bookmark is not worth an error */ }
}

/** Toggle a line, keeping the list sorted. */
export function toggleBookmark(marks: Bookmark[], line: number): Bookmark[] {
  const existing = marks.find(b => b.line === line);
  if (existing) return marks.filter(b => b.line !== line);
  return [...marks, { line }].sort((a, b) => a.line - b.line);
}

/**
 * The next bookmark after `line`, wrapping to the first.
 *
 * Wrapping matters: cycling through four marks with one key is the whole
 * interaction, and stopping at the last one turns it into two keys.
 */
export function nextBookmark(marks: Bookmark[], line: number): Bookmark | undefined {
  if (marks.length === 0) return undefined;
  return marks.find(b => b.line > line) ?? marks[0];
}

/** The previous bookmark before `line`, wrapping to the last. */
export function prevBookmark(marks: Bookmark[], line: number): Bookmark | undefined {
  if (marks.length === 0) return undefined;
  const before = marks.filter(b => b.line < line);
  return before[before.length - 1] ?? marks[marks.length - 1];
}

/**
 * Shift bookmarks to follow an edit that added or removed lines.
 *
 * Without this, inserting a block at the top silently moves every bookmark
 * onto the wrong statement — and a bookmark pointing at the wrong place is
 * worse than one that was lost, because it is trusted.
 */
export function shiftBookmarks(
  marks: Bookmark[], atLine: number, deltaLines: number,
): Bookmark[] {
  if (deltaLines === 0) return marks;
  return marks
    .map(b => (b.line >= atLine ? { ...b, line: b.line + deltaLines } : b))
    .filter(b => b.line >= 1)
    .sort((a, b) => a.line - b.line);
}
