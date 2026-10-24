/**
 * Renderings of one IntegrityEnvelope: terminal, JSON, Markdown summary,
 * GitHub annotations, SARIF and Claude feedback. Every output reads the same
 * findings array, so they cannot disagree.
 */

import { INTEGRITY_RULES, type IntegrityEnvelope, type IntegrityFinding, type IntegrityReport } from './types.js';

export function baseLabel(report: IntegrityReport): string {
  const commit = report.base.commit ? ` (${report.base.commit.slice(0, 12)})` : '';
  const head = report.base.head === 'index' ? 'staged changes' : 'working tree';
  return `${report.base.ref}${commit} → ${head}`;
}

function location(f: IntegrityFinding): string {
  return f.line ? `${f.file}:${f.line}` : f.file;
}

function change(f: IntegrityFinding): string {
  if (f.before !== undefined && f.after !== undefined) return `${f.before} → ${f.after}`;
  return '';
}

export function counts(report: IntegrityReport): { high: number; advisory: number } {
  const high = report.findings.filter((f) => f.tier === 'high').length;
  return { high, advisory: report.findings.length - high };
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

export function integrityJson(envelope: IntegrityEnvelope): Record<string, unknown> {
  if (!envelope.report) return { mode: envelope.mode, error: envelope.error };
  const { high, advisory } = counts(envelope.report);
  return {
    mode: envelope.mode,
    base: envelope.report.base,
    filesAnalyzed: envelope.report.filesAnalyzed,
    highCount: high,
    advisoryCount: advisory,
    blocking: envelope.mode === 'enforce' && high > 0,
    accepted: envelope.report.accepted,
    findings: envelope.report.findings,
    errors: envelope.report.errors,
  };
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

/** Plain lines (no colour); callers add styling. */
export function integrityTextLines(envelope: IntegrityEnvelope): string[] {
  const lines: string[] = [];
  if (!envelope.report) {
    lines.push(`Check integrity could not run: ${envelope.error?.message ?? 'unknown error'}`);
    return lines;
  }
  const r = envelope.report;
  const { high, advisory } = counts(r);
  lines.push(`Compared ${baseLabel(r)} · ${r.filesAnalyzed} relevant file(s) · mode: ${envelope.mode}`);
  if (r.findings.length === 0) {
    lines.push('No weakened checks found.');
  } else {
    lines.push(`${high} high-confidence, ${advisory} advisory finding(s)${envelope.mode === 'enforce' && high > 0 ? ' — high-confidence findings fail this check' : ''}`);
    for (const f of r.findings) {
      const tag = f.tier === 'high' ? 'HIGH    ' : 'advisory';
      lines.push(`  ${tag}  ${location(f)}  ${f.ruleId.replace('ai-guard/', '')}  #${f.fingerprint.slice(0, 12)}`);
      lines.push(`            ${f.message}`);
    }
  }
  if (r.accepted > 0) lines.push(`${r.accepted} finding(s) accepted in the baseline file are not shown.`);
  for (const e of r.errors) lines.push(`  note: ${e.file ? `${e.file}: ` : ''}${e.message}`);
  return lines;
}

// ─── Markdown (GitHub step summary) ───────────────────────────────────────────

function md(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function integrityMarkdown(envelope: IntegrityEnvelope): string {
  const lines: string[] = ['### Check integrity', ''];
  if (!envelope.report) {
    lines.push(`> ⚠️ Could not run: ${md(envelope.error?.message ?? 'unknown error')}`, '');
    return lines.join('\n');
  }
  const r = envelope.report;
  const { high, advisory } = counts(r);
  lines.push(`> Compared \`${md(baseLabel(r))}\` · mode **${envelope.mode}**`);
  if (r.accepted > 0) lines.push(`> ${r.accepted} accepted finding(s) not shown`);
  lines.push('');
  if (r.findings.length === 0) {
    lines.push('✅ No weakened checks found.', '');
    return lines.join('\n');
  }
  lines.push(`**${high} high-confidence**, ${advisory} advisory${envelope.mode === 'enforce' && high > 0 ? ' — high-confidence findings fail this check' : ''}`, '');
  lines.push('| Tier | Location | Finding | Change |', '|------|----------|---------|--------|');
  for (const f of r.findings.slice(0, 50)) {
    lines.push(`| ${f.tier === 'high' ? '🔴 high' : '⚪ advisory'} | \`${md(location(f))}\` | ${md(f.message)} | ${md(change(f))} |`);
  }
  if (r.findings.length > 50) lines.push('', `…and ${r.findings.length - 50} more (see JSON or SARIF output).`);
  lines.push('');
  return lines.join('\n');
}

// ─── GitHub annotations ───────────────────────────────────────────────────────

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function emitIntegrityAnnotations(envelope: IntegrityEnvelope | undefined, stream: Pick<NodeJS.WriteStream, 'write'>): void {
  if (!envelope?.report || process.env.GITHUB_ACTIONS !== 'true') return;
  for (const f of envelope.report.findings) {
    const level = f.tier === 'advisory' ? 'notice' : envelope.mode === 'enforce' ? 'error' : 'warning';
    const parts = [`file=${escapeProperty(f.file)}`];
    if (f.line) parts.push(`line=${f.line}`);
    parts.push(`title=${escapeProperty(f.ruleId)}`);
    stream.write(`::${level} ${parts.join(',')}::${escapeData(f.message)}\n`);
  }
}

// ─── SARIF ────────────────────────────────────────────────────────────────────

export interface IntegritySarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string; markdown: string };
  helpUri: string;
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
  properties: { tags: string[]; category: string; aiGuardIntegrity: true };
}

const DOCS = 'https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/integrity.md';

export function integritySarifRules(ruleIds: string[]): IntegritySarifRule[] {
  return ruleIds.map((id) => {
    const meta = INTEGRITY_RULES[id];
    return {
      id,
      shortDescription: { text: meta.title },
      fullDescription: { text: `${meta.title}: a change relative to the base revision weakens a check.` },
      help: { text: meta.remediation, markdown: `**${meta.title}**\n\n**Fix:** ${meta.remediation}\n\n[Check-integrity documentation](${DOCS})` },
      helpUri: DOCS,
      defaultConfiguration: { level: 'warning' },
      properties: { tags: ['ai-guard', 'integrity', meta.category], category: 'Check Integrity', aiGuardIntegrity: true },
    };
  });
}

export function sarifLevelFor(f: IntegrityFinding, mode: IntegrityEnvelope['mode']): 'error' | 'warning' | 'note' {
  if (f.tier === 'advisory') return 'note';
  return mode === 'enforce' ? 'error' : 'warning';
}

// ─── Claude Code feedback ─────────────────────────────────────────────────────

/** Concise, actionable text for an agent: what changed, where, and how to resolve it. */
export function formatFindingsForAgent(findings: IntegrityFinding[], max = 10): string {
  const lines: string[] = [];
  for (const f of findings.slice(0, max)) {
    lines.push(`- ${location(f)} [${f.ruleId.replace('ai-guard/', '')}] ${f.message}`);
    lines.push(`  Fix: ${f.remediation}`);
  }
  if (findings.length > max) lines.push(`- …and ${findings.length - max} more (run \`npx ai-guard integrity\` for the full list).`);
  return lines.join('\n');
}
