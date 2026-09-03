import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

/**
 * Truncate the `CHANGELOG.md?raw` import to the newest releases (WP-15 15.4):
 * all 81 releases weighed 320 KB — the second-largest JS chunk — for a
 * What's New window that shows the top of the file. The real CHANGELOG.md is
 * untouched (tests/changelog.test.ts reads the file, not this import).
 */
function truncateChangelog(keepReleases = 5): Plugin {
  return {
    name: 'txui-truncate-changelog',
    enforce: 'pre',
    load(id) {
      if (!/CHANGELOG\.md\?raw/.test(id)) return null
      const path = id.split('?')[0]
      const text = readFileSync(path, 'utf8')
      // Keep everything up to and including the Nth released section
      // (`## [x.y.z]` headings; `## [Unreleased]` does not count).
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), truncateChangelog()],
  build: {
    rolldownOptions: {
      output: {
        // React/react-dom never change independently of the app, but they are
        // ~25% of the entry chunk. Splitting them keeps every chunk under the
        // 500 kB warning line and lets the webview fetch them in parallel
        // with the app shell. Load behavior is unchanged — both are static
        // entry imports.
        advancedChunks: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
})
