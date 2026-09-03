/**
 * The window-reveal path. It is small, it is invisible when it breaks, and it
 * was broken for as long as it existed.
 *
 * The window is created hidden (`"visible": false`) so the OS never presents a
 * bare white frame, and the frontend shows it once the UI is built. Two faults
 * made every single launch take **5.2 seconds** instead of 0.4, and neither
 * produced an error anyone could see:
 *
 *  1. **The reveal waited for a rendered frame.** It called `show()` inside a
 *     double `requestAnimationFrame` — "after the first real frame". A hidden
 *     webview does not render, so rAF never fires, so the reveal waited on a
 *     frame that could only happen once the reveal had already run. Measured:
 *     rAF #1 fired at 5255 ms, i.e. only after the 5 s wedged-app fallback in
 *     lib.rs had shown the window at 5217 ms.
 *  2. **`show()` was not permitted.** `core:default` does not grant
 *     `core:window:allow-show`, so the call rejected — into a
 *     `.catch(() => {})` that discarded it. Silent, every time.
 *
 * The app was therefore only ever revealed by its own crash fallback. These
 * tests pin the three things that have to stay true; each maps to a fault that
 * actually shipped.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const caps = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const gateRaw = readFileSync('src/components/RevealGate.tsx', 'utf8');
/**
 * Comments stripped. The file documents the old rAF deadlock at length, so a
 * naive text search finds `requestAnimationFrame` in the prose explaining why
 * it must not be there — the check has to look at code only.
 */
const gate = gateRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const main = readFileSync('src/main.tsx', 'utf8');
const win = conf.app.windows[0];

describe('the window the reveal has to show', () => {
  test('is created hidden — which is why any of this is needed', () => {
    assert.equal(win.visible, false,
      'if the window is no longer hidden the reveal is pointless, and the '
      + 'RevealGate machinery should go with it');
  });

  test('comes up maximized', () => {
    assert.equal(win.maximized, true);
  });
});

describe('permission to show it', () => {
  test('core:window:allow-show is granted', () => {
    // core:default does NOT include it. Without this the reveal rejects and
    // the app is revealed only by the 5 s fallback — a 13x slower startup
    // whose sole symptom is "it feels slow".
    assert.ok(caps.permissions.includes('core:window:allow-show'),
      `capabilities/default.json grants [${caps.permissions.join(', ')}] — `
      + 'without core:window:allow-show, getCurrentWindow().show() rejects.');
  });
});

describe('the reveal is not gated on a frame', () => {
  test('nothing waits for requestAnimationFrame before show()', () => {
    const beforeShow = gate.slice(0, gate.indexOf('.show()'));
    assert.ok(!/requestAnimationFrame/.test(beforeShow),
      'the reveal waits for a rendered frame before showing the window. A '
      + 'hidden webview never renders one — this is the 5-second deadlock.');
  });

  test('the trigger is React commit (useLayoutEffect), not paint', () => {
    assert.match(gate, /useLayoutEffect\(\s*reveal/,
      'RevealGate must fire on commit; a paint-based trigger cannot run while '
      + 'the window is hidden');
  });

  test('rAF after show() is fine, and is what holds the logo frame', () => {
    const afterShow = gate.slice(gate.indexOf('.show()'));
    assert.match(afterShow, /requestAnimationFrame/,
      'once the window is up, frames run again — that rAF is what lets the '
      + 'first presented frame hold the splash');
  });
});

describe('a failed reveal can never be silent again', () => {
  test('show() rejection is reported, not swallowed', () => {
    assert.ok(!/\.show\(\)[\s\S]{0,200}catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(gate),
      'an empty catch on show() is exactly what hid this bug');
    assert.match(gate, /catch[\s\S]{0,120}console\.error/,
      'a rejected show() must say so');
  });
});

describe('it is actually mounted', () => {
  test('main.tsx renders RevealGate inside the root', () => {
    // Rendering the component is the whole trigger; without it nothing calls
    // show() and the 5 s fallback is back.
    assert.match(main, /<RevealGate\s*\/>/, 'main.tsx never renders <RevealGate />');
    assert.match(main, /import \{ RevealGate \}/);
  });
});
