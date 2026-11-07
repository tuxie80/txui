import { useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { QueryResult, Session } from '../types';
import { safeOperationUnavailableReason } from '../utils/operationSupport';
import { readRefreshCatalogAnalysis } from '../utils/refreshCatalog';
import type { RefreshCatalogAnalysis } from '../utils/refreshCatalog';
import {
  createDefaultRefreshSpec, parseRefreshSpecText, refreshSpecHints, serializeRefreshSpec,
} from '../utils/refreshSpec';
import type {
  RefreshMaskRule, RefreshSpec, RefreshTablePolicy,
} from '../utils/refreshSpec';
import { buildRefreshPlan } from '../utils/refreshPlan';
import { planRefreshRowSets } from '../utils/refreshRowSets';
import type { RefreshRowSetPlan } from '../utils/refreshRowSets';
import { buildRefreshExecutionPlan } from '../utils/refreshExecution';
import { buildRefreshMaskPlan } from '../utils/refreshMask';
import { analyzeRefreshMaskSafety } from '../utils/refreshMaskSafety';
import { errorDisplay } from '../utils/appError';
import { StatusIcon } from './StatusIcon';

interface Props {
  session: Session;
  openSessions?: Session[];
  onClose: () => void;
}

const POLICIES: RefreshTablePolicy['policy'][] = ['full', 'time_window', 'row_limit', 'sample', 'predicate', 'exclude', 'generate'];
const MASKS: RefreshMaskRule['rule'][] = ['preserve', 'constant', 'hash', 'fake'];

function policyFor(kind: RefreshTablePolicy['policy'], table: string, previous?: RefreshTablePolicy): RefreshTablePolicy {
  if (previous && previous.policy === kind) return previous;
  switch (kind) {
    case 'full':
    case 'exclude': return { table, policy: kind };
    case 'time_window': return {
      table, policy: kind, column: 'created_at', mode: 'rolling', amount: 7,
      unit: 'days', timeZone: 'UTC', nullPolicy: 'exclude', cutoffUtc: new Date().toISOString(),
    };
    case 'row_limit': return { table, policy: kind, rows: 1000, orderBy: ['created_at'], direction: 'desc', tieBreaker: ['id'], limitKind: 'soft' };
    case 'sample': return { table, policy: kind, rows: 1000, sampleSeed: 1, tieBreaker: ['id'], limitKind: 'soft' };
    case 'predicate': return { table, policy: kind, where: 'tenant_id = 1' };
    case 'generate': return { table, policy: kind, rows: 1000, seedOffset: 0 };
  }
}

function maskFor(rule: RefreshMaskRule['rule'], table: string, column: string): RefreshMaskRule {
  switch (rule) {
    case 'preserve': return { table, column, rule };
    case 'constant': return { table, column, rule, value: '' };
    case 'hash': return { table, column, rule };
    case 'fake': return { table, column, rule, generator: 'person.full_name' };
  }
}

function numberValue(value: string): number {
  return Number.isSafeInteger(Number(value)) ? Number(value) : 0;
}

export function EnvironmentRefreshPanel({ session, openSessions = [session], onClose }: Props) {
  const unavailable = safeOperationUnavailableReason(session.engine, 'refresh');
  const candidates = openSessions.filter(candidate => candidate.engine === 'mysql');
  const [spec, setSpec] = useState<RefreshSpec>(() => {
    const initial = createDefaultRefreshSpec({
      source: { connectionId: session.connectionId, sessionId: session.sessionId },
      schema: 'shop', cutoffUtc: new Date().toISOString(),
    });
    const target = candidates.find(candidate => candidate.sessionId !== session.sessionId);
    if (target) initial.target = { connectionId: target.connectionId, sessionId: target.sessionId };
    return initial;
  });
  const [confirmed, setConfirmed] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RefreshCatalogAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [rowSetPlan, setRowSetPlan] = useState<RefreshRowSetPlan | null>(null);
  const [planningRows, setPlanningRows] = useState(false);
  const [rowProgress, setRowProgress] = useState<{ phase: string; table: string; queries: number; rowsRead: number } | null>(null);
  const analysisGeneration = useRef(0);
  const [logs, setLogs] = useState<string[]>(['Specification only — no catalog reads or database writes have run.']);

  const validationError = useMemo(() => {
    try {
      serializeRefreshSpec(spec);
      buildRefreshPlan(spec);
      return null;
    } catch (error) {
      return errorDisplay(error);
    }
  }, [spec]);
  const plan = useMemo(() => validationError ? null : analysis?.plan ?? buildRefreshPlan(spec), [spec, validationError, analysis]);
  const executionPlan = useMemo(() => analysis && rowSetPlan
    ? buildRefreshExecutionPlan({ spec, catalog: analysis, rowSets: rowSetPlan })
    : null, [spec, analysis, rowSetPlan]);
  const maskPlan = useMemo(() => analysis ? buildRefreshMaskPlan({ spec, catalog: analysis }) : null, [spec, analysis]);
  const maskSafety = useMemo(() => analysis && rowSetPlan
    ? analyzeRefreshMaskSafety({ spec, catalog: analysis, rowSets: rowSetPlan })
    : null, [spec, analysis, rowSetPlan]);
  const json = useMemo(() => {
    try {
      return serializeRefreshSpec(spec);
    } catch {
      return `${JSON.stringify(spec, null, 2)}\n`;
    }
  }, [spec]);

  const patch = (change: (current: RefreshSpec) => RefreshSpec) => {
    analysisGeneration.current += 1;
    setSpec(change);
    setConfirmed(false);
    setAnalysis(null);
    setAnalyzing(false);
    setRowSetPlan(null);
    setPlanningRows(false);
    setRowProgress(null);
    setFileError(null);
  };
  const selectEndpoint = (side: 'source' | 'target', sessionId: string) => {
    const selected = candidates.find(candidate => candidate.sessionId === sessionId);
    patch(current => ({
      ...current,
      [side]: selected
        ? { connectionId: selected.connectionId, sessionId: selected.sessionId }
        : { connectionId: '', sessionId: null },
    }));
  };
  const updatePolicy = (index: number, value: RefreshTablePolicy) => {
    patch(current => ({ ...current, tables: current.tables.map((table, at) => at === index ? value : table) }));
  };
  const updateMask = (index: number, value: RefreshMaskRule) => {
    patch(current => ({ ...current, masks: current.masks.map((mask, at) => at === index ? value : mask) }));
  };

  const importSpec = async () => {
    setFileError(null);
    try {
      const path = await open({ multiple: false, filters: [{ name: 'Refresh specification', extensions: ['json'] }] });
      if (!path) return;
      const text = await invoke<string>('refresh_spec_load', { path });
      const imported = refreshSpecHints(parseRefreshSpecText(text));
      patch(() => imported);
      setLogs(current => [...current,
        `Loaded ${path}. Connection IDs are hints only; both session selections were cleared. Reconfirm source and target before any future planning.`]);
    } catch (error) {
      setFileError(errorDisplay(error));
    }
  };

  const exportSpec = async () => {
    setFileError(null);
    try {
      const contents = serializeRefreshSpec(spec);
      const path = await save({ defaultPath: 'environment-refresh.json', filters: [{ name: 'Refresh specification', extensions: ['json'] }] });
      if (!path) return;
      await invoke('refresh_spec_save', { path, contents });
      setLogs(current => [...current, `Specification saved atomically to ${path}; no credentials or row data included.`]);
    } catch (error) {
      setFileError(errorDisplay(error));
    }
  };

  const confirmEndpoints = () => {
    try {
      serializeRefreshSpec(spec);
      if (!spec.source.sessionId || !spec.target.sessionId || spec.source.sessionId === spec.target.sessionId) {
        throw new Error('choose two different open sessions before confirming endpoints');
      }
      setConfirmed(true);
      setLogs(current => [...current,
        `Endpoints reconfirmed for this editor only: ${spec.source.sessionId} → ${spec.target.sessionId}. Confirmation is not exported and is not execution proof.`]);
    } catch (error) {
      setFileError(errorDisplay(error));
    }
  };

  const analyzeCatalogs = async () => {
    const generation = ++analysisGeneration.current;
    setAnalyzing(true);
    setAnalysis(null);
    setRowSetPlan(null);
    setPlanningRows(false);
    setRowProgress(null);
    setFileError(null);
    try {
      const result = await readRefreshCatalogAnalysis({
        spec,
        runGrid: async (sessionId, sql) => {
          const query = await invoke<QueryResult>('monitor_query', { sessionId, sql });
          return { columns: query.columns.map(column => column.name), rows: query.rows, truncated: query.truncated };
        },
        onLog: line => {
          if (analysisGeneration.current === generation) setLogs(current => [...current, line]);
        },
      });
      if (analysisGeneration.current !== generation) return;
      setAnalysis(result);
      setLogs(current => [...current,
        `${result.complete ? 'Catalog compatibility proven' : 'Catalog analysis found blockers'}: ${result.scanned.sourceTables} source tables, ${result.scanned.targetTables} target tables, ${result.scanned.foreignKeys} foreign keys, ${result.blockers.length} blockers. No table rows were read or written.`]);
    } catch (error) {
      if (analysisGeneration.current === generation) setFileError(errorDisplay(error));
    } finally {
      if (analysisGeneration.current === generation) setAnalyzing(false);
    }
  };

  const planRowSets = async () => {
    if (!analysis?.complete) return;
    const catalog = analysis;
    const generation = ++analysisGeneration.current;
    setPlanningRows(true);
    setRowSetPlan(null);
    setRowProgress(null);
    setFileError(null);
    try {
      const result = await planRefreshRowSets({
        spec, catalog,
        runGrid: async (sessionId, sql) => {
          const query = await invoke<QueryResult>('monitor_query', { sessionId, sql });
          return { columns: query.columns.map(column => column.name), rows: query.rows, truncated: query.truncated };
        },
        onProgress: event => {
          if (analysisGeneration.current === generation) setRowProgress(event);
        },
      });
      if (analysisGeneration.current !== generation) return;
      setRowSetPlan(result);
      setLogs(current => [...current,
        `${result.fixedPoint ? 'Row-set closure reached a fixed point' : 'Row-set planning is blocked'}: ${result.totals.requested ?? 'unknown'} requested + ${result.totals.closureAdded ?? 'unknown'} closure = ${result.totals.final ?? 'unknown'} final across ${result.tables.length} tables; ${result.sourceQueries} key-only queries, ${result.sourceRowsRead} key rows read, ${result.blockers.length} blockers. No target writes.`]);
    } catch (error) {
      if (analysisGeneration.current === generation) setFileError(errorDisplay(error));
    } finally {
      if (analysisGeneration.current === generation) setPlanningRows(false);
    }
  };

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">Safe Environment Refresh</span>
        <span className="dv-desc">{session.connectionName}</span>
        <span className="dv-desc">Specification v1</span>
        <div style={{ flex: 1 }} />
        <button className="toolbar-btn" disabled={!!unavailable} onClick={() => void importSpec()}>Import JSON…</button>
        <button className="toolbar-btn" disabled={!!unavailable || !!validationError} title={validationError ?? 'Export deterministic, secret-free JSON'} onClick={() => void exportSpec()}>Export JSON…</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>
      <div className="dg-body">
        {unavailable ? (
          <div className="mnt-warn"><StatusIcon kind="error" /><span>{unavailable}</span></div>
        ) : (
          <div className="sqp-main">
            <div className="sqp-left">
              <section>
                <h3>Endpoint hints and reconfirmation</h3>
                <p className="dv-desc">Source and target must be different open MySQL/MariaDB sessions. Imported IDs are hints only. Confirmation belongs to this editor and is never exported.</p>
                <label className="dg-field-inline"><span>Source session</span>
                  <select className="toolbar-select" value={spec.source.sessionId ?? ''} onChange={event => selectEndpoint('source', event.target.value)}>
                    <option value="">— choose source —</option>
                    {candidates.map(candidate => <option key={candidate.sessionId} value={candidate.sessionId}>{candidate.connectionName} · {candidate.environment ?? 'unspecified'}</option>)}
                  </select>
                </label>
                <label className="dg-field-inline"><span>Target session</span>
                  <select className="toolbar-select" value={spec.target.sessionId ?? ''} onChange={event => selectEndpoint('target', event.target.value)}>
                    <option value="">— choose target —</option>
                    {candidates.map(candidate => <option key={candidate.sessionId} value={candidate.sessionId}>{candidate.connectionName} · {candidate.environment ?? 'unspecified'}</option>)}
                  </select>
                </label>
                <div className="row-actions">
                  <button className="primary" disabled={confirmed || !!validationError || analyzing} title={validationError ?? 'Reconfirm both endpoints for this editor only'} onClick={confirmEndpoints}>
                    {confirmed ? '✓ Endpoints reconfirmed' : 'Reconfirm source and target'}
                  </button>
                  <button className="toolbar-btn" disabled={!confirmed || !!validationError || analyzing || planningRows} title={!confirmed ? 'Reconfirm both endpoints first' : 'Read only source and target catalog metadata; never application rows'} onClick={() => void analyzeCatalogs()}>
                    {analyzing ? 'Analyzing catalogs…' : 'Analyze catalogs'}
                  </button>
                  <button className="toolbar-btn" disabled={!analysis?.complete || analyzing || planningRows} title={!analysis?.complete ? 'Complete catalog compatibility analysis first' : 'Read source unique keys and FK columns only, then compute fixed-point parent closure; no target writes'} onClick={() => void planRowSets()}>
                    {planningRows ? 'Planning row sets…' : 'Plan row sets'}
                  </button>
                </div>
                {confirmed && <p className="dv-desc">Confirmed for this editor only. {analysis ? 'Catalog proof is current for this specification; no execution is available.' : 'No catalog read or write has run.'}</p>}
              </section>

              <section>
                <h3>Schema mappings and deterministic seed</h3>
                <label className="dg-field-inline"><span>Seed (not a password or masking key)</span>
                  <input value={spec.seed} onChange={event => patch(current => ({ ...current, seed: event.target.value }))} />
                </label>
                <label className="dg-field-inline"><span>Allow explicit FK-breaking masks</span>
                  <input type="checkbox" checked={spec.allowFkBreaking} onChange={event => patch(current => ({ ...current, allowFkBreaking: event.target.checked }))} />
                </label>
                <label className="dg-field-inline"><span>Acknowledge listed unmasked sensitive columns</span>
                  <input type="checkbox" checked={spec.acknowledgeUnmaskedSensitive ?? false} onChange={event => patch(current => ({ ...current, acknowledgeUnmaskedSensitive: event.target.checked }))} />
                </label>
                <label className="dg-field-inline" style={{ display: 'block' }}><span>Mappings (source =&gt; target, one per line)</span>
                  <textarea
                    className="sqp-sql"
                    value={spec.schemaMappings.map(mapping => `${mapping.source} => ${mapping.target}`).join('\n')}
                    onChange={event => patch(current => ({
                      ...current,
                      schemaMappings: event.target.value.split('\n').map(line => {
                        const [source, target] = line.split('=>');
                        return { source: source?.trim() ?? '', target: target?.trim() ?? '' };
                      }),
                    }))}
                    spellCheck={false}
                  />
                </label>
              </section>

              <section>
                <h3>Independent table policies</h3>
                {spec.tables.map((table, index) => (
                  <div key={`${table.table}-${index}`} className="sqp-finding">
                    <div className="row-actions">
                      <input aria-label={`Table ${index + 1}`} value={table.table} onChange={event => updatePolicy(index, { ...table, table: event.target.value })} />
                      <select aria-label={`Policy ${index + 1}`} value={table.policy} onChange={event => updatePolicy(index, policyFor(event.target.value as RefreshTablePolicy['policy'], table.table, table))}>
                        {POLICIES.map(policy => <option key={policy} value={policy}>{policy}</option>)}
                      </select>
                      <button className="toolbar-btn" onClick={() => patch(current => ({ ...current, tables: current.tables.filter((_, at) => at !== index) }))}>Remove</button>
                    </div>
                    {table.policy === 'time_window' && (
                      <div className="sqp-f-evidence">
                        <label>Column <input value={table.column} onChange={event => updatePolicy(index, { ...table, column: event.target.value })} /></label>
                        <label>Amount <input type="number" value={table.amount} onChange={event => updatePolicy(index, { ...table, amount: numberValue(event.target.value) })} /></label>
                        <label>Unit <select value={table.unit} onChange={event => updatePolicy(index, { ...table, unit: event.target.value as 'hours' | 'days' })}><option value="hours">hours</option><option value="days">days</option></select></label>
                        <label>Mode <select value={table.mode} onChange={event => updatePolicy(index, { ...table, mode: event.target.value as 'rolling' | 'calendar_days' })}><option value="rolling">rolling</option><option value="calendar_days">calendar days</option></select></label>
                        <label>Timezone <input value={table.timeZone} onChange={event => updatePolicy(index, { ...table, timeZone: event.target.value })} /></label>
                        <label>NULLs <select value={table.nullPolicy} onChange={event => updatePolicy(index, { ...table, nullPolicy: event.target.value as 'exclude' | 'include' })}><option value="exclude">exclude</option><option value="include">include</option></select></label>
                        <label>Frozen UTC cutoff <input value={table.cutoffUtc} onChange={event => updatePolicy(index, { ...table, cutoffUtc: event.target.value })} /></label>
                      </div>
                    )}
                    {table.policy === 'row_limit' && (
                      <div className="sqp-f-evidence">
                        <label>Rows <input type="number" value={table.rows} onChange={event => updatePolicy(index, { ...table, rows: numberValue(event.target.value) })} /></label>
                        <label>Limit behavior <select value={table.limitKind ?? 'soft'} onChange={event => updatePolicy(index, { ...table, limitKind: event.target.value as 'soft' | 'hard' })}><option value="soft">Soft — closure may exceed</option><option value="hard">Hard — reject overflow</option></select></label>
                        <label>Order columns <input value={table.orderBy.join(',')} onChange={event => updatePolicy(index, { ...table, orderBy: event.target.value.split(',').map(value => value.trim()) })} /></label>
                        <label>Direction <select value={table.direction} onChange={event => updatePolicy(index, { ...table, direction: event.target.value as 'asc' | 'desc' })}><option value="desc">desc</option><option value="asc">asc</option></select></label>
                        <label>Unique tie-breaker <input value={table.tieBreaker.join(',')} onChange={event => updatePolicy(index, { ...table, tieBreaker: event.target.value.split(',').map(value => value.trim()) })} /></label>
                      </div>
                    )}
                    {table.policy === 'sample' && (
                      <div className="sqp-f-evidence">
                        <label>Rows <input type="number" value={table.rows} onChange={event => updatePolicy(index, { ...table, rows: numberValue(event.target.value) })} /></label>
                        <label>Limit behavior <select value={table.limitKind ?? 'soft'} onChange={event => updatePolicy(index, { ...table, limitKind: event.target.value as 'soft' | 'hard' })}><option value="soft">Soft — closure may exceed</option><option value="hard">Hard — reject overflow</option></select></label>
                        <label>Sample seed <input type="number" value={table.sampleSeed} onChange={event => updatePolicy(index, { ...table, sampleSeed: numberValue(event.target.value) })} /></label>
                        <label>Unique tie-breaker <input value={table.tieBreaker.join(',')} onChange={event => updatePolicy(index, { ...table, tieBreaker: event.target.value.split(',').map(value => value.trim()) })} /></label>
                      </div>
                    )}
                    {table.policy === 'predicate' && (
                      <label className="dg-field-inline"><span>Predicate (no statement terminator)</span><input value={table.where} onChange={event => updatePolicy(index, { ...table, where: event.target.value })} /></label>
                    )}
                    {table.policy === 'generate' && (
                      <div className="sqp-f-evidence">
                        <label>Rows <input type="number" value={table.rows} onChange={event => updatePolicy(index, { ...table, rows: numberValue(event.target.value) })} /></label>
                        <label>Seed offset <input type="number" value={table.seedOffset} onChange={event => updatePolicy(index, { ...table, seedOffset: numberValue(event.target.value) })} /></label>
                      </div>
                    )}
                  </div>
                ))}
                <button className="toolbar-btn" onClick={() => patch(current => ({ ...current, tables: [...current.tables, { table: `table_${current.tables.length + 1}`, policy: 'full' }] }))}>+ Add table policy</button>
              </section>
            </div>

            <div className="sqp-right">
              <section>
                <h3>Mask rules</h3>
                <p className="dv-desc">Relational equality is preserved by default. Fake/hash rules are deterministic under the specification seed; no password-derived key exists.</p>
                {spec.masks.map((mask, index) => (
                  <div key={`${mask.table}.${mask.column}-${index}`} className="sqp-finding">
                    <div className="row-actions">
                      <input aria-label={`Mask table ${index + 1}`} value={mask.table} onChange={event => updateMask(index, { ...mask, table: event.target.value })} />
                      <input aria-label={`Mask column ${index + 1}`} value={mask.column} onChange={event => updateMask(index, { ...mask, column: event.target.value })} />
                      <select aria-label={`Mask rule ${index + 1}`} value={mask.rule} onChange={event => updateMask(index, maskFor(event.target.value as RefreshMaskRule['rule'], mask.table, mask.column))}>
                        {MASKS.map(rule => <option key={rule} value={rule}>{rule}</option>)}
                      </select>
                      <button className="toolbar-btn" onClick={() => patch(current => ({ ...current, masks: current.masks.filter((_, at) => at !== index) }))}>Remove</button>
                    </div>
                    {mask.rule === 'constant' && <label className="dg-field-inline"><span>Constant</span><input value={String(mask.value ?? '')} onChange={event => updateMask(index, { ...mask, value: event.target.value })} /></label>}
                    {mask.rule === 'fake' && <label className="dg-field-inline"><span>Seeded generator</span><input value={mask.generator} onChange={event => updateMask(index, { ...mask, generator: event.target.value })} /></label>}
                  </div>
                ))}
                <button className="toolbar-btn" onClick={() => patch(current => ({ ...current, masks: [...current.masks, { table: 'customers', column: 'email', rule: 'hash' }] }))}>+ Add mask</button>
                {maskPlan && (
                  <div className="sqp-finding">
                    <div className={maskPlan.complete ? 'mnt-bulk-cost c-metadata' : 'mnt-warn'}>
                      <StatusIcon kind={maskPlan.complete ? 'ok' : 'error'} />
                      <span>{maskPlan.complete ? `Mask contract valid: ${maskPlan.rules.length} rules. No values have been transformed.` : `Mask contract blocked: ${maskPlan.blockers.length} blockers.`}</span>
                    </div>
                    {maskPlan.blockers.map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                    {maskPlan.rules.map(rule => (
                      <div key={`${rule.table}.${rule.column}`} className="sqp-f-evidence">
                        <b>{rule.table}.{rule.column}</b> · {rule.rule}{rule.generator ? ` · ${rule.generator}` : ''}{rule.relation ? ' · relational seed shared' : ' · column seed'}
                        {rule.notes.map(note => <div key={note}>{note}</div>)}
                      </div>
                    ))}
                  </div>
                )}
                {maskSafety && (
                  <div className="sqp-finding">
                    <div className={maskSafety.complete ? 'mnt-bulk-cost c-metadata' : 'mnt-warn'}>
                      <StatusIcon kind={maskSafety.complete ? 'ok' : 'error'} />
                      <span>{maskSafety.complete ? `Mask safety valid: ${maskSafety.uniqueChecks.length} unique indexes require runtime checks.` : `Mask safety blocked: ${maskSafety.blockers.length} blockers.`}</span>
                    </div>
                    {maskSafety.blockers.map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                    {maskSafety.uniqueChecks.slice(0, 100).map(check => <div key={`${check.table}.${check.index}`} className="sqp-f-evidence">{check.table} · {check.index} ({check.columns.join(', ')}) · {check.note}</div>)}
                    {maskSafety.sensitiveUnmasked.length > 0 && <div className="sqp-f-evidence"><b>Unmasked sensitive-looking columns:</b> {maskSafety.sensitiveUnmasked.slice(0, 100).join(', ')}{maskSafety.sensitiveUnmasked.length > 100 ? ` · +${maskSafety.sensitiveUnmasked.length - 100} more` : ''}</div>}
                    {maskSafety.sensitiveMasked.length > 0 && <div className="sqp-f-evidence"><b>Sensitive columns with mask rules:</b> {maskSafety.sensitiveMasked.slice(0, 100).join(', ')}{maskSafety.sensitiveMasked.length > 100 ? ` · +${maskSafety.sensitiveMasked.length - 100} more` : ''}</div>}
                    {maskSafety.generatedColumns.length > 0 && <div className="sqp-f-evidence"><b>Omitted from inserts, recomputed by target:</b> {maskSafety.generatedColumns.slice(0, 100).join(', ')}{maskSafety.generatedColumns.length > 100 ? ` · +${maskSafety.generatedColumns.length - 100} more` : ''}</div>}
                    {maskSafety.notes.map(note => <div key={note} className="sqp-f-evidence">{note}</div>)}
                  </div>
                )}
              </section>

              <section>
                <h3>Bounded chunks and planning</h3>
                {([
                  ['maxRowsPerChunk', 'Max rows per chunk'],
                  ['maxBytesPerChunk', 'Max bytes per chunk'],
                  ['planningKeyBatch', 'Planning key batch'],
                  ['maxPlanningKeys', 'Max planning keys'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="dg-field-inline"><span>{label}</span>
                    <input type="number" value={spec.limits[key]} onChange={event => patch(current => ({ ...current, limits: { ...current.limits, [key]: numberValue(event.target.value) } }))} />
                  </label>
                ))}
              </section>

              <section>
                <h3>Verification options</h3>
                {([
                  ['exactCounts', 'Exact source/target counts'],
                  ['foreignKeyOrphans', 'Foreign-key orphan checks'],
                  ['contentSha256', 'Canonical masked-content SHA-256'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="dg-field-inline"><span>{label}</span>
                    <input type="checkbox" checked={spec.verification[key]} onChange={event => patch(current => ({ ...current, verification: { ...current.verification, [key]: event.target.checked } }))} />
                  </label>
                ))}
              </section>

              {analysis && (
                <section>
                  <h3>Catalog graph &amp; target compatibility</h3>
                  <p className="dv-desc">{analysis.scanned.sourceSchemas} source schemas · {analysis.scanned.sourceTables} source tables · {analysis.scanned.targetTables} target tables · {analysis.scanned.foreignKeys} FKs · {analysis.scanned.selfReferences} self references · {analysis.scanned.cycles} cycles including self references · {analysis.blockers.length} blockers. Metadata only; no application rows read or written.</p>
                  <div className={analysis.complete ? 'mnt-bulk-cost c-metadata' : 'mnt-warn'}>
                    <StatusIcon kind={analysis.complete ? 'ok' : 'error'} />
                    <span>{analysis.complete ? 'Catalog compatibility proven. This is not row-copy, masking or execution proof.' : 'Catalog compatibility is blocked; no row planning or execution may proceed.'}</span>
                  </div>
                  {analysis.blockers.slice(0, 200).map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                  {analysis.blockers.length > 200 && <p className="dv-desc">Showing 200 of {analysis.blockers.length} blockers; all remain blocking.</p>}
                  {analysis.graph.foreignKeys.slice(0, 100).map(edge => (
                    <div key={edge.key} className="sqp-f-evidence">
                      <b>{edge.schema}.{edge.table}.{edge.name}</b> → {edge.refSchema}.{edge.refTable} · {edge.parts.map(part => `${part.column}${part.nullable ? ' NULL' : ' NOT NULL'} → ${part.refColumn}`).join(', ')}{edge.selfReference ? ' · self reference' : ''}{edge.external ? ' · parent outside loaded schemas' : ''}
                    </div>
                  ))}
                  {analysis.graph.foreignKeys.length > 100 && <p className="dv-desc">Showing 100 of {analysis.graph.foreignKeys.length} foreign keys.</p>}
                  {analysis.tables.slice(0, 200).map(table => (
                    <div key={table.table} className="sqp-finding">
                      <div className="sqp-f-title"><b>{table.table}</b> · {table.action}</div>
                      <div className="sqp-f-detail">{table.source ?? 'no source'} → {table.target ?? 'no target'} · key {table.key ? `${table.key.name} (${table.key.columns.join(', ')})` : 'not proven'}</div>
                      {table.notes.map(note => <div key={note} className="sqp-f-evidence">{note}</div>)}
                      {table.blockers.map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                    </div>
                  ))}
                  {analysis.tables.length > 200 && <p className="dv-desc">Showing 200 of {analysis.tables.length} selected/dependent tables.</p>}
                </section>
              )}

              {(planningRows || rowSetPlan) && (
                <section>
                  <h3>Requested rows + FK closure</h3>
                  {planningRows && <p className="dv-desc">Reading only source unique keys and FK columns{rowProgress ? ` · ${rowProgress.phase} · ${rowProgress.table} · ${rowProgress.queries} queries · ${rowProgress.rowsRead} key rows` : '…'}. No target reads or writes.</p>}
                  {rowSetPlan && (
                    <>
                      <p className="dv-desc">Requested {rowSetPlan.totals.requested ?? 'unknown'} + closure {rowSetPlan.totals.closureAdded ?? 'unknown'} = final {rowSetPlan.totals.final ?? 'unknown'} · {rowSetPlan.sourceQueries} key-only queries · {rowSetPlan.sourceRowsRead} key rows read · {rowSetPlan.iterations} closure iterations · {rowSetPlan.blockers.length} blockers. Keys and FK values are not shown or logged.</p>
                      <p className="dv-desc">Memory: peak retained keys {rowSetPlan.memory.peakRetainedKeys.toLocaleString()} / {rowSetPlan.memory.maxPlanningKeys.toLocaleString()} · peak frontier rows {rowSetPlan.memory.peakFrontierRows.toLocaleString()} / {rowSetPlan.memory.planningKeyBatch.toLocaleString()} · peak query buffer {rowSetPlan.memory.peakBufferedRows.toLocaleString()} / {rowSetPlan.memory.planningKeyBatch.toLocaleString()} · full-root keys retained 0.</p>
                      <div className={rowSetPlan.fixedPoint ? 'mnt-bulk-cost c-metadata' : 'mnt-warn'}>
                        <StatusIcon kind={rowSetPlan.fixedPoint ? 'ok' : 'error'} />
                        <span>{rowSetPlan.fixedPoint ? 'Fixed-point row-set plan complete. No target writes or execution have occurred.' : 'Row-set plan is incomplete or blocked; totals are not executable.'}</span>
                      </div>
                      {rowSetPlan.blockers.map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                      {rowSetPlan.tables.slice(0, 200).map(table => (
                        <div key={table.table} className="sqp-finding">
                          <div className="sqp-f-title"><b>{table.table}</b> · {table.action}</div>
                          <div className="sqp-f-detail">requested {table.requested ?? 'unknown'} + closure {table.closureAdded ?? 'unknown'} = final {table.final ?? 'unknown'}</div>
                          {table.notes.map(note => <div key={note} className="sqp-f-evidence">{note}</div>)}
                        </div>
                      ))}
                      {rowSetPlan.tables.length > 200 && <p className="dv-desc">Showing 200 of {rowSetPlan.tables.length} tables; all blockers remain in force.</p>}
                    </>
                  )}
                </section>
              )}

              {executionPlan && (
                <section>
                  <h3>Deterministic execution plan</h3>
                  <p className="dv-desc">Catalog SHA-256: {executionPlan.catalogSha256} · row-set SHA-256: {executionPlan.rowSetSha256} · {executionPlan.blockers.length} blockers. Exact first-page SQL and unique keyset boundaries; OFFSET is never used.</p>
                  <div className={executionPlan.executable ? 'mnt-bulk-cost c-metadata' : 'mnt-warn'}>
                    <StatusIcon kind={executionPlan.executable ? 'ok' : 'error'} />
                    <span>{executionPlan.executable ? 'Execution plan is deterministic and schema-bound. Execution remains unavailable.' : 'Execution plan is blocked by incomplete proof or insertion-order constraints.'}</span>
                  </div>
                  {executionPlan.blockers.map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                  {executionPlan.insertionOrder.length > 0 && <p className="dv-desc">Insertion order: {executionPlan.insertionOrder.map((table, index) => `${index + 1}. ${table}`).join(' · ')}</p>}
                  {executionPlan.tables.slice(0, 200).map(table => (
                    <div key={table.table} className="sqp-finding">
                      <div className="sqp-f-title"><b>{table.table}</b> · {table.action}</div>
                      <div className="sqp-f-detail">{table.sourceSchema} → {table.targetSchema} · {table.keySource} ({table.keyColumns.join(', ')}) · batch {table.batchRows.toLocaleString()} · selected {table.selectedRows.toLocaleString()} · estimated data batches {table.estimatedDataBatches.toLocaleString()} · source stats {table.sourceStatsRows?.toLocaleString() ?? 'unknown'} rows</div>
                      {table.firstPageSql && <code className="sqp-f-snippet">{table.firstPageSql}</code>}
                      {table.notes.map(note => <div key={note} className="sqp-f-evidence">{note}</div>)}
                    </div>
                  ))}
                  {executionPlan.tables.length > 200 && <p className="dv-desc">Showing 200 of {executionPlan.tables.length} tables.</p>}
                </section>
              )}

              {plan && (
                <section>
                  <h3>Read-only plan preview</h3>
                  <p className="dv-desc">Spec SHA-256: {plan.specSha256} · {plan.tables.filter(table => table.action === 'read').length} reads · {plan.tables.filter(table => table.action === 'generate').length} generate · {plan.tables.filter(table => table.action === 'exclude').length} excluded · {plan.blockers.length} blockers. No SQL is executed and row estimates are not available.</p>
                  {plan.blockers.map(blocker => <div key={blocker} className="mnt-warn"><StatusIcon kind="error" /><span>{blocker}</span></div>)}
                  {plan.tables.map(table => (
                    <div key={table.table} className="sqp-finding">
                      <div className="sqp-f-title"><b>{table.table}</b> · {table.action}</div>
                      <div className="sqp-f-detail">{table.sourceSchema ?? 'unmapped'} → {table.targetSchema ?? 'unmapped'} · estimate not available</div>
                      {table.sourceSql && <code className="sqp-f-snippet">{table.sourceSql}</code>}
                      {table.notes.map(note => <div key={note} className="sqp-f-evidence">{note}</div>)}
                    </div>
                  ))}
                </section>
              )}

              <section>
                <h3>Specification status</h3>
                {validationError
                  ? <div className="mnt-warn"><StatusIcon kind="error" /><span>{validationError}</span></div>
                  : <div className="mnt-bulk-cost c-metadata"><StatusIcon kind="ok" /><span>Valid secret-free specification. Execution is not available yet.</span></div>}
                {fileError && <div className="proc-error-bar">{fileError}</div>}
                <div className="sqp-log">{logs.map((line, index) => <div key={index} className="sqp-log-line">{line}</div>)}</div>
                <textarea className="sqp-sql" readOnly value={json} aria-label="Refresh specification JSON" spellCheck={false} />
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
