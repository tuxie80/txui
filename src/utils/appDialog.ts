/**
 * appDialog — promise-based, in-DOM replacements for
 * window.confirm / prompt / alert.
 *
 * Why this exists: on Linux WebKitGTK an unhandled script dialog never
 * appears — `confirm()` resolves immediately as if ACCEPTED, `prompt()`
 * returns null, `alert()` is a no-op (verified live: a `window.confirm`-gated
 * DROP DATABASE ran with no dialog on screen). WKWebView has no
 * `window.prompt` at all. So every interactive question in the app goes
 * through these functions and is rendered in-DOM by
 * `src/components/AppDialogHost.tsx`, which subscribes here and behaves
 * identically on all three desktops.
 *
 * This module is deliberately pure — no React/Tauri imports, and
 * window/document are never touched at module scope — so it stays importable
 * under `node --test` like every other `src/utils` module.
 */

export interface DialogOptions {
  /** Title in the modal header (defaults per kind: Confirm / Alert / the message itself for prompt). */
  title?: string;
  /** Confirm-button label (default "OK"). */
  okLabel?: string;
  /** Cancel-button label (default "Cancel"; not rendered for alerts). */
  cancelLabel?: string;
  /** Destructive action: the confirm button renders red and nothing about
   *  the dialog can be dismissed by accident (no backdrop click). */
  danger?: boolean;
}

export type DialogKind = 'confirm' | 'prompt' | 'alert';

/** One pending dialog, handed to the host component via subscribeDialogs. */
export interface DialogRequest {
  id: number;
  kind: DialogKind;
  message: string;
  /** Pre-filled input text (prompt only). */
  defaultValue: string;
  opts: DialogOptions;
  /** Resolve the caller's promise. Called by the host via answerDialog. */
  resolve: (value: boolean | string | null | undefined) => void;
}

type DialogListener = (req: DialogRequest | null) => void;

const listeners = new Set<DialogListener>();
/** Requests waiting their turn — only one dialog is on screen at a time. */
const queue: DialogRequest[] = [];
let current: DialogRequest | null = null;
let nextId = 0;

function emit() {
  for (const l of listeners) l(current);
}

function enqueue(kind: DialogKind, message: string, defaultValue: string,
  opts: DialogOptions, resolve: DialogRequest['resolve']): void {
  queue.push({ id: ++nextId, kind, message, defaultValue, opts, resolve });
  if (!current) {
    current = queue.shift() ?? null;
    emit();
  }
}

/**
 * Subscribe to the pending dialog (null = none). The listener is called
 * immediately with the current state and again on every change. Used by
 * AppDialogHost; returns an unsubscribe function.
 */
export function subscribeDialogs(listener: DialogListener): () => void {
  listeners.add(listener);
  listener(current);
  return () => { listeners.delete(listener); };
}

/** Answer the pending dialog. No-op if `req` is not the one on screen. */
export function answerDialog(req: DialogRequest, value: boolean | string | null | undefined): void {
  if (!current || current.id !== req.id) return;
  current.resolve(value);
  current = queue.shift() ?? null;
  emit();
}

/** true = confirmed (OK / Enter), false = cancelled (Cancel / Escape). */
export function confirmDialog(message: string, opts: DialogOptions = {}): Promise<boolean> {
  return new Promise(resolve => enqueue('confirm', message, '', opts, v => resolve(v === true)));
}

/** The entered text, or null when cancelled. */
export function promptDialog(message: string, defaultValue = '', opts: DialogOptions = {}): Promise<string | null> {
  return new Promise(resolve => enqueue('prompt', message, defaultValue, opts,
    v => resolve(typeof v === 'string' ? v : null)));
}

/** Resolves when the user dismisses the message. */
export function alertDialog(message: string, opts: DialogOptions = {}): Promise<void> {
  return new Promise(resolve => enqueue('alert', message, '', opts, () => resolve()));
}
