/**
 * How a connection's colour becomes the look of its tab and sidebar row.
 *
 * One colour, one look: a tinted fill under a stronger top edge. There used to
 * be a second colour and a thirteen-way fill pattern here; it was more dials
 * than the job needs — the colour alone already tells twenty tabs apart, and
 * the patterns mostly fought the label for contrast.
 *
 * Pure module: returns plain CSS property objects, unit-tested with
 * `node --test`.
 */

export interface TabColors {
  /** Primary colour, or null for "no colour set". */
  color?: string | null;
}

/**
 * Alpha-blend a hex colour toward transparency.
 *
 * Tabs sit on the app background, so a full-strength fill would drown the
 * label. The fill is deliberately translucent; `active` gets more of the
 * colour so the selected tab still reads as selected.
 */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.trim();
  // Accept #rgb and #rrggbb; anything else is passed through untouched so a
  // CSS keyword or var() still works.
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h);
  if (!m) return h;
  const body = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${body}${a}`;
}

/**
 * The CSS for one tab. Returns properties to spread onto `style`.
 *
 * `active` raises the opacity rather than changing anything structural —
 * a tab that changes size or weight when selected makes the whole bar shift
 * under the pointer.
 */
export function tabStyle(c: TabColors, active = false): React.CSSProperties {
  const base = c.color;
  if (!base) return {};
  return {
    // The coloured top edge is the part that survives at a glance.
    boxShadow: `inset 0 2px 0 ${base}`,
    // Strength: enough to see, never enough to fight the label.
    background: withAlpha(base, active ? 0.42 : 0.24),
  };
}
