/**
 * Instant, clip-proof tooltips. A single fixed-position element appended to
 * <body>, driven by delegated mouseover/mouseout. Native `title` has a ~1.5s
 * delay and CSS ::after gets clipped by overflow containers (toolbars) — this
 * avoids both.
 *
 * ## It adopts `title` as well as `data-tip`
 *
 * Roughly fifty icon buttons across the app still carried a plain `title`, and
 * every one of them took a second and a half to say what it did — on a
 * toolbar of unlabelled glyphs, which is exactly where the delay costs most.
 * Converting fifty call sites would have fixed those fifty and none of the
 * ones written next week.
 *
 * So an element with a `title` and no `data-tip` is adopted on hover: the
 * attribute is moved out of the DOM (which is the only way to suppress the
 * native tooltip — there is no CSS or API for it), shown instantly here, and
 * **put back on the way out**. Putting it back is not optional: `title` is the
 * accessible name a screen reader reads, and a tooltip that improves the mouse
 * experience by quietly deleting the accessibility of the control would be a
 * bad trade made silently.
 */
let el: HTMLDivElement | null = null;
let current: Element | null = null;

function ensure(): HTMLDivElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 'dbgui-tip';
    // Semi-transparent, not solid black: a translucent slate with a blur reads
    // as an overlay floating over the UI instead of a hard black bar punched
    // through it. Falls back gracefully where backdrop-filter is unsupported.
    el.style.cssText =
      'position:fixed;z-index:9999;pointer-events:none;display:none;' +
      'background:rgba(24,24,32,0.82);color:#eee;border:1px solid rgba(120,120,140,0.35);' +
      'border-radius:5px;padding:3px 7px;font-size:11px;white-space:nowrap;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.35);font-family:-apple-system,sans-serif;' +
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);';
    document.body.appendChild(el);
  }
  return el;
}

/** `title` attributes borrowed from elements we are currently showing. */
const borrowed = new WeakMap<Element, string>();

/** The tip text, adopting `title` when there is no explicit `data-tip`. */
function tipTextOf(target: Element): string | null {
  const explicit = target.getAttribute('data-tip');
  if (explicit) return explicit;
  const native = target.getAttribute('title');
  if (!native) return null;
  // Removing it is the only way to stop the browser drawing its own, slower
  // copy underneath ours. `restoreTitle` puts it back.
  borrowed.set(target, native);
  target.removeAttribute('title');
  return native;
}

function restoreTitle(target: Element | null) {
  if (!target) return;
  const native = borrowed.get(target);
  if (native === undefined) return;
  borrowed.delete(target);
  // Only if nothing else has set one meanwhile — a component that re-rendered
  // with a new title while hovered must win over what we stashed.
  if (!target.hasAttribute('title')) target.setAttribute('title', native);
}

function show(target: Element) {
  // Opted-out subtree (e.g. the connections list): show nothing at all, and
  // also strip the native `title` so the browser does not draw its own — then
  // restore it on the way out, exactly as the adopted case does.
  if (target.closest('[data-notip]')) {
    const native = target.getAttribute('title');
    if (native) {
      borrowed.set(target, native);
      target.removeAttribute('title');
      current = target;
    }
    return;
  }
  const tip = tipTextOf(target);
  if (!tip) return;
  current = target;
  const box = ensure();
  box.textContent = tip;
  /**
   * Short tips stay on one line, as they always have. A long one — or one
   * written as two lines, which is how `platformCaps` says "not here, and
   * here is what to do instead" — wraps inside a sane width instead of
   * stretching a 700-pixel black bar across the window.
   */
  const wrap = tip.includes('\n') || tip.length > 64;
  box.style.whiteSpace = wrap ? 'pre-line' : 'nowrap';
  box.style.maxWidth = wrap ? '340px' : '';
  box.style.display = 'block';
  const r = target.getBoundingClientRect();
  // measure then place below-right, clamped to viewport
  const tw = box.offsetWidth, th = box.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
  if (top + th > window.innerHeight - 4) top = r.top - th - 4;
  box.style.left = `${Math.max(4, left)}px`;
  box.style.top = `${Math.max(4, top)}px`;
}

function hide() {
  restoreTitle(current);
  current = null;
  if (el) el.style.display = 'none';
}

/** Install once at app start. Returns a disposer. */
export function installTooltips(): () => void {
  const SELECTOR = '[data-tip], [title]';
  const over = (e: Event) => {
    const t = (e.target as Element)?.closest?.(SELECTOR);
    if (t && t !== current) {
      // Leaving one tipped element straight into another: the first one's
      // borrowed title has to go back before the second is adopted.
      hide();
      show(t);
    } else if (!t && current) {
      hide();
    }
  };
  const out = (e: MouseEvent) => {
    const to = e.relatedTarget as Element | null;
    if (current && (!to || !to.closest?.(SELECTOR))) hide();
  };
  document.addEventListener('mouseover', over, true);
  document.addEventListener('mouseout', out, true);
  window.addEventListener('scroll', hide, true);
  return () => {
    document.removeEventListener('mouseover', over, true);
    document.removeEventListener('mouseout', out, true);
    window.removeEventListener('scroll', hide, true);
    hide();
  };
}
