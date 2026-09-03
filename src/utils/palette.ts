/**
 * The connection colour palette: 16 colours.
 *
 * Sixteen is the number you can actually tell apart and actually choose from.
 * Eight ran out on a real estate; 128 was a wall of near-identical swatches
 * where picking one took longer than it saved. One evenly-spaced hue wheel at
 * a single readable lightness is the useful middle.
 *
 * Generated rather than hand-listed so the spacing is even. Saturation and
 * lightness are fixed: every swatch reads as a colour on both the dark and
 * light themes, and none of them fight the tab label.
 *
 * Pure module: unit-tested with `node --test`.
 */

export const HUE_COUNT = 16;

/**
 * `#rrggbb` from HSL. `h` in degrees, `s` and `l` in percent.
 *
 * Every channel is clamped: the standard formula can land marginally outside
 * 0–1 through floating point, and an unclamped negative produces a string like
 * `#-e25-6ecebe` — a colour that silently renders as nothing.
 */
function hsl(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    const byte = Math.max(0, Math.min(255, Math.round(255 * c)));
    return byte.toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 16 evenly-spaced hues at one readable lightness. */
export function buildPalette(): string[] {
  return Array.from({ length: HUE_COUNT }, (_, i) => {
    const hue = Math.round((360 / HUE_COUNT) * i);
    // 62 % lightness / 62 % saturation: bright enough to read against the dark
    // theme, muted enough not to shout behind a tab label.
    return hsl(hue, 62, 62);
  });
}

export const PALETTE = buildPalette();
