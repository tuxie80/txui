/**
 * Local history — the versions of this buffer, and a way back to one.
 *
 * The buffer already survives a restart. What it does not survive is being
 * overwritten: select all, paste, and an hour of work is gone with an undo
 * stack that dies with the tab and no git, because this was never a file.
 *
 * The panel leads with the diff rather than the text, because the question a
 * reader has is not "what was this version" but "is the thing I lost in here".
 *
 * Policy and storage are in utils/bufferHistory; this shows them.
 */
import { useMemo, useState } from 'react';
import { describeVersion, diffLines, diffSummary } from '../utils/bufferHistory';
import type { BufferVersion } from '../utils/bufferHistory';

interface Props {
  versions: BufferVersion[];
  /** The buffer as it is right now — the right-hand side of every diff. */
  current: string;
  onRestore: (text: string) => void;
  onClose: () => void;
}

export function BufferHistory({ versions, current, onRestore, onClose }: Props) {
  // Newest first: the version you want is almost always a recent one.
  const ordered = useMemo(() => [...versions].reverse(), [versions]);
  const [picked, setPicked] = useState(0);
  const [now] = useState(() => Date.now());

  const version = ordered[picked];
  const diff = useMemo(
    () => (version ? diffLines(version.text, current) : []), [version, current]);
  const counts = useMemo(() => diffSummary(diff), [diff]);

  return (
    <aside className="bhist">
      <div className="bhist-head">
        <span className="bhist-title">Local history</span>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {ordered.length === 0 ? (
        <div className="bhist-empty">
          No versions yet. One is kept when you run a statement, when you delete
          a large block, and periodically as you type.
        </div>
      ) : (<>
        <div className="bhist-list">
          {ordered.map((v, i) => (
            <button
              key={v.at + ':' + i}
              className={`bhist-row${i === picked ? ' active' : ''} r-${v.reason}`}
              onClick={() => setPicked(i)}
              title={`${v.text.length} characters`}
            >
              <span className="bhist-when">{describeVersion(v, now)}</span>
              <span className="bhist-size">{v.text.length}</span>
            </button>
          ))}
        </div>

        {version && (
          <div className="bhist-detail">
            <div className="bhist-diff-head">
              <span>
                {counts.removed > 0 && <b className="bhist-del">−{counts.removed}</b>}
                {counts.added > 0 && <b className="bhist-add">+{counts.added}</b>}
                {counts.added === 0 && counts.removed === 0 && 'identical to the buffer'}
              </span>
              <span className="bhist-vs">vs. now</span>
              <div style={{ flex: 1 }} />
              <button
                className="toolbar-btn"
                disabled={version.text === current}
                onClick={() => onRestore(version.text)}
              >Restore</button>
            </div>
            <div className="bhist-diff">
              {diff.map((l, i) => (
                <div key={i} className={`bhist-line k${l.kind === ' ' ? 'same' : l.kind === '+' ? 'add' : 'del'}`}>
                  <span className="bhist-mark">{l.kind}</span>
                  <code>{l.text || ' '}</code>
                </div>
              ))}
            </div>
          </div>
        )}
      </>)}
    </aside>
  );
}
