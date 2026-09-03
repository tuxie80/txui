/**
 * Per-statement run markers — the translation layer between "what ran" (kept
 * on the tab by QueryTabs) and "what the gutter draws" (SqlEditor's
 * statementGutter, one marker per non-blank statement, in split order).
 *
 * The accumulating model: the tab keeps a per-statement map (`stmtRuns`).
 * A single ⌘↵ run updates ONLY its statement's entry — the others' chips and
 * times persist. A whole-script run replaces every entry (and its per-
 * statement lines drive the gutter directly while they exist). When a single
 * run follows a script run, the script's finished entries fold INTO the
 * accumulator first (foldScriptInto), so its markers survive too — a marker
 * lives until its own statement is re-run or the buffer is edited (the
 * editor-side field clears on docChanged).
 *
 * The host (QueryTabs.executeSql) resolves the editor's doc offset to a
 * statement index ONCE, at run time, via statementIndexAt — crucially, nothing
 * here is derived from the live document afterwards, so editing the buffer
 * cannot shift the output and resurrect a marker the editor has invalidated.
 *
 * Pure: no React/Tauri imports — unit-tested with node --test.
 */
import { splitStatements } from './sqlSplit.ts';
import type { StatementRun } from '../components/SqlEditor';

/** One statement's run outcome, accumulated on the tab across single runs. */
export interface StmtRun {
  status: 'ok' | 'error' | 'running';
  ms?: number;
  /** Wall-clock start (epoch ms) — shown in the marker's hover tooltip. */
  startedAt?: number;
  /**
   * An auto-EXPLAIN plan for this statement is cached on the tab
   * (`tab.autoPlans`). Set by the background fetch, AFTER the run's own entry
   * landed — the two update the same entry, so this rides the same map.
   */
  hasPlan?: boolean;
  /** Digest stats from the local query history (same statement shape). */
  stats?: { runs: number; p95Ms: number };
}

/** statement index → outcome. (Record keys stringify; we only read them back.) */
export type StmtRunMap = Readonly<Record<number, StmtRun>>;

/** One line of a script run's outcome (`pending` = not reached yet). */
export interface ScriptRunLine {
  status: 'pending' | 'ok' | 'error' | 'skipped' | 'running';
  ms?: number;
  /** Wall-clock start (epoch ms) — shown in the marker's hover tooltip. */
  startedAt?: number;
}

/**
 * Doc offset → index among the non-blank statements — the same enumeration the
 * gutter uses (`splitStatements` filtered on `text.trim()`). Called ONCE, at
 * run time, against the buffer as it then was. The offset maps to the FIRST
 * statement ending at or after it: an exact statement start (what the editor
 * passes) lands on its own statement, and an offset in leading whitespace or
 * comments still resolves somewhere sane. -1 only when the document holds no
 * statement at all.
 */
export function statementIndexAt(doc: string, from: number, delimiter = ';'): number {
  const stmts = splitStatements(doc, delimiter).filter(x => x.text.trim());
  for (let i = 0; i < stmts.length; i++) if (from <= stmts[i].to) return i;
  return stmts.length - 1;
}

/**
 * The gutter array for a script run's lines. `pending` maps to `skipped` —
 * invisible — so a statement that hasn't run (yet) never shows a marker.
 *
 * `base` is the BUFFER statement index the run started at: a selection run's
 * line 0 is buffer statement K, so K invisible `skipped` placeholders shift
 * the run's markers onto the lines that actually ran (whole-buffer runs pass
 * 0 and are unchanged).
 */
export function scriptLinesToRuns(script: ScriptRunLine[], base = 0): StatementRun[] {
  const runs: StatementRun[] = script.map(l => ({
    status: (l.status === 'pending' ? 'skipped' : l.status) as StatementRun['status'],
    ms: l.ms,
    startedAt: l.startedAt,
  }));
  if (base <= 0) return runs;
  const pad: StatementRun[] = [];
  for (let i = 0; i < base; i++) pad.push({ status: 'skipped' });
  return pad.concat(runs);
}

/**
 * Fold a script run's FINISHED lines into the accumulator. Called when a
 * single run replaces the script's result view: its markers must not vanish
 * with it. Existing accumulator entries win — they are newer by construction
 * (a single run is what creates them, and it clears the script lines).
 */
