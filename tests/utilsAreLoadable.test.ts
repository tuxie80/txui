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
 * The five modules that deliberately import Tauri — they hold the I/O so their
 * callers stay pure (see AGENTS.md). They cannot load outside the app, and that
 * is the point of them, so they are excluded rather than fixed.
 */
const IMPURE = new Set(['aiClient.ts', 'killExec.ts', 'exportersIo.ts', 'themes.ts', 'audit.ts']);

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
