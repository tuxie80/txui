/** Cached canvas text measurement for column auto-sizing. */
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

export function measureText(text: string, font: string): number {
  if (!ctx) {
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    if (!ctx) return text.length * 8; // canvas unavailable — rough fallback
  }
  if (ctx.font !== font) ctx.font = font;
  return ctx.measureText(text).width;
}
