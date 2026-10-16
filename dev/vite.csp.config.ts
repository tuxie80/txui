import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// CSP render check: a PRODUCTION build (bundled, minified, code-split — the
// shape the CSP actually governs) with every @tauri-apps/* module aliased to
// the docs mock, so the real frontend boots in plain Chromium. Served with the
// production CSP from tauri.conf.json by dev/csp_check.mjs.
// Root stays the project so index.html / src are picked up unchanged.

/** Same CHANGELOG truncation as the root vite.config.ts — keeps chunking
    identical to the shipping build. */
function truncateChangelog(keepReleases = 5): Plugin {
  return {
    name: 'txui-truncate-changelog',
    enforce: 'pre',
    load(id) {
      if (!/CHANGELOG\.md\?raw/.test(id)) return null
      const path = id.split('?')[0]
      const text = readFileSync(path, 'utf8')
      const lines = text.split('\n')
      let releases = 0
      let end = lines.length
      for (let i = 0; i < lines.length; i++) {
        if (/^## \[(?!Unreleased)/.test(lines[i])) {
          releases++
          if (releases === keepReleases + 1) { end = i; break }
        }
      }
      const kept = lines.slice(0, end).join('\n')
        + (end < lines.length ? '\n\n---\n\n*Older releases are in CHANGELOG.md in the repository.*\n' : '')
      return `export default ${JSON.stringify(kept)}`
    },
  }
}

const mock = resolve(__dirname, 'mock-tauri.ts')

const version = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
).version as string

export default defineConfig({
  root: resolve(__dirname, '..'),
  plugins: [react(), truncateChangelog()],
  resolve: {
    alias: [
      { find: '@tauri-apps/api/core', replacement: mock },
      { find: '@tauri-apps/api/event', replacement: mock },
      { find: '@tauri-apps/api/webview', replacement: mock },
      { find: '@tauri-apps/api/app', replacement: mock },
      { find: '@tauri-apps/api/window', replacement: mock },
      { find: '@tauri-apps/plugin-dialog', replacement: mock },
      { find: '@tauri-apps/plugin-notification', replacement: mock },
    ],
  },
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dev/.csp-dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
})
