/**
 * Find — one panel for the three scopes of the same verb.
 *
 *   - **Usages** — what server-side objects reference this table or column
 *     (FindUsagesPanel: catalog reads only, safe against production);
 *   - **In database** — search every table in a schema for a value
 *     (DbSearchPanel: streaming, says what it skipped);
 *   - **In files** — search a folder of .sql scripts (FindInFilesPanel) —
 *     never touches the server, so it works on every engine and offline.
 *
 * An honest wrapper, not a merge: the scopes take different inputs and produce
 * different results, so each keeps its own implementation and toolbar, and
 * this panel is only the scope switcher above them (the MaintenancePanel tab
 * pattern). The two server scopes are engine-gated (`findUsages` / `dbSearch`
 * in utils/engineCaps); a scope the engine cannot serve is greyed with the
 * reason on hover, never hidden — the menu can offer this panel on every
 * engine because the files scope always works.
 */
import { useEffect, useState } from 'react';
import type { Session } from '../types';
import { can, ENGINE_LABELS } from '../utils/engineCaps';
import type { EngineCaps } from '../utils/engineCaps';
import { FindUsagesPanel } from './FindUsagesPanel';
import { DbSearchPanel } from './DbSearchPanel';
import { FindInFilesPanel } from './FindInFilesPanel';

export type FindScope = 'usages' | 'database' | 'files';

interface ScopeDef {
  id: FindScope;
  label: string;
  tip: string;
  /** Engine capability the scope needs — the files scope needs none. */
  cap?: keyof EngineCaps;
  /** What the scope does, for the greyed tab's "why not" tip. */
  does: string;
}

const SCOPES: ScopeDef[] = [
  {
    id: 'usages', label: 'Usages', cap: 'findUsages',
    tip: 'What references this table or column — views, routines, triggers, constraints',
    does: 'reads the definitions the server stores (views, routines, triggers), '
      + 'which only MySQL, PostgreSQL and SQL Server hand back as text',
  },
  {
    id: 'database', label: 'In database', cap: 'dbSearch',
    tip: 'Search every table in the schema for a value',
    does: 'needs a catalog to enumerate columns and a LIKE with an escape '
      + 'clause — the three SQL engines have both',
  },
  {
    id: 'files', label: 'In files',
    tip: 'Search a folder of .sql scripts — never touches the server',
    does: '',
  },
];

interface Props {
  session: Session;
  schema: string | null;
  /** Open buffers, so the usages scope searches unsaved scripts too. */
  buffers?: Array<{ id: string; label: string; sql: string }>;
  /** Folder for the files scope — the directory of the file in front of you. */
  initialDir?: string;
  /** Preselected scope, from an opener that knows which find it wants. */
  scope?: FindScope;
  onScopeConsumed?: () => void;
  onClose: () => void;
}

export function FindPanel({ session, schema, buffers, initialDir, scope, onScopeConsumed, onClose }: Props) {
  const engineLabel = ENGINE_LABELS[session.engine] ?? session.engine;
  const scopeOk = (s: ScopeDef) => !s.cap || can(session.engine, s.cap);
  // The default is the first scope this engine can serve: Usages on the SQL
  // engines, In files everywhere else.
  const [active, setActive] = useState<FindScope>(() => {
    const wanted = scope && SCOPES.find(s => s.id === scope);
    return (wanted && scopeOk(wanted) ? wanted : SCOPES.find(scopeOk)!).id;
  });

  // A scope-carrying open ("find usages of this column") applies to the panel
  // already mounted, exactly like the editors' targets: the scope switch is
  // React's sanctioned adjust-state-during-render, and the consume happens in
  // an effect so the parent's clear never fires during this render. Consumed
  // back to null re-arms the same scope for a later open.
  const [seenScope, setSeenScope] = useState<FindScope | null>(null);
  if (scope !== seenScope) {
    setSeenScope(scope ?? null);
    const def = scope && SCOPES.find(s => s.id === scope);
    if (def && scopeOk(def)) setActive(def.id);
  }
  useEffect(() => {
    if (scope) onScopeConsumed?.();
  }, [scope, onScopeConsumed]);

  const activeDef = SCOPES.find(s => s.id === active)!;
  const activeOk = scopeOk(activeDef);

  return (
    <div className="proc-panel">
      <div className="mnt-tabs" role="tablist">
        {SCOPES.map(s => {
          const ok = scopeOk(s);
          return (
            <button key={s.id} role="tab" aria-selected={active === s.id}
              className={`mnt-tab${active === s.id ? ' active' : ''}${ok ? '' : ' unavail'}`}
              data-tip={ok ? s.tip : `${s.label} — not available for ${engineLabel}: this scope ${s.does}`}
              onClick={() => { if (ok) setActive(s.id); }}>
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="find-scope-body">
        {/* Reachable only via a preselected scope this engine cannot serve —
            the tabs themselves refuse the click. */}
        {!activeOk && (
          <div className="db-error">
            {activeDef.label} is not available for {engineLabel} — this scope {activeDef.does}.
            The In files scope works everywhere, including offline.
          </div>
        )}
        {activeOk && active === 'usages' && (
          <FindUsagesPanel session={session} schema={schema} buffers={buffers} onClose={onClose} />
        )}
        {activeOk && active === 'database' && (
          <DbSearchPanel session={session} schema={schema} onClose={onClose} />
        )}
        {activeOk && active === 'files' && (
          <FindInFilesPanel initialDir={initialDir} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
