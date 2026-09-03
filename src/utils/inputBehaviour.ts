/**
 * App-wide text-input policy: **no automatic filling of any kind.**
 *
 * A database client is the worst possible place for a guess. Browser autofill,
 * WebKit autocorrect, macOS text substitution and password-manager overlays all
 * rewrite what you typed — a silently "corrected" hostname, table name or
 * password is a real error, and the app has ~150 text boxes for it to happen in.
 *
 * Rather than annotate every `<input>` (and hope nobody forgets on the next
 * one), this stamps the suppressing attributes on every text field in the
 * document — those present at startup and everything React mounts later.
 *
 * What it does NOT touch: the SQL editor's own completion. That is the app
 * deliberately offering schema-aware SQL hints, not the OS guessing at prose.
 * Native spellcheck squiggles under SQL *are* switched off, because those come
 * from the dictionary, not from us.
 */

/** Elements whose text the user types into. */
type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * `<input>` types that carry free text. Checkbox / radio / button / color /
 * range have nothing to autofill and are skipped.
 */
const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time',
  'datetime-local', 'month', 'week',
]);

/** Marks an element as already handled, so re-scans stay cheap. */
const STAMPED = 'data-no-autofill';

function isTextField(el: Element): el is TextField {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return TEXT_INPUT_TYPES.has(el.type.toLowerCase());
}

function stamp(el: TextField): void {
  if (el.hasAttribute(STAMPED)) return;
  el.setAttribute(STAMPED, '');

  // The standard one. WebKit honours "off" on non-credential fields.
  el.setAttribute('autocomplete', 'off');
  // WebKit-specific, and the ones that actually cause silent rewrites:
  // autocorrect is macOS text substitution, autocapitalize uppercases the
  // first letter — both are catastrophic in a case-sensitive identifier.
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  el.spellcheck = false;
  // Password managers ignore `autocomplete` and inject their own overlay;
  // each of these is that vendor's documented opt-out.
  el.setAttribute('data-1p-ignore', '');        // 1Password
  el.setAttribute('data-lpignore', 'true');     // LastPass
  el.setAttribute('data-bwignore', '');         // Bitwarden
  el.setAttribute('data-form-type', 'other');   // Dashlane, 1Password heuristics
}

function scan(root: ParentNode): void {
  if (root instanceof Element) {
    if (isTextField(root)) { stamp(root); return; }
    // Leaf element — nothing can be nested inside it. Worth the check: the SQL
    // editor rewrites its line elements on every keystroke, and each one would
    // otherwise cost a querySelectorAll that can only ever return nothing.
    if (!root.firstElementChild) return;
  }
  for (const el of root.querySelectorAll('input, textarea')) {
    if (isTextField(el)) stamp(el);
  }
  // A <form> lets the browser autofill a whole group at once.
  for (const f of root.querySelectorAll('form')) f.setAttribute('autocomplete', 'off');
}

/**
 * Number boxes hold one short value that is always replaced wholesale, so
 * landing the caret mid-number just means deleting digits first. Selecting on
 * focus makes the first keystroke replace the value.
 *
 * Text boxes are deliberately excluded: there, mid-value editing is normal.
 */
function selectNumberOnFocus(e: FocusEvent): void {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.type === 'number' && !el.readOnly) {
    // After focus settles, or WebKit collapses the selection again.
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.select();
    });
  }
}

/**
 * Install the policy. Idempotent; call once at startup.
 * Returns a teardown for tests.
 */
export function installInputBehaviour(doc: Document = document): () => void {
  // These three inherit, so setting them at the root also covers CodeMirror's
  // contenteditable and anything else that is not an <input>.
  const root = doc.documentElement;
  root.setAttribute('spellcheck', 'false');
  root.setAttribute('autocorrect', 'off');
  root.setAttribute('autocapitalize', 'off');

  scan(doc);

  // React mounts most of the app after this runs, and panels mount later
  // still — so watch rather than scan once.
  const observer = new MutationObserver(records => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node as Element);
      }
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  doc.addEventListener('focusin', selectNumberOnFocus);

  return () => {
    observer.disconnect();
    doc.removeEventListener('focusin', selectNumberOnFocus);
  };
}

/** Exported for tests: the attributes a field of this type must end up with. */
export function suppressionAttrs(): Record<string, string> {
  return {
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    'data-bwignore': '',
    'data-form-type': 'other',
  };
}

/** Exported for tests: does this element type get stamped? */
export function isTextFieldType(tag: 'input' | 'textarea', type = ''): boolean {
  if (tag === 'textarea') return true;
  return TEXT_INPUT_TYPES.has(type.toLowerCase());
}
