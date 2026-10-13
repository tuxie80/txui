// Minimal DOM for driving React components under plain Node — no jsdom, no
// new dependencies. Two consumers:
//
//   1. renderToString smoke (tier 'ssr') — components read localStorage and
//      window at render/module level; effects never run, so this tier only
//      needs the storage/event/matchMedia surface.
//   2. react-dom/client mount (tier 'mount') — a fake element tree good
//      enough for React 19 to commit into, so useEffect bodies (invoke calls,
//      canvas drawing, ResizeObserver wiring) actually execute.
//
// This is a render-smoke shim, not a DOM: it exists so a component that
// throws on render or in an effect fails a test instead of a user's screen.

class FakeStorage {
  #map = new Map();
  getItem(k) { const v = this.#map.get(String(k)); return v === undefined ? null : v; }
  setItem(k, v) { this.#map.set(String(k), String(v)); }
  removeItem(k) { this.#map.delete(String(k)); }
  clear() { this.#map.clear(); }
  key(i) { return [...this.#map.keys()][i] ?? null; }
  get length() { return this.#map.size; }
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * EventTarget does not propagate events along a DOM tree — the DOM does.
 * React 19 attaches one delegated listener per event type at the root
 * container, so a click dispatched on a button must bubble up the ancestor
 * chain or no onClick ever fires. These three methods replace EventTarget's
 * with a minimal capture/target/bubble flow over parentNode.
 */
function ownListeners(node) {
  return (node.__listeners ??= new Map());
}

function addListener(node, type, cb, opts) {
  const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
  let set = ownListeners(node).get(type);
  if (!set) ownListeners(node).set(type, set = []);
  set.push({ cb, capture });
}

function removeListener(node, type, cb, opts) {
  const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
  const set = ownListeners(node).get(type);
  if (!set) return;
  const i = set.findIndex(l => l.cb === cb && l.capture === capture);
  if (i >= 0) set.splice(i, 1);
}

function dispatchWithPropagation(origin, event) {
  const path = [];
  let n = origin;
  while (n) { path.push(n); n = n.parentNode; }
  const doc = origin.nodeType === 9 ? origin : origin.ownerDocument;
  if (doc && !path.includes(doc)) path.push(doc);
  const win = origin.nodeType === 0 ? origin : doc?.defaultView;
  if (win && !path.includes(win)) path.push(win);

  let stopped = false;
  let immediate = false;
  const proxyFor = currentTarget => new Proxy(event, {
    get(t, prop) {
      if (prop === 'target' || prop === 'srcElement') return origin;
      if (prop === 'currentTarget') return currentTarget;
      if (prop === 'eventPhase') return currentTarget === origin ? 2 : (path.indexOf(currentTarget) > 0 ? 3 : 1);
      if (prop === 'stopPropagation') return () => { stopped = true; };
      if (prop === 'stopImmediatePropagation') return () => { stopped = true; immediate = true; };
      if (prop === 'preventDefault') return () => {};
      if (prop === 'composedPath') return () => [...path];
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

  const fire = (node, capturePhase) => {
    const set = ownListeners(node).get(event.type);
    if (!set) return;
    const proxy = proxyFor(node);
    for (const { cb, capture } of [...set]) {
      if (capture === capturePhase || node === origin) {
        try { cb(proxy); } catch (e) { queueMicrotask(() => { throw e; }); }
        if (immediate) break;
      }
    }
  };

  for (let i = path.length - 1; i > 0 && !stopped; i--) fire(path[i], true);
  if (!stopped) fire(origin, false);
  if (event.bubbles) {
    for (let i = 1; i < path.length && !stopped; i++) fire(path[i], false);
  }
  return !stopped;
}

class FakeNode extends EventTarget {
  constructor(ownerDocument, nodeType, nodeName) {
    super();
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.childNodes = [];
    this.parentNode = null;
  }
  addEventListener(type, cb, opts) { addListener(this, type, cb, opts); }
  removeEventListener(type, cb, opts) { removeListener(this, type, cb, opts); }
  dispatchEvent(event) { return dispatchWithPropagation(this, event); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    return sibs[sibs.indexOf(this) - 1] ?? null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child, ref) {
    if (ref == null) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('insertBefore: reference node not found');
    this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: node not found');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(next, old) {
    this.insertBefore(next, old);
    this.removeChild(old);
    return old;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  cloneNode(deep = false) {
    const c = new FakeNode(this.ownerDocument, this.nodeType, this.nodeName);
    if (deep) for (const ch of this.childNodes) c.appendChild(ch.cloneNode(true));
    return c;
  }
  get textContent() {
    return this.childNodes.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    const s = String(v);
    if (s !== '') this.appendChild(this.ownerDocument.createTextNode(s));
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc, 3, '#text');
    this.data = String(data);
  }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get length() { return this.data.length; }
  splitText(offset) {
    const rest = this.data.slice(offset);
    this.data = this.data.slice(0, offset);
    const node = this.ownerDocument.createTextNode(rest);
    this.parentNode?.insertBefore(node, this.nextSibling);
    return node;
  }
  cloneNode() { return new FakeText(this.ownerDocument, this.data); }
}

class FakeComment extends FakeNode {
  constructor(doc, data) {
    super(doc, 8, '#comment');
    this.data = String(data);
  }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new FakeComment(this.ownerDocument, this.data); }
}

/** A 2d context that accepts every call and every assignment. Drawing code
 *  runs for real against it — a throw inside a component's paint path still
 *  fails the test; only the raster itself is imaginary. */
function make2dContext(canvas) {
  const state = { canvas };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 42 });
      if (prop === 'getImageData') {
        return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h });
      }
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'getLineDash') return () => [];
      if (prop === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      // Anything else: a no-op method. Property reads after writes hit the
      // `prop in target` branch above; reading an unset style property is not
      // something the paint paths do.
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

class FakeElement extends FakeNode {
  constructor(doc, tagName, namespaceURI = XHTML_NS) {
    super(doc, 1, tagName.toUpperCase());
    this.namespaceURI = namespaceURI;
    this.localName = tagName.toLowerCase();
    this.attributes = new Map();
    this.style = {
      setProperty(k, v) { this[k] = v; },
      getPropertyValue() { return ''; },
      removeProperty(k) { delete this[k]; },
      cssText: '',
    };
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.files = [];
    this.scrollTop = 0;
    this.scrollLeft = 0;
  }
  get tagName() { return this.nodeName; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get options() { return this.childNodes.filter(n => n.nodeName === 'OPTION'); }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(v) { this.attributes.set('class', String(v)); }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  hasAttribute(name) { return this.attributes.has(String(name)); }
  setAttributeNS(ns, name, value) { this.setAttribute(name, value); }
  getAttributeNS(ns, name) { return this.getAttribute(name); }
  removeAttributeNS(ns, name) { this.removeAttribute(name); }
  toggleAttribute(name, force) {
    const has = this.hasAttribute(name);
    const want = force === undefined ? !has : !!force;
    if (want) this.setAttribute(name, ''); else this.removeAttribute(name);
    return want;
  }
  get classList() {
    const el = this;
    const read = () => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    return {
      add(...cs) { el.setAttribute('class', [...new Set([...read(), ...cs])].join(' ')); },
      remove(...cs) { el.setAttribute('class', read().filter(c => !cs.includes(c)).join(' ')); },
      contains(c) { return read().includes(c); },
      toggle(c, force) {
        const has = read().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want) this.add(c); else this.remove(c);
        return want;
      },
    };
  }
  get innerHTML() { return ''; }
  set innerHTML(_v) { this.childNodes = []; }
  get outerHTML() { return `<${this.localName}>`; }
  get clientWidth() { return 800; }
  get clientHeight() { return 480; }
  get offsetWidth() { return 800; }
  get offsetHeight() { return 480; }
  get scrollWidth() { return 800; }
  get scrollHeight() { return 480; }
  get offsetTop() { return 0; }
  get offsetLeft() { return 0; }
  get offsetParent() { return null; }
  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480 };
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  getElementsByClassName() { return []; }
  closest() { return null; }
  matches() { return false; }
  focus() {}
  blur() {}
  click() { this.dispatchEvent(new Event('click')); }
  scrollIntoView() {}
  scrollTo() {}
  select() {}
  setSelectionRange() {}
  insertAdjacentElement(_pos, el) { this.appendChild(el); return el; }
  insertAdjacentHTML() {}
  attachShadow() { return new FakeElement(this.ownerDocument, 'shadow-root'); }
  getRootNode() { return this.isConnected ? this.ownerDocument : this; }
  // Canvas — every element answers getContext; only <canvas> is ever asked.
  getContext(kind) {
    if (kind === '2d') return (this.__ctx ??= make2dContext(this));
    return null;
  }
  toDataURL() { return 'data:image/png;base64,'; }
  toBlob(cb) { cb(new Blob([])); }
  requestPointerLock() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  cloneNode(deep = false) {
    const c = new FakeElement(this.ownerDocument, this.localName, this.namespaceURI);
    for (const [k, v] of this.attributes) c.setAttribute(k, v);
    if (deep) for (const ch of this.childNodes) c.appendChild(ch.cloneNode(true));
    return c;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9, '#document');
    this.ownerDocument = this;
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = null;
    this.visibilityState = 'visible';
    this.hidden = false;
    this.readyState = 'complete';
    this.characterSet = 'UTF-8';
    this.contentType = 'text/html';
    this.defaultView = null; // set by installDomShim
    this.compatMode = 'CSS1Compat';
    this.fonts = { add() {}, delete() {}, forEach() {}, ready: Promise.resolve(this) };
  }
  // CodeMirror's DOMObserver asks the document for the selection.
  getSelection() {
    return {
      rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
      isCollapsed: true, type: 'None',
      addRange() {}, removeRange() {}, removeAllRanges() {}, collapse() {}, extend() {},
      getRangeAt: () => this.createRange(),
      containsNode: () => false,
      toString: () => '',
    };
  }
  createElement(tag) { return new FakeElement(this, String(tag)); }
  createElementNS(ns, tag) { return new FakeElement(this, String(tag), ns); }
  createTextNode(data) { return new FakeText(this, data); }
  createComment(data) { return new FakeComment(this, data); }
  createDocumentFragment() {
    const f = new FakeNode(this, 11, '#document-fragment');
    f.getRootNode = () => f;
    return f;
  }
  createRange() {
    return {
      setStart() {}, setEnd() {}, collapse() {}, selectNodeContents() {},
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      getClientRects: () => [],
      cloneRange() { return this; },
      commonAncestorContainer: this.body,
    };
  }
  getElementById() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  getElementsByClassName() { return []; }
  elementFromPoint() { return null; }
  adoptNode(n) { return n; }
  importNode(n, deep = false) { return n.cloneNode(deep); }
  hasFocus() { return true; }
  execCommand() { return false; }
}

class FakeImage {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.width = 0;
    this.height = 0;
    this.crossOrigin = null;
    this.onload = null;
    this.onerror = null;
  }
  set src(_v) { /* never loads under Node — tile cache simply stays empty */ }
  get src() { return ''; }
  decode() { return Promise.resolve(); }
}

class FakeResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe(target) {
    // Fire once, asynchronously, like the real thing does after layout — a
    // ResizeObserver that never fires would leave sized-to-zero components
    // on their fallback path, which is exactly the path nobody has clicked.
    queueMicrotask(() => this.cb([{ target, contentRect: { width: 800, height: 480 } }], this));
  }
  unobserve() {}
  disconnect() {}
}

class FakeMutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

class FakeIntersectionObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

class FakeWindow extends FakeNode {
  constructor() { super(null, 0, '#window'); }
}

export function installDomShim() {
  const g = globalThis;
  if (g.__TXUI_DOM_SHIM__) return g.__TXUI_DOM_SHIM__;

  // Async errors from timer/rAF callbacks: recorded, not thrown — an uncaught
  // throw in a Timeout would kill the whole sweep. run.mjs attributes them to
  // the target under test.
  const asyncErrors = [];
  const guard = fn => (...a) => {
    try { return fn(...a); } catch (e) { asyncErrors.push(e); }
  };

  const document = new FakeDocument();
  const localStorage = new FakeStorage();
  const sessionStorage = new FakeStorage();

  const matchMedia = query => ({
    matches: false, media: String(query),
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    onchange: null, dispatchEvent: () => false,
  });

  const getComputedStyle = () => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'getPropertyValue') return () => '';
      if (prop === 'length') return 0;
      return '';
    },
  });

  // The window is a FakeWindow (FakeNode with nodeType 0): it shares the
  // event registry so component window.addEventListener('dbgui:*') handlers
  // and React's delegated listeners both work, it is the end of every bubble
  // path, and `x instanceof Window` (CodeMirror's DOM observer) answers true.
  const window = new FakeWindow();
  Object.assign(window, {
    document,
    localStorage,
    sessionStorage,
    matchMedia,
    getComputedStyle,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    outerHeight: 800,
    pageXOffset: 0,
    pageYOffset: 0,
    scrollX: 0,
    scrollY: 0,
    screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 800 },
    location: {
      href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:',
      host: 'localhost', hostname: 'localhost', port: '', pathname: '/',
      search: '', hash: '', reload() {}, assign() {}, replace() {},
    },
    navigator: {
      userAgent: 'txui-render-smoke',
      platform: 'MacIntel',
      language: 'en-US',
      languages: ['en-US'],
      maxTouchPoints: 0,
      clipboard: { writeText: async () => {}, readText: async () => '' },
    },
    setTimeout: (fn, ms, ...a) => globalThis.setTimeout(guard(fn), ms, ...a),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: (fn, ms, ...a) => globalThis.setInterval(guard(fn), ms, ...a),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
    requestAnimationFrame: cb => globalThis.setTimeout(guard(() => cb(Date.now())), 16),
    cancelAnimationFrame: id => globalThis.clearTimeout(id),
    requestIdleCallback: cb => globalThis.setTimeout(guard(() => cb({ didTimeout: false, timeRemaining: () => 50 })), 0),
    cancelIdleCallback: id => globalThis.clearTimeout(id),
    fetch: (...a) => globalThis.fetch(...a),
    scrollTo() {},
    scrollBy() {},
    open() { return null; },
    close() {},
    focus() {},
    blur() {},
    print() {},
    getSelection() { return document.getSelection(); },
    prompt: () => null,
    confirm: () => true,
    alert() {},
    Event, CustomEvent, KeyboardEvent: class extends Event {}, MouseEvent: class extends Event {},
    ResizeObserver: FakeResizeObserver,
    MutationObserver: FakeMutationObserver,
    IntersectionObserver: FakeIntersectionObserver,
    Image: FakeImage,
    Node: FakeNode,
    HTMLElement: FakeElement,
    HTMLCanvasElement: FakeElement,
    HTMLImageElement: FakeImage,
    HTMLIFrameElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLSelectElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLButtonElement: FakeElement,
    SVGElement: FakeElement,
    Element: FakeElement,
    DocumentFragment: FakeNode,
    Window: FakeWindow,
  });
  document.defaultView = window;

  const defs = {
    window,
    document,
    localStorage,
    sessionStorage,
    matchMedia,
    getComputedStyle,
    ResizeObserver: FakeResizeObserver,
    MutationObserver: FakeMutationObserver,
    IntersectionObserver: FakeIntersectionObserver,
    Image: FakeImage,
    HTMLElement: FakeElement,
    HTMLCanvasElement: FakeElement,
    Window: FakeWindow,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    requestIdleCallback: window.requestIdleCallback,
    cancelIdleCallback: window.cancelIdleCallback,
  };
  for (const [k, v] of Object.entries(defs)) {
    try { Object.defineProperty(g, k, { value: v, writable: true, configurable: true }); }
    catch { g[k] = v; }
  }
  // navigator exists in Node ≥ 21 as a getter-only global; override so
  // navigator.clipboard and a browser-flavoured userAgent exist.
  try {
    Object.defineProperty(g, 'navigator', { value: window.navigator, writable: true, configurable: true });
  } catch { /* read-only host — components tolerate it */ }

  // The import.meta.glob rewrite target (see bundle.mjs).
  g.__rsGlob ??= () => ({});

  g.__TXUI_DOM_SHIM__ = { window, document, localStorage, sessionStorage, asyncErrors };
  return g.__TXUI_DOM_SHIM__;
}

/** Fresh storage between tests without rebuilding the world. */
export function resetDomState() {
  const shim = installDomShim();
  shim.localStorage.clear();
  shim.sessionStorage.clear();
  return shim;
}
