/**
 * Result diff — compare the rows of one result grid against another.
 *
 * The plan diff answers "did my rewrite get faster"; it cannot answer "did my
 * rewrite return the same rows", because a faster plan can quietly return
 * different output. This is that missing half. It is deliberately read-only:
 * unlike data compare there is no target to write, so there is no reconcile
 * script, no confirmation word and no danger — just an answer.
 *
 * The comparison is `utils/resultDiff.ts`, which aligns the two column lists
 * and then hands off to the same `compareRows` engine data compare uses.
 */
import { useMemo, useState } from 'react';
import { diffResults, sharedColumns, type ResultLike } from '../utils/resultDiff';
import type { CompareResult } from '../utils/dataCompare';

export interface ResultRef { id: number; label: string; result: ResultLike }

interface Props {
  /** Every open tab that holds a result, newest-relevant first. */
  results: ResultRef[];
  onClose: () => void;
}

export function ResultDiffPanel({ results, onClose }: Props) {
  const [aId, setAId] = useState<number | null>(results[0]?.id ?? null);
  const [bId, setBId] = useState<number | null>(results[1]?.id ?? results[0]?.id ?? null);
  const a = results.find(r => r.id === aId) ?? null;
  const b = results.find(r => r.id === bId) ?? null;

  const [diff, setDiff] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shared = useMemo(
    () => (a && b ? sharedColumns(a.result, b.result) : []), [a, b]);

  // The key defaults to every shared column — a plain set difference, which is
  // the right answer to "did the output change?". Narrowing it to a real key
  // turns matched-but-changed rows into per-column differences instead. Reset
  // whenever the shared column list changes so the key is never stale.
  const sharedSig = shared.join('');
  const [keyCols, setKeyCols] = useState<string[]>(shared);
  // Adjust state during render rather than in an effect: when the pair (and so
  // the shared column list) changes, reset the key to every shared column and
  // drop any stale diff. React recommends this over a setState-in-effect, and
  // nothing here is impure.
  const [prevSig, setPrevSig] = useState(sharedSig);
  if (prevSig !== sharedSig) {
    setPrevSig(sharedSig);
    setKeyCols(shared);
    setDiff(null);
  }

  const compare = () => {
    if (!a || !b || !keyCols.length) return;
    try {
      setError(null);
      setDiff(diffResults(a.result, b.result, keyCols, shared));
    } catch (e) {
      setDiff(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sideSelect = (value: number | null, set: (v: number) => void, role: 'A' | 'B') => (
    <label className="dg-field-inline">
      <span>{role === 'A' ? 'Result A' : 'Result B'}</span>
      <select value={value ?? ''} onChange={e => set(Number(e.target.value))}>
        {results.map(r => (
          <option key={r.id} value={r.id}>
            {r.label} · {r.result.rows.length.toLocaleString()} rows
          </option>
        ))}
      </select>
    </label>
  );

  const identical = diff
    && !diff.different.length && !diff.onlyInSource.length && !diff.onlyInTarget.length;

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">≟ Result diff</span>
        <button className="toolbar-btn" disabled={!a || !b || !keyCols.length}
          onClick={compare}>Compare</button>
        <span className="dv-desc" style={{ marginLeft: 8 }}>
          {diff && `${diff.same} same · ${diff.different.length} differ · `
            + `${diff.onlyInSource.length} only in A · ${diff.onlyInTarget.length} only in B`}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {results.length < 2 && (
        <div className="proc-error-bar">
          Result diff needs two results open. Run a query in two tabs, then compare them here.
        </div>
      )}
      {error && <div className="proc-error-bar">{error}</div>}

      <div className="dc-sides">
        <div className="dc-side">{sideSelect(aId, setAId, 'A')}</div>
        <div className="dc-arrow" title="Neither side is written — this only reports">≟</div>
        <div className="dc-side">{sideSelect(bId, setBId, 'B')}</div>
      </div>

      {a && b && shared.length === 0 && (
        <div className="proc-error-bar">
          These two results share no column names, so there is nothing to line up. Alias the
          columns the same way in both queries.
        </div>
      )}

      {shared.length > 0 && (
        <div className="dc-keys">
          <span className="dc-keys-label">Match rows by</span>
          {shared.map(c => (
            <label key={c} className="form-check">
              <input type="checkbox" checked={keyCols.includes(c)}
                onChange={e => setKeyCols(k => e.target.checked ? [...k, c] : k.filter(x => x !== c))} />
              {c}
            </label>
          ))}
          {!keyCols.length && (
            <span className="dc-warn">
              Pick at least one — without a key there is no way to say which row is which.
            </span>
          )}
        </div>
      )}

      {diff && (
        <div className="dc-result">
          {diff.duplicateKeys.length > 0 && (
            <div className="td-headline td-risk-lossy">
              {diff.duplicateKeys.length} key value{diff.duplicateKeys.length === 1 ? '' : 's'} appear
              more than once on a side — with a non-unique key the diff counts only the first of each,
              so add columns to the key until it is unique.
            </div>
          )}

          {identical ? (
            <div className="td-headline">The two results are identical over their shared columns.</div>
          ) : (
            <div className="dc-script">
              {diff.different.slice(0, 300).map((d, i) => (
                <code key={`d${i}`} className="td-sql">
                  ~ [{d.key.join(', ')}] differ in: {d.changed.join(', ')}
                </code>
              ))}
              {diff.onlyInSource.slice(0, 300).map((d, i) => (
                <code key={`s${i}`} className="td-sql">− only in A: [{d.key.join(', ')}]</code>
              ))}
              {diff.onlyInTarget.slice(0, 300).map((d, i) => (
                <code key={`t${i}`} className="td-sql">+ only in B: [{d.key.join(', ')}]</code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
