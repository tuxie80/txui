/**
 * Macro recorder (§5.9) — pure, in-memory state behind "record a sequence of
 * editor commands and replay it."
 *
 * A macro is nothing more than an ordered list of command ids from the editor
 * command registry (utils/commandRegistry). Recording appends the id of every
 * dispatched registry command; playback re-dispatches those ids in order. We
 * record ids — not keystrokes or CodeMirror transactions — precisely because
 * §5.6 gave every command a stable id, so a macro survives a rebinding and can
 * be replayed by calling each command's `run()`.
 *
 * Keeping the state here — with no CodeMirror, React or DOM dependency — makes
 * the record → stop → replay contract testable with `node --test`. SqlEditor
 * owns the id → run map and does the actual dispatching; this module never runs
 * a command, it only remembers which ids ran and in what order.
 */

/**
 * The macro-control commands themselves. They are never captured into a macro,
 * so replaying one can neither toggle recording nor kick off another playback
 * (which would recurse). These ids are registered in commandRegistry too; the
 * tests assert both directions so the exclusion list can never drift from the
 * registry.
 */
export const MACRO_COMMAND_IDS = [
  'editor.macroRecordToggle',
  'editor.macroPlay',
] as const;

export type MacroCommandId = (typeof MACRO_COMMAND_IDS)[number];

/**
 * The replay order of a macro is simply the ids exactly as recorded. Pure and
 * trivial today, but named so the "playback re-runs them in order" contract has
 * one place to live (and one place the tests pin).
 */
export function replayOrder(ids: readonly string[]): string[] {
  return [...ids];
}

/** Would this id be captured while recording? False for the macro controls. */
export function isRecordable(
  id: string,
  excluded: ReadonlySet<string> = new Set(MACRO_COMMAND_IDS),
): boolean {
  return !excluded.has(id);
}

/**
 * A single editor's recorder. One instance per SqlEditor, held in a ref, so the
 * "last macro" persists for the life of the editor (the in-memory, per-session
 * store §5.9 asks for) without leaking across tabs.
 */
export class MacroRecorder {
  private recording = false;
  private buffer: string[] = [];
  private saved: string[] = []; // last completed macro — session memory
  private readonly excluded: ReadonlySet<string>;

  constructor(excluded: Iterable<string> = MACRO_COMMAND_IDS) {
    this.excluded = new Set(excluded);
  }

  /** Are we capturing right now? */
  get isRecording(): boolean {
    return this.recording;
  }

  /** Begin a fresh recording, discarding any half-recorded buffer. */
  start(): void {
    this.recording = true;
    this.buffer = [];
  }

  /**
   * Append a dispatched command id. A no-op (returns false) when we are not
   * recording, or when the id is a macro control — the single guard that stops
   * a macro from recording the act of recording or replaying itself.
   */
  record(id: string): boolean {
    if (!this.recording) return false;
    if (this.excluded.has(id)) return false;
    this.buffer.push(id);
    return true;
  }

  /**
   * Stop recording and return the captured id list (order preserved). A
   * non-empty capture becomes the session's "last macro"; recording nothing
   * leaves the previous last macro intact rather than wiping it.
   */
  stop(): string[] {
    this.recording = false;
    const out = [...this.buffer];
    if (out.length > 0) this.saved = [...out];
    this.buffer = [];
    return out;
  }

  /** Start if idle, stop if recording. Returns the new recording state. */
  toggle(): boolean {
    if (this.recording) {
      this.stop();
      return false;
    }
    this.start();
    return true;
  }

  /** Ids captured so far in the in-progress recording. */
  current(): string[] {
    return [...this.buffer];
  }

  /** The last completed macro, or [] if nothing has been recorded this session. */
  lastMacro(): string[] {
    return replayOrder(this.saved);
  }

  /** True when there is a replayable macro. */
  hasMacro(): boolean {
    return this.saved.length > 0;
  }
}
