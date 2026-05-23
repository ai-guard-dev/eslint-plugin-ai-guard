import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { runEslint, type RunResult } from '../utils/eslint-runner.js';
import { log } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReportData {
  projectName: string;
  version: string;
  generatedAt: string;
  preset: string;
  scannedPath: string;
  durationMs: number;
  totalIssues: number;
  totalErrors: number;
  totalWarnings: number;
  score: number;
  ruleBreakdown: Record<string, number>;
  topFiles: Array<{ path: string; count: number; errors: number; warnings: number }>;
  topRules: Array<{
    rule: string;
    count: number;
    description: string;
    category: string;
    example: { file: string; line: number; column: number; message: string } | null;
  }>;
  categoryBreakdown: Record<string, number>;
  // Confidence tier breakdown
  highCount: number;
  mediumCount: number;
  lowCount: number;
  ecosystemCount: number;
  parserErrorCount: number;
}

// ─── Rule Metadata ────────────────────────────────────────────────────────────

const RULE_META: Record<string, { description: string; category: string }> = {
  'ai-guard/no-empty-catch': { description: 'Empty catch blocks silently swallow errors', category: 'Reliability' },
  'ai-guard/no-broad-exception': { description: 'Catching all exceptions hides bugs', category: 'Reliability' },
  'ai-guard/no-catch-log-rethrow': { description: 'Catch-log-rethrow adds noise without context', category: 'Reliability' },
  'ai-guard/no-catch-without-use': { description: 'Caught error is not used', category: 'Reliability' },
  'ai-guard/no-floating-promise': { description: 'Unhandled promise can crash silently', category: 'Async Stability' },
  'ai-guard/no-await-in-loop': { description: 'Sequential await in loops is slow; use Promise.all', category: 'Async Stability' },
  'ai-guard/no-async-array-callback': { description: 'Async callbacks in .map()/.filter() return Promises', category: 'Async Stability' },
  'ai-guard/no-async-without-await': { description: 'Async function never uses await', category: 'Async Stability' },
  'ai-guard/no-redundant-await': { description: 'Redundant await in return position', category: 'Async Stability' },
  'ai-guard/no-hardcoded-secret': { description: 'Secrets should come from environment variables', category: 'Security' },
  'ai-guard/no-eval-dynamic': { description: 'eval() with dynamic input is a security risk', category: 'Security' },
  'ai-guard/no-sql-string-concat': { description: 'SQL string concatenation enables injection', category: 'Security' },
  'ai-guard/no-unsafe-deserialize': { description: 'JSON.parse on untrusted input without validation', category: 'Security' },
  'ai-guard/require-auth-middleware': { description: 'Route handler missing authentication middleware', category: 'Security' },
  'ai-guard/require-authz-check': { description: 'Missing authorization check for resource access', category: 'Security' },
  'ai-guard/no-console-in-handler': { description: 'console.log in route handlers should be a logger', category: 'AI Patterns' },
  'ai-guard/no-duplicate-logic-block': { description: 'Duplicate consecutive code blocks should be extracted', category: 'AI Patterns' },
  'ai-guard/no-dead-branch': { description: 'Always-true/false condition creates dead or unreachable code', category: 'AI Patterns' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProjectName(cwd: string): string {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
      if (pkg.name) return pkg.name;
    }
  } catch { /* fall through */ }
  return path.basename(cwd);
}

