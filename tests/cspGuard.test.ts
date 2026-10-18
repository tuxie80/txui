import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The 1.3.0 release shipped a strict CSP without realizing that Tauri appends
// 'nonce-<random>' + sha256 hashes to script-src/style-src when serving the
// bundled assets (tauri manager::replace_csp_nonce) — and per the CSP spec, a
// nonce/hash source makes browsers IGNORE 'unsafe-inline'. CodeMirror injects
// all of its styles as runtime <style> elements (style-mod), so the packaged
// editor rendered completely unstyled: invisible text, dead clicks, no minimap.
// Dev mode was unaffected (Vite serves without the nonce machinery), which is
// why every pre-release check passed. The fix: exclude style-src from Tauri's
// CSP modification. This test pins that invariant so it cannot regress silently.

const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const security = conf.app.security;

test('when a CSP is set, style-src stays Tauri-unmodified (CodeMirror needs unsafe-inline)', () => {
  if (security.csp == null) return; // no CSP: nothing to guard
  const disabled = security.dangerousDisableAssetCspModification;
  const covers =
    disabled === true ||
    (Array.isArray(disabled) && disabled.includes('style-src'));
  assert.ok(covers,
    "csp is set but Tauri may still append nonces/hashes to style-src — that disables " +
    "'unsafe-inline' and breaks CodeMirror's runtime-injected styles (the 1.3.0 editor bug). " +
    'Set security.dangerousDisableAssetCspModification to include "style-src".');
});

test('script-src keeps Tauri hardening (not blanket-disabled)', () => {
  const disabled = security.dangerousDisableAssetCspModification;
  assert.notEqual(disabled, true,
    'disabling ALL CSP asset modification also drops script-src nonces — too broad; scope to style-src');
});

test('if style-src is configured, it must allow inline styles', () => {
  for (const key of ['csp', 'devCsp']) {
    const csp = security[key];
    if (typeof csp !== 'string') continue;
    const m = csp.match(/style-src\s+([^;]+)/);
    if (m) assert.ok(m[1].includes("'unsafe-inline'"),
      `${key} style-src lacks 'unsafe-inline' — CodeMirror needs it (see smoke verdict test)`);
  }
});
