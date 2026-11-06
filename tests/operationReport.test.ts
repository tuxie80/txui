import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOperationReport } from '../src/utils/operationReport.ts';
import type { OperationReport } from '../src/utils/operationReport.ts';

const report: OperationReport = {
  title: 'Migration rehearsal',
  subject: 'shop on rehearsal',
  outcome: 'incomplete',
  sections: [
    {
      heading: 'Deployment',
      facts: [{ label: 'Statements', value: 3 }, { label: 'Verified', value: false }, { label: 'Duration', value: null }],
      findings: [{ severity: 'warning', message: 'One index could not be compared' }],
      lines: ['2 statements completed', '1 statement not started'],
    },
  ],
  incompleteEvidence: ['The final index metadata was unavailable'],
};

test('report is deterministic and leads with incomplete evidence', () => {
  const expected = `# Migration rehearsal\n\n**Subject:** shop on rehearsal\n**Outcome:** incomplete\n\n## Incomplete evidence\n\n- The final index metadata was unavailable\n\n## Deployment\n\n| Fact | Value |\n|---|---|\n| Statements | 3 |\n| Verified | no |\n| Duration | not available |\n\n- **WARNING:** One index could not be compared\n\n- 2 statements completed\n- 1 statement not started\n`;
  assert.equal(renderOperationReport(report), expected);
  assert.equal(renderOperationReport(report), expected);
  assert.ok(renderOperationReport(report).indexOf('Incomplete evidence') < renderOperationReport(report).indexOf('## Deployment'));
});

test('report has no implicit timestamps, ids or row container', () => {
  const rendered = renderOperationReport(report);
  assert.doesNotMatch(rendered, /2026-|run id|sourceRows|targetRows/i);
  assert.equal('sourceRows' in report, false);
  assert.equal('targetRows' in report, false);
});

test('multiline values cannot forge report sections', () => {
  const rendered = renderOperationReport({
    ...report,
    sections: [{ heading: 'Summary\n## Forged', lines: ['first\nsecond'] }],
    incompleteEvidence: [],
  });
  assert.ok(rendered.includes('## Summary ## Forged'));
  assert.ok(rendered.includes('- first second'));
  assert.ok(!rendered.includes('\n## Forged\n'));
});
