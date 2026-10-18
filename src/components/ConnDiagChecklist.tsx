/**
 * The staged-diagnostics checklist (connect_test_staged) — six rows, one per
 * stage, with its status glyph and elapsed ms; every stage that has something
 * to say says it under its row, the failing one in red. Shared by the
 * connection form's Test and the sidebar's Test / Diagnose / unreachable
 * click — one shape, so "where did it break" reads the same everywhere.
 */
import type { StagedConnectResult } from '../utils/connDiag';
import { stageGlyph, verdictLine } from '../utils/connDiag';

export function ConnDiagChecklist({ result }: { result: StagedConnectResult }) {
  return (
    <div className="conn-diag">
      {result.stages.map(s => (
        <div key={s.id} className={`conn-diag-row conn-diag-${s.status}`}>
          <span className="conn-diag-icon" aria-hidden>{stageGlyph(s.status)}</span>
          <span className="conn-diag-label">{s.label}</span>
          <span className="conn-diag-ms">{s.status === 'skipped' ? '—' : `${s.ms} ms`}</span>
          {s.detail && <div className="conn-diag-detail">{s.detail}</div>}
        </div>
      ))}
      <div className={`conn-diag-total conn-diag-${result.verdict}`}>{verdictLine(result)}</div>
    </div>
  );
}
