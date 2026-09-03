/**
 * Compare — one panel for the four modes of the same verb.
 *
 *   - **Schema** — two instances or two schemas, every object type, DDL diff
 *     and a migration script (SchemaComparePanel: session-independent — it
 *     opens its own connections from the saved list, MySQL / PostgreSQL);
 *   - **Data** — the row contents of one table against another, with a
 *     reviewed reconcile script (DataComparePanel);
 *   - **Results** — two result grids side by side, "did my rewrite return the
 *     same rows" (ResultDiffPanel: read-only, nothing to write);
 *   - **Scripts** — two SQL scripts with a live diff (SqlComparePanel) —
 *     never touches the server, so it works on every engine and offline.
 *
 * An honest wrapper, not a merge: the modes take different inputs and produce
 * different results, so each keeps its own implementation and toolbar, and
 * this panel is only the mode switcher above them (the FindPanel scope
 * pattern). The data mode is engine-gated (`dataCompare` in
 * utils/engineCaps); a mode the engine cannot serve is greyed with the reason
 * on hover, never hidden — the menu can offer this panel on every engine
 * because the schema, results and scripts modes always work.
 *
 * The schema mode mounts the same SchemaComparePanel the top bar's Compare
 * icon opens as an App-level utility view — one implementation, two hosts.
 */
import { useEffect, useState } from 'react';
import type { Session } from '../types';
import { can, ENGINE_LABELS } from '../utils/engineCaps';
import type { EngineCaps } from '../utils/engineCaps';
import { SchemaComparePanel } from './SchemaComparePanel';
import { DataComparePanel } from './DataComparePanel';
import { ResultDiffPanel } from './ResultDiffPanel';
import type { ResultRef } from './ResultDiffPanel';
import { SqlComparePanel } from './SqlComparePanel';
import { DbScopeBar } from './DbScopeBar';

export type CompareScope = 'schema' | 'data' | 'results' | 'scripts';

interface ModeDef {
  id: CompareScope;
  label: string;
  tip: string;
  /** Engine capability the mode needs — schema, results and scripts need none. */
  cap?: keyof EngineCaps;
  /** What the mode does, for the greyed tab's "why not" tip. */
  does: string;
}

const MODES: ModeDef[] = [
  {
    id: 'schema', label: 'Schema',
    tip: 'Two instances or two schemas — every object type, DDL diff, migration script '
      + '(compares saved MySQL / PostgreSQL connections, independent of this session)',
    does: '',
  },
  {
    id: 'data', label: 'Data', cap: 'dataCompare',
    tip: 'Row contents of one table against another — with a reviewed reconcile script',
    does: 'enumerates tables and key columns through information_schema and quotes '
      + 'for one dialect — MySQL, PostgreSQL and SQL Server have both',
  },
  {
    id: 'results', label: 'Results',
    tip: 'Two result grids side by side — did my rewrite return the same rows?',
    does: '',
  },
  {
    id: 'scripts', label: 'Scripts',
    tip: 'Two SQL scripts side by side with a live diff — never touches the server',
    does: '',
  },
];

interface Props {
  session: Session;
  /** Every open session, so the data mode can compare across servers. */
  openSessions: Session[];
  schema: string | null;
  /** Every tab that currently holds a result — the results mode's pick list. */
  results: ResultRef[];
  /** In-panel database selector state for the data mode. */
  dbList: string[];
  currentDb: string;
  onChangeDb: (db: string) => void;
  /** Preselected mode, from an opener that knows which compare it wants. */
  scope?: CompareScope;
  onScopeConsumed?: () => void;
  onClose: () => void;
}

export function ComparePanel({ session, openSessions, schema, results, dbList, currentDb, onChangeDb, scope, onScopeConsumed, onClose }: Props) {
  const engineLabel = ENGINE_LABELS[session.engine] ?? session.engine;
  const modeOk = (m: ModeDef) => !m.cap || can(session.engine, m.cap);
  // The default is the first mode — schema always works (it carries its own
  // connection pickers), so every engine has at least three modes to open on.
  const [active, setActive] = useState<CompareScope>(() => {
    const wanted = scope && MODES.find(m => m.id === scope);
    return (wanted && modeOk(wanted) ? wanted : MODES.find(modeOk)!).id;
  });

  // A scope-carrying open ("compare these results") applies to the panel
  // already mounted, exactly like the Find panel's scopes: the mode switch is
  // React's sanctioned adjust-state-during-render, and the consume happens in
  // an effect so the parent's clear never fires during this render. Consumed
  // back to null re-arms the same scope for a later open.
  const [seenScope, setSeenScope] = useState<CompareScope | null>(null);
  if (scope !== seenScope) {
    setSeenScope(scope ?? null);
    const def = scope && MODES.find(m => m.id === scope);
    if (def && modeOk(def)) setActive(def.id);
  }
  useEffect(() => {
    if (scope) onScopeConsumed?.();
  }, [scope, onScopeConsumed]);

  const activeDef = MODES.find(m => m.id === active)!;
  const activeOk = modeOk(activeDef);

  return (
    <div className="proc-panel">
      <div className="mnt-tabs" role="tablist">
        {MODES.map(m => {
          const ok = modeOk(m);
          return (
            <button key={m.id} role="tab" aria-selected={active === m.id}
              className={`mnt-tab${active === m.id ? ' active' : ''}${ok ? '' : ' unavail'}`}
              data-tip={ok ? m.tip : `${m.label} — not available for ${engineLabel}: this mode ${m.does}`}
              onClick={() => { if (ok) setActive(m.id); }}>
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="compare-mode-body">
        {/* Reachable only via a preselected mode this engine cannot serve —
            the tabs themselves refuse the click. */}
        {!activeOk && (
          <div className="db-error">
            {activeDef.label} is not available for {engineLabel} — this mode {activeDef.does}.
            The schema, results and scripts modes work everywhere.
          </div>
        )}
        {activeOk && active === 'schema' && (
          <SchemaComparePanel onClose={onClose} />
        )}
        {activeOk && active === 'data' && (
          <div className="db-scope-wrap">
            <DbScopeBar sessionId={session.sessionId} engine={session.engine}
              dbList={dbList} currentDb={currentDb} onChange={onChangeDb} />
            <DataComparePanel key={currentDb} session={session} openSessions={openSessions}
              schema={schema} onClose={onClose} />
          </div>
        )}
        {activeOk && active === 'results' && (
          <ResultDiffPanel results={results} onClose={onClose} />
        )}
        {activeOk && active === 'scripts' && (
          <SqlComparePanel session={session} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
