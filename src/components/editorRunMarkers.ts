/**
 * Per-statement run markers — the CodeMirror STATE half (effects + fields).
 * Split out of SqlEditor.tsx so the transitions are unit-testable headless:
 * this module imports only @codemirror/state, never the DOM side of the view
 * package. The gutter itself (RunMarker, markerMap, statementGutter, the
 * ticker plugin) stays in SqlEditor.tsx.
 *
 * Per-statement run markers: after a script runs, each statement's first line
 * gets a status chip and its wall time, so you can see WHICH statement was slow
 * (or failed) without reading the results list. Fed by the host via
 * `statementRuns`.
 */
import { StateEffect, StateField, type Transaction } from '@codemirror/state';
import { tokenizeSql } from '../utils/sqlBeautify.ts';
import { splitStatements } from '../utils/sqlSplit.ts';

function whitespaceOnlyChange(tr: Transaction): boolean {
  let onlyWhitespace = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!/^\s*$/.test(tr.startState.sliceDoc(fromA, toA)) || !/^\s*$/.test(inserted.toString())) {
      onlyWhitespace = false;
    }
  });
  if (!onlyWhitespace) return false;
  const before = tokenizeSql(tr.startState.doc.toString());
  const after = tokenizeSql(tr.state.doc.toString());
  return before.length === after.length && before.every((token, i) =>
    token.kind === after[i].kind && token.text === after[i].text
    && token.lineComment === after[i].lineComment);
}

export interface StatementRun {
  status: 'ok' | 'error' | 'skipped' | 'running';
  ms?: number;
  /** Wall-clock start (epoch ms) — the marker tooltip leads with it. */
  startedAt?: number;
  /** An auto-EXPLAIN plan for this statement is cached on the tab. */
  hasPlan?: boolean;
  /** Digest stats from the local query history (same statement shape). */
  stats?: { runs: number; p95Ms: number };
}

const setStatementRuns = StateEffect.define<StatementRun[]>();

function statementTexts(doc: string): string[] {
  return splitStatements(doc).filter(s => s.text.trim()).map(s => s.text);
}

function reconcileStatementRuns(value: StatementRun[], tr: Transaction): StatementRun[] {
  const before = statementTexts(tr.startState.doc.toString());
  const after = statementTexts(tr.state.doc.toString());
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

  const out: StatementRun[] = after.map(() => ({ status: 'skipped' }));
  for (let i = 0; i < prefix; i++) if (value[i]) out[i] = value[i];
  for (let i = 0; i < suffix; i++) {
    const oldIndex = value.length - 1 - i;
    if (value[oldIndex]) out[out.length - 1 - i] = value[oldIndex];
  }
  return out;
}

const statementRunsField = StateField.define<StatementRun[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStatementRuns)) return e.value;
    // Formatting between SQL tokens keeps every measured outcome. A substantive
    // edit invalidates only statements whose text was removed or rewritten.
    if (tr.docChanged && !whitespaceOnlyChange(tr)) return reconcileStatementRuns(value, tr);
    return value;
  },
});

/**
 * The running statement's rising wall time. The host reports only status
 * transitions; this field carries the ticker's elapsed value so the gutter
 * marker can re-render with the current count (via the gutter's
 * lineMarkerChange in SqlEditor).
 */
const setRunTick = StateEffect.define<number>();

const runElapsedField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRunTick)) return e.value;
    return value;
  },
});

export { setStatementRuns, statementRunsField, setRunTick, runElapsedField };
