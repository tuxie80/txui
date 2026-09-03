/**
 * Every keyboard shortcut, in one place.
 *
 * The bindings already exist and are already described one at a time — in
 * button tooltips, in the editor's context menu, in a panel footer. What was
 * missing is the list: the surface you open when you know the app can do a
 * thing and not which keys do it.
 *
 * The labels come from `utils/platform.shortcuts()`, which is the single place
 * that knows whether this machine says ⌘ or Ctrl. Writing them out here would
 * be a second answer to that question, and the portability test forbids it —
 * a hardcoded ⌘ is an instruction a Windows reader cannot carry out.
 */
import { useEffect, useRef } from 'react';
import { shortcuts } from '../utils/platform';

const SC = shortcuts();

/** Grouped the way someone looks for them: by what they were doing at the time. */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Running SQL',
    items: [
      [SC.run, 'Run the statement under the cursor'],
      [SC.runAll, 'Run the whole buffer'],
      [SC.runAllBare, 'Run the whole buffer — timings only, no result tabs'],
      [SC.runToCursor, 'Run everything up to the cursor'],
      [SC.explain, 'EXPLAIN the current statement'],
    ],
  },
  {
    title: 'Editing',
    items: [
      [SC.format, 'Format SQL'],
      [SC.beautify, 'Format, harder (re-indent and re-case)'],
      [SC.expandStar, 'Expand SELECT * into its columns'],
      [SC.wrap, 'Toggle word wrap'],
      [SC.find, 'Find in the editor'],
      [SC.prevStmt, 'Jump to the previous statement'],
      [SC.nextStmt, 'Jump to the next statement'],
      [SC.clickOpen, 'Open the table under the pointer'],
    ],
  },
  {
    title: 'Getting around',
    items: [
      [SC.palette, 'Command palette'],
      [SC.goToTable, 'Go to table…'],
      [SC.newTab, 'New query tab'],
      [SC.closeTab, 'Close tab'],
      [SC.sidebar, 'Show or hide the sidebar'],
      [SC.settings, 'Settings'],
    ],
  },
  {
    title: 'Results',
    items: [
      [SC.copy, 'Copy the selection'],
      [SC.copyHeaders, 'Copy with column headers'],
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal sc-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Keyboard shortcuts</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="sc-body">
          {GROUPS.map(g => (
            <section className="sc-group" key={g.title}>
              <h3 className="sc-group-title">{g.title}</h3>
              <table className="sc-table">
                <tbody>
                  {g.items.map(([keys, what]) => (
                    <tr key={`${g.title}-${keys}-${what}`}>
                      <td className="sc-keys"><kbd>{keys}</kbd></td>
                      <td className="sc-what">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div className="sc-actions">
          <button ref={closeRef} className="toolbar-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
