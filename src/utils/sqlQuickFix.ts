/**
 * Turning a diagnostic into an action.
 *
 * `utils/sqlDiagnostics` already finds the problems and says nothing about what
 * to do next. A squiggle that only complains makes the reader do the work
 * twice — read the message, then work out the edit. The difference between a
 * linter and an assistant is this file.
 *
 * The rule for every fix here: **it must be the edit the reader would have made
 * anyway.** A fix that guesses — picking one of several possible tables to
 * qualify with, inventing a WHERE predicate — is a fix that gets applied
 * without reading and produces SQL nobody wrote. Where several answers are
 * possible, each is offered separately and named. Where none is certain, the
 * fix positions the caret and lets the human type.
 *
 * Pure and dependency-free — driven by `node --test`.
 */
import type { Diagnostic } from './sqlDiagnostics.ts';

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface QuickFix {
  /** Shown in the menu — an imperative, so it reads as the action it is. */
  title: string;
  edits: TextEdit[];
  /**
   * Where the caret should end up, as an offset into the document AFTER the
   * edits are applied. Set when the fix leaves something to be typed.
   */
  caret?: number;
  /**
   * True when the fix completes the statement on its own. A fix that only
   * positions the caret is marked false, so the UI can say "and type the
   * condition" rather than implying the problem is solved.
   */
  complete: boolean;
}

/** Apply edits to a string — right-to-left, so earlier offsets stay valid. */
export function applyEdits(doc: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.from - a.from);
  let out = doc;
  for (const e of ordered) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/**
 * Fixes available for one diagnostic.
 *
 * `doc` is the whole buffer and the diagnostic's offsets address it, so a fix
 * can look at surrounding text — which is what makes `= NULL` → `IS NULL` know
 * whether it was `=` or `!=`.
 */
export function fixesFor(diag: Diagnostic, doc: string): QuickFix[] {
  const text = doc.slice(diag.from, diag.to);

  switch (diag.code) {
    // `x = NULL` is never true. The negated form must become IS NOT NULL, not
    // IS NULL — getting that backwards would invert the query silently.
    case 'eq-null': {
      const negated = /^(!=|<>)/.test(text.trim());
      const replacement = negated ? 'IS NOT NULL' : 'IS NULL';
      return [{
        title: `Replace with ${replacement}`,
        edits: [{ from: diag.from, to: diag.to, insert: replacement }],
        complete: true,
      }];
    }

    // A deleted column leaves its comma behind. The fix is to remove exactly
    // the comma, not the whitespace after it, so the FROM stays where it was.
    case 'comma-before-from':
      return [{
        title: 'Remove the trailing comma',
        edits: [{ from: diag.from, to: diag.from + 1, insert: '' }],
        complete: true,
      }];

    // The quote character is at `from`; the string runs to the end of the
    // buffer. Closing it at the end of the line is right far more often than
    // closing it at the end of the document.
    case 'unterminated-string': {
      const quote = doc[diag.from] ?? "'";
      const lineEnd = doc.indexOf('\n', diag.from);
      const at = lineEnd === -1 ? doc.length : lineEnd;
      return [{
        title: `Close the string at the end of the line`,
        edits: [{ from: at, to: at, insert: quote }],
        complete: true,
      }];
    }

    case 'unbalanced-paren': {
      const isOpen = doc[diag.from] === '(';
      if (isOpen) {
        const lineEnd = doc.indexOf('\n', diag.from);
        const at = lineEnd === -1 ? doc.length : lineEnd;
        return [
          { title: 'Close it at the end of the line',
            edits: [{ from: at, to: at, insert: ')' }], complete: true },
          { title: 'Delete this “(”',
            edits: [{ from: diag.from, to: diag.from + 1, insert: '' }], complete: true },
        ];
      }
      return [{
        title: 'Delete this “)”',
        edits: [{ from: diag.from, to: diag.from + 1, insert: '' }],
        complete: true,
      }];
    }

    // Every possible qualifier is offered by name. Picking one automatically
    // would silently change which table the query reads from.
    case 'ambiguous-column': {
      const owners = ownersFromMessage(diag.message);
      return owners.map(owner => ({
        title: `Qualify as ${owner}.${text}`,
        edits: [{ from: diag.from, to: diag.from, insert: `${owner}.` }],
        complete: true,
      }));
    }

    // There is no correct predicate to invent, so the fix writes the keyword
    // and puts the caret where the condition goes.
    case 'write-without-where': {
      const insertAt = statementEnd(doc, diag.from);
      const needsSpace = insertAt > 0 && !/\s/.test(doc[insertAt - 1] ?? '');
      const insert = `${needsSpace ? ' ' : ''}WHERE `;
      return [{
        title: 'Add a WHERE clause',
        edits: [{ from: insertAt, to: insertAt, insert }],
        caret: insertAt + insert.length,
        complete: false,
      }];
    }

    // The default database is not selected, so we do not know the schema —
    // the fix offers the shape and lets the human name it.
    case 'unqualified-write':
      return [{
        title: 'Qualify with a database name',
        edits: [{ from: diag.from, to: diag.from, insert: '' }],
        caret: diag.from,
        complete: false,
      }];

    // A cartesian product is occasionally intended, so both readings are on
    // offer: add the condition, or say CROSS JOIN and mean it.
    case 'join-without-on': {
      const after = diag.to;
      const tail = /^\s*[\w."`]+(\s+(?:as\s+)?[\w"`]+)?/i.exec(doc.slice(after));
      const at = after + (tail?.[0].length ?? 0);
      return [
        { title: 'Add an ON condition',
          edits: [{ from: at, to: at, insert: ' ON ' }],
          caret: at + 4, complete: false },
        { title: 'Make it an explicit CROSS JOIN',
          edits: [{ from: diag.from, to: diag.to, insert: 'CROSS JOIN' }],
          complete: true },
      ];
    }

    default:
      return [];
  }
}

/**
 * Pull the candidate tables out of an ambiguous-column message.
 *
 * The diagnostic already computed them; re-deriving them here would be a second
 * implementation that could disagree with the squiggle the user is looking at.
 */
export function ownersFromMessage(message: string): string[] {
  const m = /exists in (.+?) — qualify/.exec(message);
  if (!m) return [];
  return m[1].split(/\s+and\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Where a statement ends, so `WHERE` lands before the `;` rather than after it.
 *
 * Quote-aware would be better; this walks forward to the first top-level `;`
 * or the end of the buffer, which covers the shapes a WHERE-less UPDATE takes.
 */
export function statementEnd(doc: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < doc.length; i++) {
    const ch = doc[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      // Trim back over trailing whitespace so `WHERE` does not land after it.
      let end = i;
      while (end > from && /\s/.test(doc[end - 1])) end--;
      return end;
    }
  }
  let end = doc.length;
  while (end > from && /\s/.test(doc[end - 1])) end--;
  return end;
}

/** Does this diagnostic have anything actionable? Cheap enough for a gutter. */
export function hasFix(code: string): boolean {
  return FIXABLE.has(code);
}

const FIXABLE = new Set([
  'eq-null', 'comma-before-from', 'unterminated-string', 'unbalanced-paren',
  'ambiguous-column', 'write-without-where', 'unqualified-write', 'join-without-on',
]);
