// ── Raster icon registries ────────────────────────────────────────────────────
// Two deliberately distinct icon families, bundled from src/assets/icons:
//
//   • Plugins  → Noto emoji (full colour). Rendered as <img>; a plugin panel is
//     a *tool*, and the colourful glyph sets it apart from the schema it acts on.
//   • Database objects → Tabler line icons (single-hue, transparent). Rendered
//     through a CSS mask so they inherit the existing per-family `.ti-*` hue and
//     stay theme-aware — a table, a column and a trigger read as one calm,
//     monochrome family, never competing with the plugin colour.
//
// These pre-rasterised PNGs are safe where a system emoji font is not: they can
// never fall back to tofu on Linux (the reason the old inline-SVG doctrine in
// panelIcons.tsx / treeIcons.tsx banned raster *emoji fonts*). The inline SVGs
// remain as the fallback for any id without a bundled asset.
//
// Vite inlines/serves each PNG via import.meta.glob; keys are the bare filename
// without extension (e.g. `table`, `tuner`).

function toMap(glob: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [path, url] of Object.entries(glob)) {
    const name = path.split('/').pop()!.replace(/\.png$/, '');
    map[name] = url as string;
  }
  return map;
}

/** Plugin panel id (`tuner`, `processes`, …) → bundled Noto emoji URL. */
export const PLUGIN_ICON_URL: Record<string, string> = toMap(
  import.meta.glob('../assets/icons/plugins/*.png', { eager: true, query: '?url', import: 'default' }),
);

/**
 * Object-icon slot (`table`, `pk`, `function`, …) → bundled Tabler PNG URL,
 * pre-tinted to the object's per-family hue. Rendered as a plain <img> (the same
 * mechanism the plugin icons use) rather than a CSS mask, so it needs no
 * `mask-image` support in the webview — WebKitGTK on Linux has been unreliable
 * there. The hue is baked into the artwork instead of coming from `currentColor`.
 */
export const OBJECT_ICON_URL: Record<string, string> = toMap(
  import.meta.glob('../assets/icons/objects-tinted/*.png', { eager: true, query: '?url', import: 'default' }),
);
