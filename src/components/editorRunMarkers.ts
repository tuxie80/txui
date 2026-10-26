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

function whitespaceOnlyChange(tr: Transaction): boolean {
  let onlyWhitespace = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!/^\s*$/.test(tr.startState.sliceDoc(fromA, toA)) || !/^\s*$/.test(inserted.toString())) {
      onlyWhitespace = false;
    }
  });
  return onlyWhitespace;
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

const statementRunsField = StateField.define<StatementRun[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStatementRuns)) return e.value;
    // Whitespace does not change what ran: keep the measured outcome and let
    // markerMap place it on the statement's new line. Substantive edits still
    // invalidate every marker until the host reports a genuinely NEW run.
    if (tr.docChanged && !whitespaceOnlyChange(tr)) return [];
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
