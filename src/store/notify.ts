/**
 * The impure half of the long-query notification: reads the prefs and the
 * window focus, asks the OS for permission once, and sends. The decision and
 * the payload are pure in utils/notify.ts — this file is the beep.ts-shaped
 * shell around them (and the only place the notification plugin is imported).
 *
 * QueryTabs calls this from exactly the spots where it calls beepIfLong: the
 * beep says it to your ears, this says it to the OS notification centre when
 * the whole window is in the background.
 */
import {
  isPermissionGranted, requestPermission, sendNotification,
} from '@tauri-apps/plugin-notification';
import { getPref, PREFS } from './preferences';
import {
  longQueryNotification, shouldNotifyLongQuery, type LongQueryNotice,
} from '../utils/notify';

/**
 * Cached after the first grant so a run finishing does not re-prompt. Kept
 * true-only: a denial is re-asked next time (the user may have flipped the OS
 * setting since), never cached into silence.
 */
let granted = false;

async function ensurePermission(): Promise<boolean> {
  if (granted) return true;
  try {
    granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
  } catch {
    granted = false;   // notification API unavailable (headless, tests)
  }
  return granted;
}

/**
 * Tell the user a connection failed to open — the sidebar's red status dot is
 * easy to miss, and the click may not even have come from the sidebar (palette,
 * auto-connect). Fire-and-forget like notifyLongQuery: a notification must
 * never take down the error path it rides on.
 */
export async function notifyConnectFailed(connectionName: string, error: string): Promise<void> {
  try {
    if (!await ensurePermission()) return;
    sendNotification({
      title: `Connection failed — ${connectionName}`,
      body: error.split('\n')[0],
    });
  } catch {
    /* the OS said no — silence is the correct fallback, as with the beep */
  }
}

/**
 * Notify when a run finished that took long enough to have looked away from.
 * Never throws: a notification must not take down the query that just ran.
 */
export async function notifyLongQuery(
  startedMs: number,
  ok: boolean,
  extra?: { statements?: number; error?: string },
): Promise<void> {
  try {
    const notice: LongQueryNotice = {
      durationMs: Date.now() - startedMs,
      ok,
      statements: extra?.statements,
      error: extra?.error,
    };
    if (!shouldNotifyLongQuery(notice, {
      enabled: getPref(PREFS.notifyOnLongQuery),
      focused: document.hasFocus(),
      thresholdSecs: getPref(PREFS.longQueryBeepSecs),
    })) return;
    if (!await ensurePermission()) return;
    sendNotification(longQueryNotification(notice));
  } catch {
    /* the OS said no — silence is the correct fallback, as with the beep */
  }
}
