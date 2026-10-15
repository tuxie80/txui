import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Screenshot harness config for the geo wave: serves dev/geo-shot/ with the
// Tauri layer mocked, same alias trick as dev/vite.shots.config.ts.
const mock = resolve(__dirname, 'mock-tauri.ts')

export default defineConfig({
  root: resolve(__dirname, 'geo-shot'),
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
  define: { __APP_VERSION__: JSON.stringify('dev') },
  server: { port: 5279 },
})
