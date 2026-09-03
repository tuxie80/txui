/**
 * The changelog, in the app.
 *
 * `CHANGELOG.md` is imported with Vite's `?raw`, so this is the real file
 * rather than a copy kept in sync by hand — a "What's New" that quietly stops
 * matching the release it ships with is worse than no such window.
 *
 * Only the released sections are shown, and `## [Unreleased]` is dropped: it
 * describes work that is not in the binary the reader is holding.
 *
 * The rendering is deliberately small — headings, list items, bold and code.
 * Pulling in a Markdown library to show one bundled document would be a
 * dependency and a bundle-size cost for a window most users open once.
 */
import { useEffect, useMemo, useRef } from 'react';
import changelog from '../../CHANGELOG.md?raw';
import { parseChangelog } from '../utils/changelog';

/** Headings, bullets, bold and code — the four things the changelog uses. */
function renderLine(line: string, key: string) {
  const h = /^(#{3,4})\s+(.*)$/.exec(line);
  if (h) return <h4 className="wn-h" key={key}>{inline(h[2])}</h4>;
  const li = /^\s*[-*]\s+(.*)$/.exec(line);
  if (li) return <li className="wn-li" key={key}>{inline(li[1])}</li>;
  if (!line.trim()) return null;
  if (/^```/.test(line)) return null;
  return <p className="wn-p" key={key}>{inline(line)}</p>;
}

function inline(text: string) {
  // Split on **bold** and `code`, keeping the delimiters so each piece knows
  // what it is. Nested markup is not attempted — the changelog does not use it.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

export function WhatsNewModal({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const releases = useMemo(() => parseChangelog(changelog).slice(0, 12), []);

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wn-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">What&apos;s new</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="wn-body">
          {releases.map(r => (
            <section className="wn-release" key={r.version}>
              <h3 className="wn-version">
                {r.version}
                {r.date && <span className="wn-date">{r.date}</span>}
              </h3>
              <ul className="wn-lines">
                {r.body.map((l, i) => renderLine(l, `${r.version}-${i}`))}
              </ul>
            </section>
          ))}
        </div>
        <div className="wn-actions">
          <button ref={closeRef} className="toolbar-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