function getPluginVersion(cwd: string): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }
  try {
    const pkgPath = path.join(cwd, 'node_modules', 'eslint-plugin-ai-guard', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

function calculateScore(totalErrors: number, totalWarnings: number): number {
  // Errors cost 5 points each, warnings cost 2 points each, min 0
  const penalty = totalErrors * 5 + totalWarnings * 2;
  return Math.max(0, Math.min(100, 100 - penalty));
}

// ─── Report Data Builder ──────────────────────────────────────────────────────

export function buildReportData(
  result: RunResult,
  preset: string,
  scannedPath: string,
  cwd: string,
): ReportData {
  const projectName = getProjectName(cwd);
  const version = getPluginVersion(cwd);
  const score = calculateScore(result.totalErrors, result.totalWarnings);

  // Top files with error/warning breakdown
  const topFiles = result.files
    .sort((a, b) => b.issues.length - a.issues.length)
    .slice(0, 10)
    .map((f) => ({
      path: f.filePath,
      count: f.issues.length,
      errors: f.errorCount,
      warnings: f.warningCount,
    }));

  // Category breakdown
  const categoryBreakdown: Record<string, number> = {};
  for (const [rule, count] of result.ruleBreakdown.entries()) {
    const cat = RULE_META[rule]?.category ?? 'Other';
    categoryBreakdown[cat] = (categoryBreakdown[cat] ?? 0) + count;
  }

  // Top 5 rules with real examples
  const sortedRules = [...result.ruleBreakdown.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const topRules = sortedRules.map(([rule, count]) => {
    const meta = RULE_META[rule] ?? { description: 'Rule violation', category: 'Other' };

    // Find a real example from the codebase
    let example: { file: string; line: number; column: number; message: string } | null = null;
    for (const file of result.files) {
      const issue = file.issues.find((i) => i.ruleId === rule);
      if (issue) {
        example = {
          file: file.filePath,
          line: issue.line,
          column: issue.column,
          message: issue.message,
        };
        break;
      }
    }

    return {
      rule: rule.replace(/^ai-guard\//, ''),
      count,
      description: meta.description,
      category: meta.category,
      example,
    };
  });

  // Confidence tiers for display (computed from rule assignment)
  const CONFIDENCE_ASSIGNMENT: Record<string, 'high' | 'medium' | 'low'> = {
    'ai-guard/no-hardcoded-secret': 'high',
    'ai-guard/no-eval-dynamic': 'high',
    'ai-guard/no-floating-promise': 'high',
    'ai-guard/no-empty-catch': 'high',
    'ai-guard/no-sql-string-concat': 'medium',
    'ai-guard/no-await-in-loop': 'medium',
    'ai-guard/require-auth-middleware': 'medium',
    'ai-guard/require-authz-check': 'medium',
    'ai-guard/no-catch-log-rethrow': 'medium',
    'ai-guard/no-catch-without-use': 'medium',
    'ai-guard/no-unsafe-deserialize': 'medium',
    'ai-guard/no-async-without-await': 'low',
    'ai-guard/no-async-array-callback': 'low',
    'ai-guard/no-dead-branch': 'low',
    'ai-guard/no-broad-exception': 'low',
    'ai-guard/no-console-in-handler': 'low',
    'ai-guard/no-duplicate-logic-block': 'low',
    'ai-guard/no-redundant-await': 'low',
  };
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  for (const [rule, count] of result.ruleBreakdown.entries()) {
    const tier = CONFIDENCE_ASSIGNMENT[rule] ?? 'low';
    if (tier === 'high') highCount += count;
    else if (tier === 'medium') mediumCount += count;
    else lowCount += count;
  }
  const ecosystemCount = result.ecosystemIssues?.length ?? 0;
  const parserErrorCount = result.parserErrors?.length ?? 0;

  return {
    projectName,
    version,
    generatedAt: new Date().toISOString(),
    preset,
    scannedPath,
    durationMs: result.durationMs,
    totalIssues: result.totalIssues,
    totalErrors: result.totalErrors,
    totalWarnings: result.totalWarnings,
    score,
    ruleBreakdown: Object.fromEntries(result.ruleBreakdown),
    topFiles,
    topRules,
    categoryBreakdown,
    highCount,
    mediumCount,
    lowCount,
    ecosystemCount,
    parserErrorCount,
  };
}

// ─── HTML Template ────────────────────────────────────────────────────────────

export function generateHtml(data: ReportData): string {
  const scoreColor = data.score >= 80 ? '#10b981' : data.score >= 50 ? '#f59e0b' : '#ef4444';
  const scoreLabel = data.score >= 80 ? 'Great' : data.score >= 50 ? 'Needs Work' : 'Critical';
  const formattedDate = new Date(data.generatedAt).toLocaleString();

  const topFilesRows = data.topFiles.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:2rem;">No issues found</td></tr>`
    : data.topFiles.map((f) => {
        const heatColor = f.errors > 0
          ? `rgba(239,68,68,${Math.min(0.9, 0.2 + f.errors * 0.1)})`
          : `rgba(245,158,11,${Math.min(0.9, 0.2 + f.warnings * 0.05)})`;
        return `
          <tr style="border-bottom:1px solid #1f2937;">
            <td style="padding:0.75rem 1rem;font-family:monospace;font-size:0.8rem;color:#e5e7eb;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(f.path)}">${escHtml(f.path)}</td>
            <td style="padding:0.75rem 1rem;text-align:center;"><span style="background:${heatColor};border-radius:9999px;padding:0.2rem 0.7rem;font-weight:600;font-size:0.85rem;">${f.count}</span></td>
            <td style="padding:0.75rem 1rem;text-align:center;color:#f87171;">${f.errors}</td>
            <td style="padding:0.75rem 1rem;text-align:center;color:#fbbf24;">${f.warnings}</td>
          </tr>`;
      }).join('');

  const topRulesCards = data.topRules.length === 0
    ? `<div style="text-align:center;color:#6b7280;padding:2rem;">No rules fired — clean codebase!</div>`
    : data.topRules.map((r, i) => {
        const catColor: Record<string, string> = {
          'Reliability': '#ec4899', 'Async Stability': '#8b5cf6',
          'Security': '#ef4444', 'AI Patterns': '#14b8a6', Other: '#6b7280',
        };
        const color = catColor[r.category] ?? '#6b7280';
        const exampleHtml = r.example
          ? `<div style="margin-top:0.75rem;background:#0f172a;border-radius:0.5rem;padding:0.75rem;border-left:3px solid ${color};">
              <div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.35rem;">${escHtml(r.example.file)}:${r.example.line}:${r.example.column}</div>
              <code style="font-size:0.8rem;color:#f1f5f9;white-space:pre-wrap;word-break:break-all;">${escHtml(r.example.message)}</code>
            </div>`
          : '';
        return `
          <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;display:flex;flex-direction:column;gap:0.5rem;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
              <div style="display:flex;align-items:center;gap:0.75rem;">
                <span style="background:#1f2937;color:#9ca3af;font-size:0.75rem;padding:0.15rem 0.5rem;border-radius:9999px;">#${i + 1}</span>
                <code style="font-size:0.9rem;color:#f9fafb;font-weight:600;">${escHtml(r.rule)}</code>
              </div>
              <div style="display:flex;align-items:center;gap:0.5rem;">
                <span style="background:${color}22;color:${color};border:1px solid ${color}44;font-size:0.72rem;border-radius:9999px;padding:0.15rem 0.6rem;">${escHtml(r.category)}</span>
                <span style="background:#374151;color:#e5e7eb;font-size:0.8rem;border-radius:9999px;padding:0.2rem 0.7rem;font-weight:600;">${r.count}×</span>
              </div>
            </div>
            <p style="color:#9ca3af;font-size:0.85rem;margin:0;">${escHtml(r.description)}</p>
            ${exampleHtml}
          </div>`;
      }).join('');

  const categoryCards = Object.entries(data.categoryBreakdown).map(([cat, count]) => {
    const catColor: Record<string, string> = {
      'Reliability': '#ec4899', 'Async Stability': '#8b5cf6',
      'Security': '#ef4444', 'AI Patterns': '#14b8a6', Other: '#6b7280',
    };
    const color = catColor[cat] ?? '#6b7280';
    return `
      <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;display:flex;flex-direction:column;gap:0.5rem;">
        <div style="font-size:0.8rem;color:#9ca3af;">${escHtml(cat)}</div>
        <div style="font-size:2rem;font-weight:700;color:${color};">${count}</div>
        <div style="background:#1f2937;border-radius:9999px;height:4px;overflow:hidden;"><div style="background:${color};height:100%;width:${Math.min(100, (count / Math.max(data.totalIssues, 1)) * 100)}%;transition:width 0.8s ease;"></div></div>
      </div>`;
  }).join('');

  const cleanBanner = data.totalIssues === 0
    ? `<div style="background:#064e3b;border:1px solid #10b981;border-radius:1rem;padding:2rem;text-align:center;margin-bottom:2rem;">
        <div style="font-size:2.5rem;">🎉</div>
        <div style="font-size:1.5rem;font-weight:700;color:#10b981;margin:0.5rem 0;">Clean Codebase!</div>
        <div style="color:#6ee7b7;">No AI guard issues detected. Your code is production-ready.</div>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Guard Report — ${escHtml(data.projectName)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #030712; color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }
    @keyframes pulse-score { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
    @keyframes slide-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .card { animation: slide-in 0.4s ease both; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #111827; }
    ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
  </style>
</head>
<body>

<!-- ── Header ── -->
<header style="background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%);border-bottom:1px solid #1f2937;padding:2rem 2rem 1.5rem;">
  <div style="max-width:1100px;margin:0 auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;">
      <div>
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.4rem;">
          <span style="font-size:1.5rem;">🛡️</span>
          <span style="font-size:0.85rem;color:#818cf8;font-weight:600;letter-spacing:0.05em;">AI GUARD REPORT</span>
        </div>
        <h1 style="font-size:1.8rem;font-weight:700;color:#f9fafb;">${escHtml(data.projectName)}</h1>
        <p style="color:#6b7280;font-size:0.85rem;margin-top:0.25rem;">Scanned: <code style="color:#94a3b8;">${escHtml(data.scannedPath)}</code> · Preset: <code style="color:#94a3b8;">${escHtml(data.preset)}</code> · ${data.durationMs}ms</p>
      </div>
      <div style="text-align:center;">
        <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.75rem;letter-spacing:0.05em;">SIGNAL CONFIDENCE</div>
        <div style="display:flex;flex-direction:column;gap:0.4rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block;"></span>
            <span style="font-size:0.8rem;color:#f87171;font-weight:600;">${data.highCount} high-confidence</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>
            <span style="font-size:0.8rem;color:#fbbf24;font-weight:600;">${data.mediumCount} medium-confidence</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span style="width:8px;height:8px;border-radius:50%;background:#6b7280;display:inline-block;"></span>
            <span style="font-size:0.8rem;color:#9ca3af;font-weight:600;">${data.lowCount} suggestions</span>
          </div>
          ${data.ecosystemCount > 0 ? `<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.25rem;">
            <span style="font-size:0.75rem;color:#4b5563;">⚠ ${data.ecosystemCount} config issue${data.ecosystemCount !== 1 ? 's' : ''} (not ai-guard)</span>
          </div>` : ''}
        </div>
      </div>
    </div>
    <p style="color:#4b5563;font-size:0.75rem;margin-top:1rem;">Generated ${escHtml(formattedDate)}</p>
  </div>
</header>

<!-- ── Main ── -->
<main style="max-width:1100px;margin:0 auto;padding:2rem;">

  ${cleanBanner}

  <!-- Summary Cards -->
  <div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:2rem;">
    <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;">
      <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.5rem;">TOTAL ISSUES</div>
      <div style="font-size:2.5rem;font-weight:800;color:#f9fafb;">${data.totalIssues}</div>
    </div>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;">
      <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.5rem;">ERRORS</div>
      <div style="font-size:2.5rem;font-weight:800;color:#f87171;">${data.totalErrors}</div>
    </div>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;">
      <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.5rem;">WARNINGS</div>
      <div style="font-size:2.5rem;font-weight:800;color:#fbbf24;">${data.totalWarnings}</div>
    </div>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;">
      <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.5rem;">FILES AFFECTED</div>
      <div style="font-size:2.5rem;font-weight:800;color:#818cf8;">${data.topFiles.length}</div>
    </div>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1.25rem;">
      <div style="font-size:0.75rem;color:#6b7280;margin-bottom:0.5rem;">RULES FIRED</div>
      <div style="font-size:2.5rem;font-weight:800;color:#34d399;">${Object.keys(data.ruleBreakdown).length}</div>
    </div>
  </div>

  <!-- Issues by Category -->
  ${Object.keys(data.categoryBreakdown).length > 0 ? `
  <section class="card" style="margin-bottom:2rem;">
    <h2 style="font-size:1rem;font-weight:600;color:#e5e7eb;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem;">
      <span>📊</span> Issues by Category
    </h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;">
      ${categoryCards}
    </div>
  </section>` : ''}

  <!-- Severity Heatmap by File -->
  <section class="card" style="margin-bottom:2rem;">
    <h2 style="font-size:1rem;font-weight:600;color:#e5e7eb;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem;">
      <span>🔥</span> Severity Heatmap — Top Files
    </h2>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#0f172a;text-align:left;">
            <th style="padding:0.75rem 1rem;font-size:0.75rem;color:#6b7280;font-weight:500;letter-spacing:0.05em;">FILE</th>
            <th style="padding:0.75rem 1rem;font-size:0.75rem;color:#6b7280;font-weight:500;letter-spacing:0.05em;text-align:center;">ISSUES</th>
            <th style="padding:0.75rem 1rem;font-size:0.75rem;color:#6b7280;font-weight:500;letter-spacing:0.05em;text-align:center;">ERRORS</th>
            <th style="padding:0.75rem 1rem;font-size:0.75rem;color:#6b7280;font-weight:500;letter-spacing:0.05em;text-align:center;">WARNINGS</th>
          </tr>
        </thead>
        <tbody>
          ${topFilesRows}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Top 5 Rules -->
  <section class="card" style="margin-bottom:2rem;">
    <h2 style="font-size:1rem;font-weight:600;color:#e5e7eb;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem;">
      <span>⚡</span> Top Rules That Fired
    </h2>
    <div style="display:flex;flex-direction:column;gap:1rem;">
      ${topRulesCards}
    </div>
  </section>

  <!-- Next Steps -->
  <section class="card" style="margin-bottom:2rem;">
    <h2 style="font-size:1rem;font-weight:600;color:#e5e7eb;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem;">
      <span>🚀</span> Suggested Next Steps
    </h2>
    <div style="display:flex;flex-direction:column;gap:0.75rem;">
      <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1rem;display:flex;align-items:flex-start;gap:0.75rem;">
        <span style="font-size:1.2rem;flex-shrink:0;">🔧</span>
        <div>
          <div style="color:#f9fafb;font-size:0.9rem;font-weight:500;margin-bottom:0.2rem;">Auto-fix safe issues</div>
          <code style="color:#818cf8;font-size:0.8rem;">npx ai-guard run --fix</code>
        </div>
      </div>
      <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1rem;display:flex;align-items:flex-start;gap:0.75rem;">
        <span style="font-size:1.2rem;flex-shrink:0;">🤖</span>
        <div>
          <div style="color:#f9fafb;font-size:0.9rem;font-weight:500;margin-bottom:0.2rem;">Prevent future AI-generated issues</div>
          <code style="color:#818cf8;font-size:0.8rem;">npx ai-guard init-context</code>
        </div>
      </div>
      <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1rem;display:flex;align-items:flex-start;gap:0.75rem;">
        <span style="font-size:1.2rem;flex-shrink:0;">📋</span>
        <div>
          <div style="color:#f9fafb;font-size:0.9rem;font-weight:500;margin-bottom:0.2rem;">Save baseline &amp; track only new issues</div>
          <code style="color:#818cf8;font-size:0.8rem;">npx ai-guard baseline</code>
        </div>
      </div>
      <div style="background:#111827;border:1px solid #1f2937;border-radius:0.75rem;padding:1rem;display:flex;align-items:flex-start;gap:0.75rem;">
        <span style="font-size:1.2rem;flex-shrink:0;">📤</span>
        <div>
          <div style="color:#f9fafb;font-size:0.9rem;font-weight:500;margin-bottom:0.2rem;">Share this report with your team</div>
          <div style="color:#6b7280;font-size:0.8rem;">Send the <code style="color:#94a3b8;">ai-guard-report.html</code> file — it's fully self-contained.</div>
        </div>
      </div>
    </div>
  </section>

</main>

<!-- ── Footer ── -->
<footer style="border-top:1px solid #1f2937;padding:1.5rem 2rem;text-align:center;">
  <p style="color:#4b5563;font-size:0.8rem;">
    Generated by <a href="https://github.com/YashJadhav21/eslint-plugin-ai-guard" style="color:#818cf8;text-decoration:none;">eslint-plugin-ai-guard</a> v${escHtml(data.version)}
    &nbsp;·&nbsp;
    <a href="https://github.com/YashJadhav21/eslint-plugin-ai-guard" style="color:#818cf8;text-decoration:none;">GitHub</a>
  </p>
</footer>

</body>
</html>`;
}

// ─── Escape ───────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description(
      'Generate a beautiful HTML report of AI Guard scan results\n' +
      'Perfect for sharing with your team or in Slack.',
    )
    .option('--path <dir>', 'Directory or file to scan', '.')
    .option('--preset <preset>', 'Rule preset: recommended | strict | security', 'recommended')
    .option('--html', 'Generate HTML report (default behavior)')
    .option('--json', 'Output raw JSON to stdout instead of writing HTML')
    .option('--output <filename>', 'Output file name', 'ai-guard-report.html')
    .option('--no-open', 'Do not open the report in the browser after generating')
    .action(async (opts: {
      path: string;
      preset: string;
      html?: boolean;
      json?: boolean;
      output: string;
      open: boolean;
    }) => {
      const preset = (['recommended', 'strict', 'security'].includes(opts.preset)
        ? opts.preset
        : 'recommended') as 'recommended' | 'strict' | 'security';

      const spinner = opts.json
        ? null
        : ora({ text: 'Scanning…', color: 'cyan' }).start();

      let result: RunResult;
      try {
        result = await runEslint({ preset, targetPath: opts.path });
        spinner?.stop();
      } catch (err: unknown) {
        spinner?.stop();
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        process.exit(1);
        return;
      }

      const cwd = process.cwd();
      const reportData = buildReportData(result, preset, opts.path, cwd);

      // ── JSON mode ────────────────────────────────────────────────────────────

      if (opts.json) {
        console.log(JSON.stringify(reportData, null, 2));
        process.exit(0);
        return;
      }

      // ── HTML mode ────────────────────────────────────────────────────────────

      log.banner('AI GUARD REPORT');
      log.blank();

      const html = generateHtml(reportData);
      const outputPath = path.resolve(cwd, opts.output);

      fs.writeFileSync(outputPath, html, 'utf-8');

      log.success(`Report saved: ${opts.output}`);
      log.info(
        `Score: ${reportData.score}/100 · ${reportData.totalErrors} errors · ${reportData.totalWarnings} warnings`,
      );
      log.blank();

      // Open in browser
      if (opts.open !== false) {
        try {
          const { default: open } = await import('open').catch(() => {
            // open package may not be installed — fall back to platform commands
            return { default: null };
          });

          if (open) {
            await open(outputPath);
            log.info('Opened in your browser.');
          } else {
            // Fallback: use platform-native open command
            const { execSync } = await import('child_process');
            const cmd = process.platform === 'win32'
              ? `start "" "${outputPath}"`
              : process.platform === 'darwin'
              ? `open "${outputPath}"`
              : `xdg-open "${outputPath}"`;
            execSync(cmd);
            log.info('Opened in your browser.');
          }
        } catch {
          log.info(`Open manually: file://${outputPath}`);
        }
      } else {
        log.info(`Open: file://${outputPath}`);
      }

      log.blank();
    });
}
