export interface OperationFact {
  label: string;
  value: string | number | boolean | null;
}

export interface OperationFinding {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface OperationReportSection {
  heading: string;
  facts?: OperationFact[];
  findings?: OperationFinding[];
  lines?: string[];
}

export interface OperationReport {
  title: string;
  subject: string;
  outcome: 'completed' | 'failed' | 'cancelled' | 'incomplete';
  sections: OperationReportSection[];
  incompleteEvidence: string[];
}

function text(value: string | number | boolean | null): string {
  if (value === null) return 'not available';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderOperationReport(report: OperationReport): string {
  const lines = [
    `# ${singleLine(report.title)}`,
    '',
    `**Subject:** ${singleLine(report.subject)}`,
    `**Outcome:** ${report.outcome}`,
  ];
  if (report.incompleteEvidence.length) {
    lines.push('', '## Incomplete evidence', '');
    for (const reason of report.incompleteEvidence) lines.push(`- ${singleLine(reason)}`);
  }
  for (const section of report.sections) {
    lines.push('', `## ${singleLine(section.heading)}`);
    if (section.facts?.length) {
      lines.push('', '| Fact | Value |', '|---|---|');
      for (const fact of section.facts) {
        lines.push(`| ${singleLine(fact.label)} | ${singleLine(text(fact.value))} |`);
      }
    }
    if (section.findings?.length) {
      lines.push('');
      for (const finding of section.findings) {
        lines.push(`- **${finding.severity.toUpperCase()}:** ${singleLine(finding.message)}`);
      }
    }
    if (section.lines?.length) {
      lines.push('');
      for (const line of section.lines) lines.push(`- ${singleLine(line)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
