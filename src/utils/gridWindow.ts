/**
 * Pure window math for FastGrid's vertical virtualization (extracted so it
 * stays testable under `node --test` — see tests/gridWindow.test.ts).
 *
 * Overscan scales with the UNCOMMITTED scroll gap (how far scrollTop has moved
 * since the last committed render): that gap is exactly what the buffer must
 * cover until the next commit lands, and with commits coalesced to one per
 * frame it is the per-frame scroll delta — a scrollbar flick can move several
 * viewports in one frame. Buffer = gap + 1 viewport, capped at maxOverscanVp
 * viewports per side: every mounted row is remounted on a jump (keys are
 * absolute row indexes), so the cap is what keeps a violent flick's commit
 * inside the frame budget instead of mounting dozens of viewports of rows and
 * starving the main thread — which is itself a blanking cause (the compositor
 * scrolls ahead of a busy main thread and paints background).
 */

export interface GridWindowOpts {
  scrollTop: number;
  /** px scrolled since the last committed render (drives overscan) */
  jumpPx: number;
  viewH: number;
  rowH: number;
  headerH: number;
  nRows: number;
  /** row-overscan floor, applied even at rest */
  overscanFloor: number;
  /** overscan cap, in viewports per side */
  maxOverscanVp: number;
}

export interface GridWindow {
  /** scrollTop clamped into the valid range */
  effTop: number;
  overscanRows: number;
  rowStart: number;
  rowEnd: number; // exclusive
}

export function gridWindow(o: GridWindowOpts): GridWindow {
  const vpRows = Math.ceil(o.viewH / o.rowH);
  const overscanRows = Math.max(
    o.overscanFloor,
    Math.min(vpRows * o.maxOverscanVp, Math.ceil(o.jumpPx / o.rowH) + vpRows),
  );
  // Clamp the scroll position into the valid range before computing the
  // window: when the row set shrinks (filter applied, first page reloaded)
  // while scrolled far down, a stale scrollTop can exceed the new content
  // height until the browser's clamped scroll event lands — an unclamped calc
  // yields rowStart ≥ rowEnd and paints a FULLY blank grid. This also
  // guarantees the window is never empty while nRows > 0.
  const totalH = o.headerH + o.nRows * o.rowH;
  const effTop = Math.min(o.scrollTop, Math.max(0, totalH - o.viewH));
  const rowStart = Math.max(0, Math.floor((effTop - o.headerH) / o.rowH) - overscanRows);
  const rowEnd = Math.min(o.nRows, Math.ceil((effTop + o.viewH - o.headerH) / o.rowH) + overscanRows);
  return { effTop, overscanRows, rowStart, rowEnd };
}
