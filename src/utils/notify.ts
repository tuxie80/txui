/**
 * The "your long query finished" OS notification — the pure half.
 *
 * Decides WHETHER a finished run is worth a desktop notification and what it
 * says, with no Tauri or DOM imports so it stays testable under `node --test`.
 * The impure half (permission, sendNotification, focus check against the live
 * document) lives in store/notify.ts — the same split beep.ts makes against
 * the WebAudio API.
 *
 * One threshold serves both the beep and the notification: the beep already
 * answers "is this run long enough to have looked away from" via
 * `longQueryBeepSecs`, and a second knob would just drift from the first.
 */

import { fmtDuration } from './fmtDuration.ts';

/** What a finished run looked like. */
export interface LongQueryNotice {
  /** Wall time of the run. */
  durationMs: number;
  ok: boolean;
  /** Statements in the run; 1 for the single-statement path. */
  statements?: number;
  /** Error text when ok is false — only its first line is shown. */
  error?: string;
}

/** The environment the decision depends on, injected so tests own it. */
export interface NotifyEnv {
  /** The notifyOnLongQuery preference. */
  enabled: boolean;
  /** The window has focus — a notification to a window you are watching is noise. */
  focused: boolean;
  /** longQueryBeepSecs — the shared beep/notification threshold. */
  thresholdSecs: number;
}

/** Mirrors beepIfLong's threshold rule: strictly shorter than the threshold stays quiet. */
export function shouldNotifyLongQuery(n: LongQueryNotice, env: NotifyEnv): boolean {
  if (!env.enabled) return false;
  if (env.focused) return false;
  if (!(env.thresholdSecs > 0)) return false;
  return n.durationMs / 1000 >= env.thresholdSecs;
}

/** First non-empty line, capped — an error body is a headline, not a stack trace. */
function firstLine(text: string, max = 140): string {
  const line = text.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Title + body for the notification, compact enough for an OS banner. */
export function longQueryNotification(n: LongQueryNotice): { title: string; body: string } {
  if (!n.ok) {
    return {
      title: 'TxUI — query failed',
      body: `✗ ${firstLine(n.error ?? 'unknown error')}`,
    };
  }
  const stmts = n.statements ?? 1;
  return {
    title: 'TxUI — query finished',
    body: `✓ ${stmts} statement${stmts === 1 ? '' : 's'} · ${fmtDuration(Math.round(n.durationMs))}`,
  };
}
