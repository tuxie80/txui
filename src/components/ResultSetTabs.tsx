import { useMemo, useState } from 'react';
import type { QueryResult } from '../types';
import { resultSetList } from '../utils/resultSets';
import type { FastGridApi } from './FastGrid';
import { ResultGrid } from './ResultGrid';

interface Props {
  result: QueryResult;
  engine?: string;
  apiOutRef?: React.MutableRefObject<FastGridApi | null>;
  sessionId?: string;
  sourceSql?: string;
  onRunDerived?: (sql: string, label: string) => void;
}

export function ResultSetTabs(props: Props) {
  const [activeState, setActiveState] = useState({ result: props.result, index: 0 });
  if (activeState.result !== props.result) {
    setActiveState({ result: props.result, index: 0 });
  }
  const active = activeState.index;
  const sets = useMemo(() => resultSetList(props.result), [props.result]);
  const current = sets[Math.min(active, sets.length - 1)];
  return (
    <>
      {sets.length > 1 && (
        <div className="rtab-bar" aria-label="Result sets">
          {sets.map((set, index) => (
            <button key={index} type="button"
              className={`rtab${index === active ? ' active' : ''}`}
              title={`Result set ${index + 1}: ${set.rows.length.toLocaleString()} rows`}
              onClick={() => setActiveState({ result: props.result, index })}>
              ▦ Result {index + 1}
            </button>
          ))}
        </div>
      )}
      <ResultGrid {...props} result={current} />
    </>
  );
}