export function foldScriptInto(
  script: ScriptRunLine[] | null | undefined,
  acc: StmtRunMap,
): StmtRunMap {
  if (!script) return acc;
  const out: Record<number, StmtRun> = { ...acc };
  script.forEach((l, i) => {
    if ((l.status === 'ok' || l.status === 'error') && out[i] === undefined) {
      out[i] = { status: l.status, ms: l.ms, startedAt: l.startedAt };
    }
  });
  return out;
}

/**
 * The gutter array for the accumulated single runs: one slot per statement up
 * to the highest run index, gaps filled with invisible `skipped` so each chip
 * lines up with its own statement. Empty accumulator → no gutter at all.
 */
export function stmtRunsToRuns(acc: StmtRunMap): StatementRun[] | undefined {
  const indices = Object.keys(acc).map(Number);
  if (indices.length === 0) return undefined;
  const max = Math.max(...indices);
  const out: StatementRun[] = [];
  for (let i = 0; i <= max; i++) {
    const r = acc[i];
    out.push(r
      ? { status: r.status, ms: r.ms, startedAt: r.startedAt, hasPlan: r.hasPlan, stats: r.stats }
      : { status: 'skipped' });
  }
  return out;
}

/**
 * `[YYYY-MM-DD HH:MM:SS]` — local time, the same stamp the session log
 * prefixes every line with (store/logStore). The run-marker tooltip leads
 * with it, so hovering a chip says WHEN the statement ran, not just how long.
 */
export function runStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

/**
 * The clipboard form of a finished run marker, one line:
 * `[YYYY-MM-DD HH:MM:SS] <one-line SQL> → ok · 1012 ms` — the same stamp and
 * the same one-line-SQL convention the session log uses (store/logStore), so a
 * pasted line reads as one more log entry.
 *
 * Returns null when there is no timing to copy (running / skipped / untimed):
 * a "timing line" without a time is just the SQL, and Copy SQL already does
 * that. The stamp is omitted when the run never recorded a start time.
 */
export function timingLine(
  run: { status: string; ms?: number; startedAt?: number },
  sql: string,
): string | null {
  if (run.ms == null) return null;
  if (run.status !== 'ok' && run.status !== 'error') return null;
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const capped = oneLine.length > 200 ? oneLine.slice(0, 199) + '…' : oneLine;
  const stamp = run.startedAt != null ? `${runStamp(run.startedAt)} ` : '';
  return `${stamp}${capped} → ${run.status} · ${run.ms} ms`;
}

// ── the running-statement ticker ─────────────────────────────────────────────
// The host only learns a statement's FINAL ms; the rising counter in the
// gutter is an editor-side clock over the runs array the host already sends.
// This is the pure decision layer — the ViewPlugin in SqlEditor wraps it with
// a ~8 Hz interval and dispatches the elapsed value into a StateField.

/** Ticker state: which statement is running, and since when (ms epoch). */
export interface RunTick { idx: number; startedAt: number }

/** Index of the currently-running statement, or -1 when nothing runs. */
export function runningIndex(runs: readonly { status: string }[]): number {
  return runs.findIndex(r => r.status === 'running');
}

/**
 * Advance the ticker against the current runs. Identity-stable while the SAME
 * statement keeps running (the plugin compares by identity to decide whether
 * anything changed); a NEW running statement (script moved to the next one)
 * restarts the clock; no running statement → null (the plugin stops its timer).
 */
export function nextRunTick(
  prev: RunTick | null,
  runs: readonly { status: string }[],
  now: number,
): RunTick | null {
  const idx = runningIndex(runs);
  if (idx < 0) return null;
  if (prev && prev.idx === idx) return prev;
  return { idx, startedAt: now };
}

/** Elapsed ms for the running marker, never negative (clock skew guard). */
export function tickElapsed(tick: RunTick, now: number): number {
  return Math.max(0, now - tick.startedAt);
}

/**
 * The six-dot braille spinner frames, cycled by elapsed time. Same width on
 * every frame, so the gutter doesn't jitter sideways while it spins.
 */
export const RUN_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴'] as const;

/** The spinner glyph for an elapsed time, advancing one frame per `frameMs`. */
export function spinnerFrame(elapsedMs: number, frameMs = 125): string {
  const i = Math.floor(Math.max(0, elapsedMs) / frameMs) % RUN_SPINNER.length;
  return RUN_SPINNER[i];
}
