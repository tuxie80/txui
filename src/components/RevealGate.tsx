import { useLayoutEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

// ── Reveal ───────────────────────────────────────────────────────────────────
//
// The window is created HIDDEN (tauri.conf.json "visible": false) so the OS
// never presents a bare white native frame and the maximize/center geometry
// shuffle happens off-screen. The frontend reveals it once the UI is built.
//
// ## Why this is not gated on a rendered frame any more
//
// It used to be: `requestAnimationFrame` twice — "after the first real frame"
// — then show(). That is a deadlock, and it made EVERY launch take 5.2 s.
// A hidden webview does not render, so rAF never fires; the reveal waited for
// a frame that could only happen after the reveal. Measured with
// `TXUI_TRACE_STARTUP=1` against the real app:
//
//     206 ms  webview window created
//     463 ms  frontend module evaluated
//    5217 ms  WINDOW VISIBLE          ← the 5 s wedged-app fallback in lib.rs
//    5255 ms  rAF #1 finally fired    ← only once the window was up
//    5274 ms  show() REJECTED: window.show not allowed
//
// Two faults, either one fatal on its own. The second was that `core:default`
// does not grant `core:window:allow-show`, so show() rejected — into a
// `.catch(() => {})` that swallowed it. Both are fixed: the capability is
// granted in capabilities/default.json, and the trigger below is React's own
// commit rather than a paint.
//
// `useLayoutEffect` fires synchronously after React has committed the whole
// tree to the DOM — which needs no frame, so it works while hidden. The UI is
// fully built at that point; the only thing that has not happened is the paint
// the OS will do when the window appears. rAF is still used, but only AFTER
// show(), where the window is visible and frames actually run.
/**
 * How long the logo stays up ONCE THE WINDOW IS ACTUALLY VISIBLE, before the
 * app crossfades in underneath it.
 *
 * Measured from the window being shown, not from page load — which is the fix
 * for a second, quieter bug in the old code. The floor there ran from module
 * evaluation, while the window was still hidden, so it "held" the logo during
 * a period when there was nothing on screen to hold: the splash was paid for
 * in waiting and then barely seen. Holding after `show()` costs the same
 * milliseconds and actually displays the logo.
 */
const LOGO_HOLD_MS = 180

let revealed = false
function reveal() {
  if (revealed) return          // StrictMode double-invokes effects in dev
  revealed = true

  const crossfade = () => {
    document.body.classList.add('txui-ready')
    // Outlast the 200 ms crossfade in index.html before unmounting the node.
    setTimeout(() => document.getElementById('txui-splash')?.remove(), 260)
  }

  let win: ReturnType<typeof getCurrentWindow> | null = null
  try { win = getCurrentWindow() } catch { /* pure-browser dev, no window */ }
  if (!win) { setTimeout(crossfade, LOGO_HOLD_MS); return }

  // Show the window the moment the UI is committed, then let its first
  // presented frame hold the logo (rAF is safe here — the window is up, so
  // frames actually run) and crossfade after LOGO_HOLD_MS.
  //
  // Never silently: a rejected show() is the bug described above, and a
  // `.catch(() => {})` is exactly what hid it for so long.
  win.show()
    .then(() => requestAnimationFrame(() => setTimeout(crossfade, LOGO_HOLD_MS)))
    .catch((e: unknown) => { console.error('[txui] window.show() failed:', e); crossfade() })
}

/**
 * Renders nothing. It exists so the reveal is triggered by React's own commit.
 *
 * `useLayoutEffect` fires synchronously once React has committed the tree to
 * the DOM, which requires no rendered frame — the property that matters here,
 * because the window it is about to show is hidden and therefore cannot
 * produce one. Render it as the LAST child of the root so it runs after the
 * app's own layout effects, and outside `ErrorBoundary`'s children so a crash
 * in `App` still reveals the window (showing the error boundary's fallback
 * beats showing nothing at all).
 */
export function RevealGate() {
  useLayoutEffect(reveal, [])
  return null
}
