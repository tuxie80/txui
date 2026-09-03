/**
 * Instant tooltips, including the ones written as `title` (src/utils/tooltip.ts).
 *
 * Around fifty icon buttons carried a plain `title`, so each took the
 * browser's ~1.5 s to say what it did — on toolbars of unlabelled glyphs,
 * which is exactly where that delay costs most. Rather than convert fifty call
 * sites (fixing those fifty and none written later), the tooltip layer adopts
 * `title` on hover.
 *
 * The rule that makes it a fair trade, and the one these tests exist for:
 * **the attribute goes back**. `title` is the accessible name; improving the
 * mouse experience by quietly deleting it would be a bad bargain struck in
 * silence.
 *
 * Driven with a minimal DOM stub — the module only ever touches
 * getAttribute/setAttribute/removeAttribute, closest and a couple of listeners,
 * so a fake is more honest here than a headless browser would be informative.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Just enough Element for the module under test. */
class FakeEl {
  attrs = new Map<string, string>();
  parent: FakeEl | null = null;
  style: Record<string, string> = {};
  className = '';
  offsetWidth = 80;
  offsetHeight = 20;
  textContent = '';
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  hasAttribute(n: string) { return this.attrs.has(n); }
  getBoundingClientRect() { return { left: 10, top: 10, bottom: 30, right: 90 }; }
  appendChild() { /* body.appendChild(tipEl) */ }
  closest(sel: string): FakeEl | null {
    const wants = sel.split(',').map(s => s.trim().replace(/^\[|\]$/g, ''));
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: FakeEl | null = this;
    while (node) {
      if (wants.some(w => node!.attrs.has(w))) return node;
      node = node.parent;
    }
    return null;
  }
}

type Handler = (e: unknown) => void;

/**
 * The module caches its tip element across calls (one node appended to
 * <body>, by design), so this is shared rather than per-harness — otherwise
 * every test after the first would look at a null it never created.
 */
let created: FakeEl | null = null;

function withDom(run: (api: {
  fire: (type: string, target: FakeEl, related?: FakeEl | null) => void;
  tipEl: () => FakeEl | null;
}) => void) {
  const listeners = new Map<string, Handler[]>();

  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, window: g.window };

  g.document = {
    createElement: () => { created = new FakeEl(); return created; },
    body: new FakeEl(),
    addEventListener: (t: string, h: Handler) => {
      listeners.set(t, [...(listeners.get(t) ?? []), h]);
    },
    removeEventListener: () => {},
  };
  g.window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener: () => {}, removeEventListener: () => {},
  };

  try {
    run({
      fire: (type, target, related = null) => {
        for (const h of listeners.get(type) ?? []) h({ target, relatedTarget: related });
      },
      tipEl: () => created,
    });
  } finally {
    g.document = saved.document;
    g.window = saved.window;
  }
}

const { installTooltips } = await import('../src/utils/tooltip.ts');

// ── data-tip, as before ─────────────────────────────────────────────────────

test('an element with data-tip shows it immediately', () => {
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('data-tip', 'Processes');
    fire('mouseover', el);
    assert.equal(tipEl()!.textContent, 'Processes');
    assert.equal(tipEl()!.style.display, 'block');
  });
});

// ── title, adopted ──────────────────────────────────────────────────────────

test('a plain title is shown instantly instead of after a second and a half', () => {
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('title', 'Local history');
    fire('mouseover', el);
    assert.equal(tipEl()!.textContent, 'Local history');
  });
});

test('the native title is removed while shown — the only way to suppress the browser copy', () => {
  withDom(({ fire }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('title', 'Local history');
    fire('mouseover', el);
    assert.equal(el.hasAttribute('title'), false);
  });
});

test('and it is put back on the way out, because it is the accessible name', () => {
  withDom(({ fire }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('title', 'Local history');
    fire('mouseover', el);
    fire('mouseout', el, null);
    assert.equal(el.getAttribute('title'), 'Local history');
  });
});

test('moving straight from one tipped icon to the next restores the first', () => {
  // The case a naive implementation loses: no mouseout to nothing, just a
  // mouseover on the neighbour — and the first button silently ends up with no
  // accessible name for the rest of the session.
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const a = new FakeEl();
    const b = new FakeEl();
    a.setAttribute('title', 'Copy');
    b.setAttribute('title', 'Export');
    fire('mouseover', a);
    fire('mouseover', b);
    assert.equal(a.getAttribute('title'), 'Copy', 'the one we left must have its title back');
    assert.equal(b.hasAttribute('title'), false);
    assert.equal(tipEl()!.textContent, 'Export');
  });
});

test('data-tip wins over title, and the title is left alone', () => {
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('data-tip', 'Kill — needs the PROCESS privilege');
    el.setAttribute('title', 'Kill');
    fire('mouseover', el);
    assert.equal(tipEl()!.textContent, 'Kill — needs the PROCESS privilege');
    assert.equal(el.getAttribute('title'), 'Kill', 'nothing was borrowed, so nothing was taken');
  });
});

test('a re-render that sets a new title while hovered is not overwritten', () => {
  withDom(({ fire }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('title', 'Pause');
    fire('mouseover', el);
    el.setAttribute('title', 'Resume');   // the component re-rendered
    fire('mouseout', el, null);
    assert.equal(el.getAttribute('title'), 'Resume', 'the newer value wins over the stashed one');
  });
});

test('an element with neither attribute shows nothing', () => {
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const before = tipEl()?.textContent;
    fire('mouseover', new FakeEl());
    // Nothing shown, and nothing changed: the previous tip is hidden, not
    // replaced with an empty box.
    assert.equal(tipEl()?.textContent, before);
    assert.equal(tipEl()?.style.display, 'none');
  });
});

// ── wrapping ────────────────────────────────────────────────────────────────

test('a long or two-line tip wraps instead of stretching across the window', () => {
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('data-tip',
      'Unix socket connection — not available on Windows: the OS has no Unix domain sockets.\nConnect over host/port.');
    fire('mouseover', el);
    assert.equal(tipEl()!.style.whiteSpace, 'pre-line');
    assert.equal(tipEl()!.style.maxWidth, '340px');
  });
});

test('a short tip stays on one line', () => {
  withDom(({ fire, tipEl }) => {
    installTooltips();
    const el = new FakeEl();
    el.setAttribute('data-tip', 'Copy');
    fire('mouseover', el);
    assert.equal(tipEl()!.style.whiteSpace, 'nowrap');
  });
});
