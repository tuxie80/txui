// Bundle frontend components for Node execution with rolldown (the bundler
// inside Vite 8 — already in node_modules, no new dependency). Tauri imports
// are aliased to the programmable stub, CSS/assets become empty modules, and
// Vite's `import.meta.glob` is rewritten to a runtime stub (rolldown leaves
// the call in place, which Node cannot execute).
//
// Output goes to node_modules/.cache/txui-render-smoke (node_modules is
// gitignored, so the cache never dirties the tree). React and react-dom stay
// external so the bundle shares the runner's single React instance.

import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'txui-render-smoke');

const TAURI_STUB = path.join(HERE, 'tauri-stub.mjs');

const TAURI_IDS = [
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/app',
  '@tauri-apps/api/window',
  '@tauri-apps/api/webview',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-shell',
  '@tauri-apps/plugin-process',
  '@tauri-apps/plugin-notification',
];

const ASSET_RE = /\.(png|svg|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|wav)(\?.*)?$/;
const CSS_RE = /\.css(\?.*)?$/;

function smokePlugins() {
  return [
    {
      name: 'txui-tauri-stub',
      resolveId(source) {
        if (TAURI_IDS.includes(source)) return TAURI_STUB;
        return null;
      },
    },
    {
      name: 'txui-asset-stub',
      resolveId(source, importer) {
        if (CSS_RE.test(source) || ASSET_RE.test(source)) {
          // The resolved id's extension drives rolldown's module-type
          // inference; a \0 id ending in .css would be parsed AS css, which
          // rolldown refuses to bundle — so the virtual id ends in .mjs.
          return `\0smoke-asset:${encodeURIComponent(source)}.mjs`;
        }
        return null;
      },
      load(id) {
        if (id.startsWith('\0smoke-asset:')) {
          const isCss = CSS_RE.test(decodeURIComponent(id.slice('\0smoke-asset:'.length, -4)));
          return isCss ? 'export default {};' : 'export default "smoke-asset";';
        }
        return null;
      },
    },
    {
      name: 'txui-glob-rewrite',
      transform: {
        filter: { id: /\.[tj]sx?$/ },
        handler(code) {
          if (!code.includes('import.meta.glob')) return null;
          // `import.meta.glob<T>(...)` → `globalThis.__rsGlob(...)`; the shim
          // defines __rsGlob to () => ({}) (no icons, no raw CHANGELOG — the
          // markup a component produces does not depend on the URLs).
          return code.replace(/import\.meta\.glob(?:<[^>]*>)?\s*\(/g, 'globalThis.__rsGlob(');
        },
      },
    },
  ];
}

/** Content-hash the inputs so the cache invalidates when a component (or the
 *  harness itself) changes; other agents are editing src/ concurrently. */
function cacheKey(entries) {
  const h = crypto.createHash('sha1');
  h.update('v1');
  for (const f of [path.join(HERE, 'tauri-stub.mjs'), path.join(HERE, 'bundle.mjs')]) {
    h.update(fs.readFileSync(f));
  }
  // Entries import from all over src/ (utils, stores, hooks) — hash every
  // source file's mtime+size, not just the entry's, or an edit to a shared
  // util would serve a stale bundle.
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[tj]sx?$|\.css$|\.png$/.test(e.name)) {
        const st = fs.statSync(p);
        h.update(`${p}:${st.mtimeMs}:${st.size}`);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  for (const [name, abs] of entries) h.update(name + abs);
  return h.digest('hex').slice(0, 12);
}

/**
 * Bundle the given components.
 * @param {Array<[string, string]>} entries [entryName, absolutePath]
 * @returns {Promise<string>} directory containing `<name>.mjs` per entry
 */
export async function bundleComponents(entries) {
  const key = cacheKey(entries);
  const outDir = path.join(CACHE_DIR, key);
  const input = Object.fromEntries(entries);
  const marker = path.join(outDir, '.done');
  if (fs.existsSync(marker)) {
    const missing = entries.some(([name]) => !fs.existsSync(path.join(outDir, `${name}.mjs`)));
    if (!missing) return outDir;
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await build({
    input,
    cwd: ROOT,
    plugins: smokePlugins(),
    external: [/^react($|\/)/, /^react-dom($|\/)/],
    resolve: {
      extensions: ['.tsx', '.ts', '.mjs', '.js', '.jsx', '.json'],
    },
    output: {
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name].mjs',
      chunkFileNames: 'chunks/[name]-[hash].mjs',
      sourcemap: false,
      minify: false,
    },
    logLevel: 'silent',
  });
  fs.writeFileSync(marker, new Date().toISOString());
  return outDir;
}
