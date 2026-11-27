/**
 * Every pure `src/utils` module must be importable by `node --test`.
 *
 * Node's native TypeScript stripping does not resolve extensionless relative
 * imports, so a module written with `from './sibling'` instead of
 * `from './sibling.ts'` **cannot be tested at all** — and the failure is not
 * "this test fails", it is "no test can be written". Which is exactly what
 * happened: `limitGuard.ts` had no test file, and appended `LIMIT n` on SQL
 * Server, where the syntax does not exist. Every unbounded SELECT in the editor
 * was a syntax error from the day that engine shipped.
 *
 * This asserts the property directly rather than trusting anyone to notice.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

/**
 * Thin I/O, Tauri, DOM and WebAudio glue modules that hold side effects so
 * their callers stay pure (see AGENTS.md). Each entry is excluded deliberately
 * rather than accidentally hiding an extensionless import in a pure module.
 */
const IMPURE = new Set([
  'aiClient.ts',     // Tauri invoke + preferences bridge for AI completion calls
  'killExec.ts',     // Tauri invoke + session/audit logging for KILL execution
  'exportersIo.ts',  // Tauri save dialog/file writers + clipboard (split from pure exporters.ts)
  'themes.ts',       // DOM root CSS custom-property writer + Tauri set_active_theme sync
  'audit.ts',        // Tauri audit_insert + store/logStore writer
  'panelAudit.ts',   // Thin panel action wrapper over audit.ts + store/logStore
  'smoke.ts',        // In-app DOM/Tauri release self-test runner (smokeVerdict tested in smoke.test.ts)
  'tooltip.ts',      // Delegated DOM tooltip overlay + store/preferences lifetime lookup
  'beep.ts',         // WebAudio (AudioContext) notification tone synthesizer
  'measure.ts',      // Cached DOM <canvas> 2D text-width measurement
]);

const modules = readdirSync('src/utils')
  .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && !IMPURE.has(f));

describe('pure utils are importable by the test runner', () => {
  test('there are modules to check', () => {
    assert.ok(modules.length > 100, `only found ${modules.length}`);
  });

  for (const f of modules) {
    test(`${f} loads`, async () => {
      // A failure here is almost always an extensionless relative import.
      await import(`../src/utils/${f}`);
    });
  }
});
