/**
 * Prompt for `:name` query variables before execution.
 * Last-used values are remembered per connection.
 */
import { useEffect, useState } from 'react';
import type { VarValue } from '../utils/sqlVars';
import { looksNumeric } from '../utils/sqlVars';

interface Props {
  connectionId: string;
  variables: string[];
  onRun: (values: Record<string, VarValue>) => void;
  onCancel: () => void;
}

const memKey = (connectionId: string) => `dbgui.vars.${connectionId}`;

function loadRemembered(connectionId: string): Record<string, VarValue> {
  try {
    return JSON.parse(localStorage.getItem(memKey(connectionId)) ?? '{}');
  } catch {
    return {};
  }
}

export function VariablePrompt({ connectionId, variables, onRun, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, VarValue>>(() => {
    const remembered = loadRemembered(connectionId);
    const init: Record<string, VarValue> = {};
    for (const v of variables) {
      init[v] = remembered[v] ?? { value: '', raw: false };
    }
    return init;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function update(name: string, patch: Partial<VarValue>) {
    setValues(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  }

  function run() {
    try {
      const remembered = { ...loadRemembered(connectionId), ...values };
      localStorage.setItem(memKey(connectionId), JSON.stringify(remembered));
    } catch { /* quota */ }
    onRun(values);
  }

  return (
    <div className="cv-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="vp-modal">
        <div className="cv-header">
          <span className="cv-title">Query variables</span>
          <span className="cv-len">{variables.length}</span>
        </div>
        <div className="vp-body">
          {variables.map((name, i) => (
            <div key={name} className="vp-row">
              <label className="vp-name">:{name}</label>
              <input
                autoFocus={i === 0}
                value={values[name]?.value ?? ''}
                onChange={e => update(name, {
                  value: e.target.value,
                  raw: values[name]?.raw || looksNumeric(e.target.value),
                })}
                onKeyDown={e => { if (e.key === 'Enter') run(); }}
                placeholder="value"
              />
              <label className="gsp-check" title="Insert as-is, without quotes (numbers, NULL, expressions)">
                <input
                  type="checkbox"
                  checked={values[name]?.raw ?? false}
                  onChange={e => update(name, { raw: e.target.checked })}
                /> raw
              </label>
            </div>
          ))}
        </div>
        <div className="vp-actions">
          <button className="toolbar-btn" onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={run}>▶ Run</button>
        </div>
      </div>
    </div>
  );
}
