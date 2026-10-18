/**
 * Release smoke self-test — the "would have caught the 1.3.0 CSP bug" gate.
 *
 * Runs INSIDE the real packaged app (the only place where Tauri's CSP asset
 * modification, the production bundle and the real webview all apply), gated
 * by localStorage `dbgui.smoke = '1'` — the harness (dev/release_smoke.sh)
 * writes that flag into the webview's LocalStorage before launch. Not a dev
 * gate: the whole point is exercising the SHIPPING artifact.
 *
 * Flow: boot → open a scratch DuckDB session (in-memory, no server needed)
 * → assert the editor mounts STYLED (style-mod's injected CSS is what the
 * 1.3.0 CSP nonce bug killed: computed position must be `relative`, the
 * gutter must have width, a line must have height) → synthetic typing must
 * land in the document → run SELECT 42 through the real backend → a result
 * grid with one row must render. Every CSP violation fails the run.
 *
 * Verdict: JSON written via run_os_command to `${TMPDIR}/txui-smoke.json`,
 * then the app exits 0 (pass) / 1 (fail).
 */
import { invoke } from '@tauri-apps/api/core';

export interface SmokeCheck { id: string; ok: boolean; detail?: string }
export interface SmokeVerdict {
  ok: boolean; checks: SmokeCheck[]; cspViolations: string[]; ms: number;
}

/** Pure verdict assembly — unit-testable without a DOM. */
export function smokeVerdict(checks: SmokeCheck[], cspViolations: string[], ms: number): SmokeVerdict {
  return { ok: checks.every(c => c.ok) && cspViolations.length === 0, checks, cspViolations, ms };
}

const REPORT_PATH = '/tmp/txui-smoke.json';

function report(verdict: SmokeVerdict): void {
  try {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(verdict, null, 1))));
    void invoke('run_os_command', { command: `echo ${b64} | base64 -D > ${REPORT_PATH}` })
      .catch(() => {})
      .finally(() => {
        import('@tauri-apps/plugin-process')
          .then(p => p.exit(verdict.ok ? 0 : 1))
          .catch(() => {});
      });
  } catch { /* never break the app */ }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(sel: string, timeoutMs: number): Promise<Element | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const el = document.querySelector(sel);
    if (el) return el;
    await sleep(250);
  }
  return null;
}

export async function runSmokeSelfTest(): Promise<void> {
  const t0 = Date.now();
  const checks: SmokeCheck[] = [];
  const cspViolations: string[] = [];
  document.addEventListener('securitypolicyviolation', e =>
    cspViolations.push(`${e.effectiveDirective}: ${e.blockedURI}`));
  const check = (id: string, ok: boolean, detail?: string) =>
    checks.push({ id, ok, detail: detail?.slice(0, 300) });

  try {
    // 1. app booted
    check('root-mounted', document.getElementById('root')?.childElementCount ? true : false);

    // 2. scratch DuckDB session (real backend, no server)
    window.dispatchEvent(new CustomEvent('dbgui:new-scratch'));
    const cm = await waitFor('.cm-editor', 30_000);
    check('scratch-editor-mounted', !!cm);
    if (!cm) return report(smokeVerdict(checks, cspViolations, Date.now() - t0));

    // 3. editor is STYLED — the 1.3.0 fingerprint was position:static +
    //    collapsed gutters because style-mod's <style> tags were CSP-blocked.
    const content = document.querySelector('.cm-content') as HTMLElement | null;
    const gutters = document.querySelector('.cm-gutters') as HTMLElement | null;
    const line = document.querySelector('.cm-line') as HTMLElement | null;
    check('cm-content-editable', content?.getAttribute('contenteditable') === 'true',
      `contenteditable=${content?.getAttribute('contenteditable')}`);
    check('cm-styles-injected',
      !!content && getComputedStyle(content).position === 'relative'
        && !!gutters && gutters.getBoundingClientRect().width > 10
        && !!line && line.getBoundingClientRect().height > 5,
      content ? `position=${getComputedStyle(content).position} gutW=${gutters?.getBoundingClientRect().width} lineH=${line?.getBoundingClientRect().height}` : 'no content');

    // 4. typing lands in the document
    if (content) {
      content.focus();
      document.execCommand('insertText', false, 'SELECT 42;');
      await sleep(300);
      check('typing-lands', (content.textContent ?? '').includes('SELECT 42'),
        `doc=${(content.textContent ?? '').slice(0, 60)}`);
    }

    // 5. run through the REAL backend (in-memory DuckDB) → result grid
    window.dispatchEvent(new CustomEvent('dbgui:run-statement', { detail: { sql: 'SELECT 42 AS answer' } }));
    const grid = await waitFor('.fg-cell', 30_000);
    check('query-grid-renders', !!grid);

    // 6. no CSP violations at all
    check('no-csp-violations', cspViolations.length === 0, cspViolations[0]);
  } catch (e) {
    check('smoke-crash', false, String(e));
  }
  report(smokeVerdict(checks, cspViolations, Date.now() - t0));
}

/** Called from main.tsx. Gated on the harness flag; zero cost otherwise. */
export function maybeRunSmoke(): void {
  try {
    if (localStorage.getItem('dbgui.smoke') !== '1') return;
    // Let the app settle (splash, stores) before driving it.
    setTimeout(() => { void runSmokeSelfTest(); }, 4000);
  } catch { /* quota/corrupt storage — not a smoke run */ }
}
