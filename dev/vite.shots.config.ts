import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// Screenshot build: alias every @tauri-apps/* module to the mock so the real
// frontend boots in Chromium with sample data. Root stays the project so the
// normal index.html / src tree is served unchanged.
const mock = resolve(__dirname, 'mock-tauri.ts')

// One source for the version the screenshots show: package.json. Hardcoding it
// in the mock is how the docs kept showing a release four versions old.
const version = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
).version as string

export default defineConfig({
  root: resolve(__dirname, '..'),
  plugins: [react()],
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
  server: { port: 5273 },
})
