import { useMemo, useState } from 'react';
import type { Session } from '../types';
import { safeOperationUnavailableReason } from '../utils/operationSupport';
import {
  createDefaultQueryLabExperiment, parseQueryLabExperiment, queryLabSpecSha256, validateQueryLabExperiment,
} from '../utils/queryLabSpec';
import type {
  NormalizedQueryLabExperiment, QueryLabCandidate, QueryLabEvidenceRequirements,
  QueryLabExperiment, QueryLabParameterKind,
} from '../utils/queryLabSpec';
import { StatusIcon } from './StatusIcon';

interface Props {
  session: Session;
  schema?: string | null;
  onClose: () => void;
}

export function QueryLabPanel({ session, schema, onClose }: Props) {
  const unavailable = safeOperationUnavailableReason(session.engine, 'querylab');
  const [experiment, setExperiment] = useState<QueryLabExperiment>(() => createDefaultQueryLabExperiment({
    engine: session.engine === 'postgres' ? 'postgres' : 'mysql',
    database: schema || 'shop',
    sessionId: session.sessionId,
    connectionId: session.connectionId,
    environment: session.environment,
    readOnly: session.readOnly,
  }));
  const [validated, setValidated] = useState<NormalizedQueryLabExperiment | null>(null);
  const errors = useMemo(() => validateQueryLabExperiment(experiment), [experiment]);
  const specHash = useMemo(() => queryLabSpecSha256(experiment), [experiment]);

  const patch = (change: (current: QueryLabExperiment) => QueryLabExperiment) => {
    setExperiment(change);
    setValidated(null);
  };
  const updateCandidate = (index: number, change: Partial<QueryLabCandidate>) => {
    patch(current => ({
      ...current,
      candidates: current.candidates.map((candidate, at) => at === index
        ? { ...candidate, ...change } as QueryLabCandidate : candidate),
    }));
  };
  const changeCandidateKind = (index: number, kind: QueryLabCandidate['kind']) => {
    const id = experiment.candidates[index]?.id ?? `candidate-${index + 1}`;
    const candidate: QueryLabCandidate = kind === 'index'
      ? { id, kind, name: 'Candidate index', table: 'orders', columns: ['customer_id'], unique: false, where: null }
      : kind === 'rewrite'
        ? { id, kind, name: 'Candidate rewrite', sql: experiment.originalSql }
        : { id, kind, name: 'work_mem', value: '64MB' };
    patch(current => ({ ...current, candidates: current.candidates.map((current, at) => at === index ? candidate : current) }));
  };
  const updateEvidence = (key: keyof QueryLabEvidenceRequirements, value: boolean) => {
    patch(current => ({ ...current, evidence: { ...current.evidence, [key]: value } }));
  };
  const validate = () => {
    const parsed = parseQueryLabExperiment(experiment);
    setValidated(parsed.ok ? parsed.experiment : null);
  };

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">Query Optimization Lab</span>
        <span className="dv-desc">{session.connectionName}</span>
        <span className="dv-desc">Specification v1 · read-only checkpoint</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>
      <div className="dg-body">
        {unavailable ? (
          <div className="mnt-warn"><StatusIcon kind="error" /><span>{unavailable}</span></div>
        ) : (
          <div className="sqp-main">
            <div className="sqp-left">
              <section>
                <h3>Original query and database</h3>
                <label className="dg-field-inline"><span>Database/schema</span>
                  <input value={experiment.database} onChange={event => patch(current => ({
                    ...current, database: event.target.value,
                    scratch: current.scratch ? { ...current.scratch, database: event.target.value } : null,
                  }))} />
                </label>
                <label className="dg-field-inline" style={{ display: 'block' }}><span>One SELECT or read-only WITH statement</span>
                  <textarea className="sqp-sql" rows={7} value={experiment.originalSql} spellCheck={false}
                    onChange={event => patch(current => ({ ...current, originalSql: event.target.value }))} />
                </label>
                <p className="dv-desc">Named <code>:parameters</code> require concrete values below. Positional <code>$1</code>/<code>?</code>, writes, multi-statements and client commands are refused before any invocation.</p>
              </section>

              <section>
                <h3>Concrete parameters</h3>
                {Object.entries(experiment.parameters).map(([name, parameter]) => (
                  <div className="sqp-f-evidence" key={name}>
                    <label>Name <input value={name} onChange={event => patch(current => {
                      const parameters = Object.fromEntries(Object.entries(current.parameters)
                        .map(([key, value]) => [key === name ? event.target.value : key, value]));
                      return { ...current, parameters };
                    })} /></label>
                    <label>Kind <select value={parameter.kind} onChange={event => patch(current => ({
                      ...current,
                      parameters: {
                        ...current.parameters,
                        [name]: { kind: event.target.value as QueryLabParameterKind, value: event.target.value === 'null' ? '' : parameter.value },
                      },
                    }))}>
                      {(['text', 'number', 'boolean', 'null'] as const).map(kind => <option key={kind} value={kind}>{kind}</option>)}
                    </select></label>
                    <label>Value <input value={parameter.value} disabled={parameter.kind === 'null'} onChange={event => patch(current => ({
                      ...current, parameters: { ...current.parameters, [name]: { ...parameter, value: event.target.value } },
                    }))} /></label>
                    <button className="toolbar-btn" onClick={() => patch(current => ({
                      ...current, parameters: Object.fromEntries(Object.entries(current.parameters).filter(([key]) => key !== name)),
                    }))}>Remove</button>
                  </div>
                ))}
                <button className="toolbar-btn" onClick={() => patch(current => ({
                  ...current,
                  parameters: {
                    ...current.parameters,
                    [`param_${Object.keys(current.parameters).length + 1}`]: { kind: 'text', value: '' },
                  },
                }))}>+ Add parameter</button>
              </section>

              <section>
                <h3>Candidates</h3>
                {experiment.candidates.map((candidate, index) => (
                  <div className="sqp-finding" key={`${candidate.id}-${index}`}>
                    <div className="row-actions">
                      <input aria-label={`Candidate ${index + 1} ID`} value={candidate.id} onChange={event => updateCandidate(index, { id: event.target.value })} />
                      <select aria-label={`Candidate ${index + 1} kind`} value={candidate.kind} onChange={event => changeCandidateKind(index, event.target.value as QueryLabCandidate['kind'])}>
                        {(['index', 'rewrite', 'setting'] as const).map(kind => <option key={kind} value={kind}>{kind}</option>)}
                      </select>
                      <button className="toolbar-btn" onClick={() => patch(current => ({
                        ...current, candidates: current.candidates.filter((_, at) => at !== index),
                      }))}>Remove</button>
                    </div>
                    <label className="dg-field-inline"><span>Name</span><input value={candidate.name} onChange={event => updateCandidate(index, { name: event.target.value })} /></label>
                    {candidate.kind === 'index' && <>
                      <label className="dg-field-inline"><span>Table</span><input value={candidate.table} onChange={event => updateCandidate(index, { table: event.target.value })} /></label>
                      <label className="dg-field-inline"><span>Columns (comma separated)</span><input value={candidate.columns.join(',')} onChange={event => updateCandidate(index, { columns: event.target.value.split(',').map(value => value.trim()) })} /></label>
                      <label className="dg-field-inline"><span>Unique</span><input type="checkbox" checked={candidate.unique} onChange={event => updateCandidate(index, { unique: event.target.checked })} /></label>
                      <label className="dg-field-inline"><span>Optional partial-index predicate</span><input value={candidate.where ?? ''} onChange={event => updateCandidate(index, { where: event.target.value || null })} /></label>
                    </>}
                    {candidate.kind === 'rewrite' && <label className="dg-field-inline" style={{ display: 'block' }}><span>Read-only rewrite SQL</span>
                      <textarea className="sqp-sql" rows={5} value={candidate.sql} spellCheck={false} onChange={event => updateCandidate(index, { sql: event.target.value })} />
                    </label>}
                    {candidate.kind === 'setting' && <label className="dg-field-inline"><span>Setting value</span><input value={candidate.value} onChange={event => updateCandidate(index, { value: event.target.value })} /></label>}
                  </div>
                ))}
                <button className="toolbar-btn" onClick={() => patch(current => ({
                  ...current,
                  candidates: [...current.candidates, { id: `rewrite-${current.candidates.length + 1}`, kind: 'rewrite', name: 'Candidate rewrite', sql: current.originalSql }],
                }))}>+ Add rewrite candidate</button>
              </section>
            </div>

            <div className="sqp-right">
              <section>
                <h3>Execution and evidence</h3>
                <label className="dg-field-inline"><span>Experiment mode</span>
                  <select value={experiment.executionMode} onChange={event => patch(current => ({
                    ...current, executionMode: event.target.value as QueryLabExperiment['executionMode'],
                  }))}>
                    <option value="estimate">Estimate — plans and cost only</option>
                    <option value="measured">Measured — explicit non-production scratch</option>
                  </select>
                </label>
                <label className="dg-field-inline"><span>Warmup runs (0–10)</span><input type="number" value={experiment.warmupRuns} onChange={event => patch(current => ({ ...current, warmupRuns: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Measured repetitions (1–30)</span><input type="number" value={experiment.repetitions} onChange={event => patch(current => ({ ...current, repetitions: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Server timeout ms (100–60000)</span><input type="number" value={experiment.timeoutMs} onChange={event => patch(current => ({ ...current, timeoutMs: Number(event.target.value) }))} /></label>
                <label className="dg-field-inline"><span>Improvement threshold %</span><input type="number" value={experiment.improvementThresholdPct} onChange={event => patch(current => ({ ...current, improvementThresholdPct: Number(event.target.value) }))} /></label>
                {([
                  ['plan', 'Estimated plans (required)'],
                  ['cost', 'Estimated cost'],
                  ['timing', 'Measured timing'],
                  ['buffers', 'Buffer reads'],
                  ['resultEquality', 'Result equality'],
                ] as const).map(([key, label]) => <label className="dg-field-inline" key={key}><span>{label}</span>
                  <input type="checkbox" checked={experiment.evidence[key]} onChange={event => updateEvidence(key, event.target.checked)} />
                </label>)}
              </section>

              <section>
                <h3>Scratch identity</h3>
                {experiment.scratch ? <>
                  <p className="dv-desc">Session {experiment.scratch.sessionId} · connection {experiment.scratch.connectionId} · database {experiment.scratch.database} · environment {experiment.scratch.environment ?? 'unspecified'} · {experiment.scratch.readOnly ? 'read-only' : 'writable'}.</p>
                  <p className="dv-desc">Measured mode requires this exact writable non-production identity and matching database. Estimate mode creates no real candidate objects.</p>
                </> : <p className="dv-desc">No scratch target is configured. Measured mode remains blocked.</p>}
              </section>

              <section>
                <h3>Specification proof</h3>
                <p className="dv-desc">Spec SHA-256: {specHash}</p>
                <button className="primary" onClick={validate}>Validate experiment</button>
                {errors.length > 0 ? <div className="mnt-warn"><StatusIcon kind="error" /><span>{errors.length} blockers; no database invocation is possible.</span></div>
                  : <div className="mnt-bulk-cost c-metadata"><StatusIcon kind="ok" /><span>Contract is valid. Validation is local only; baseline capture belongs to Q1.2.</span></div>}
                {errors.map(error => <div className="sqp-f-evidence" key={error}>{error}</div>)}
                {validated && <div>
                  <p className="dv-desc"><b>Validated without a database call.</b> {validated.candidates.length} candidates · {validated.executionMode} mode · {validated.warmupRuns} warmup + {validated.repetitions} measured runs · timeout {validated.timeoutMs} ms.</p>
                  <code className="sqp-f-snippet">{validated.resolvedSql}</code>
                </div>}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
