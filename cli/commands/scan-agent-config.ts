/**
 * scan-agent-config.ts — ai-guard scan-agent-config command.
 *
 * Scans agent instruction files (CLAUDE.md, AGENTS.md, .cursorrules, Copilot
 * instructions, skills, commands) and agent configuration (MCP configs, Claude
 * settings, plugin hooks) for hidden text, prompt-injection payloads, unpinned
 * MCP servers and inline secrets.
 *
 * Usage:
 *   ai-guard scan-agent-config                  # scan the current repository
 *   ai-guard scan-agent-config --json           # machine-readable report
 *   ai-guard scan-agent-config --sarif          # SARIF for GitHub Code Scanning
 *   ai-guard scan-agent-config --update-lock    # approve current MCP servers
 */

import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { scanAgentConfig, DEFAULT_LOCK_FILE, type AgentConfigReport } from '../utils/agent-config.js';
import { buildSarifLog, sarifToJson } from '../utils/sarif.js';
import { emitGitHubAnnotations } from '../utils/github-summary.js';
import { isGitHubActions } from '../utils/git-diff.js';
import { PKG_VERSION } from '../utils/version.js';
import type { RunResult, FileResult } from '../utils/eslint-runner.js';

/** Code Scanning slot for this scan. Separate from the main "ai-guard" slot so uploads never replace code findings. */
export const AGENT_CONFIG_AUTOMATION_ID = 'ai-guard-agent-config';

/** Adapts the report to the RunResult shape used by SARIF and GitHub annotations. */
export function agentConfigToRunResult(report: AgentConfigReport): RunResult {
  const byFile = new Map<string, FileResult>();
  for (const finding of report.findings) {
    const filePath = path.join(report.root, finding.file);
    let file = byFile.get(filePath);
    if (!file) {
      file = { filePath, issues: [], errorCount: 0, warningCount: 0 };
      byFile.set(filePath, file);
    }
    const severity = finding.severity === 'error' ? 2 : 1;
    file.issues.push({
      ruleId: `ai-guard/agent-config/${finding.check}`,
      severity,
      message: finding.excerpt ? `${finding.message} (${finding.excerpt})` : finding.message,
      line: finding.line,
      column: finding.column,
    });
    if (severity === 2) file.errorCount++;
    else file.warningCount++;
  }
  const files = [...byFile.values()];
  const ruleBreakdown = new Map<string, number>();
  for (const f of report.findings) {
    const id = `ai-guard/agent-config/${f.check}`;
    ruleBreakdown.set(id, (ruleBreakdown.get(id) ?? 0) + 1);
  }
  return {
    files,
    totalErrors: report.errorCount,
    totalWarnings: report.warningCount,
    totalIssues: report.findings.length,
    filesScanned: report.files.length,
    ruleBreakdown,
    topFiles: files.map((f) => ({ path: f.filePath, count: f.issues.length })).sort((a, b) => b.count - a.count).slice(0, 5),
    durationMs: report.durationMs,
    ecosystemIssues: [],
    parserErrors: [],
    ignoredFiles: [],
    tsParserAvailable: true,
  };
}

export function agentConfigExitCode(report: AgentConfigReport, failOn: string): number {
  if (failOn === 'none') return 0;
  if (failOn === 'warning' || failOn === 'warnings' || failOn === 'any') return report.findings.length > 0 ? 1 : 0;
  return report.errorCount > 0 ? 1 : 0;
}

function printReport(report: AgentConfigReport): void {
  const fileCount = report.files.length;
  log.print(`  ${chalk.bold('Agent config')}  ${chalk.gray('·')}  ${fileCount} file${fileCount !== 1 ? 's' : ''} scanned  ${chalk.gray('·')}  ` +
    `${report.errorCount > 0 ? chalk.red(`${report.errorCount} error${report.errorCount !== 1 ? 's' : ''}`) : chalk.green('0 errors')}  ${chalk.gray('·')}  ` +
    `${report.warningCount > 0 ? chalk.yellow(`${report.warningCount} warning${report.warningCount !== 1 ? 's' : ''}`) : '0 warnings'}`);
  log.blank();

  if (fileCount === 0) {
    log.info('No agent instruction or MCP config files found.');
    log.blank();
    return;
  }

  if (report.findings.length === 0) {
    log.success('No issues in agent instructions or MCP configuration');
    log.blank();
  } else {
    let current = '';
    for (const finding of report.findings) {
      if (finding.file !== current) {
        current = finding.file;
        log.blank();
        log.print(`  ${chalk.white.underline(current)}`);
      }
      const level = finding.severity === 'error' ? chalk.red('error') : chalk.yellow('warn ');
      const where = chalk.gray(`${finding.line}:${finding.column}`.padEnd(8));
      log.print(`    ${where} ${level}  ${finding.message} ${chalk.gray(finding.check)}`);
      if (finding.excerpt) log.print(`             ${chalk.gray('> ' + finding.excerpt)}`);
    }
    log.blank();
  }

  if (report.servers.length > 0) {
    log.section('MCP servers');
    for (const server of report.servers) {
      const pin = server.pinned === undefined ? chalk.gray('local') : server.pinned ? chalk.green('pinned') : chalk.yellow('unpinned');
      const launch = server.launch.length > 60 ? `${server.launch.slice(0, 57)}...` : server.launch;
      log.print(`    ${chalk.white(server.name.padEnd(18))} ${pin.padEnd(18)} ${chalk.gray(server.fingerprint)}  ${chalk.gray(server.file)}  ${launch}`);
    }
    log.blank();
    if (report.lock.status === 'not-found') {
      log.info(`Run ${chalk.cyan('ai-guard scan-agent-config --update-lock')} to approve these servers; later scans then report any change.`);
    } else if (report.lock.status === 'updated') {
      log.success(`Wrote ${report.lock.file} with ${report.servers.length} approved server fingerprint${report.servers.length !== 1 ? 's' : ''}`);
    }
    log.blank();
  }
}

export function registerScanAgentConfigCommand(program: Command): void {
  program
    .command('scan-agent-config')
    .description('Scan agent instructions (CLAUDE.md, AGENTS.md, .cursorrules, skills) and MCP/agent config for hidden text, prompt injection, unpinned servers and inline secrets')
    .option('--path <dir>', 'Directory to scan', '.')
    .option('--json', 'Output the report as JSON')
    .option('--sarif', 'Output SARIF 2.1.0 (automationDetails.id "ai-guard-agent-config")')
    .option('--sarif-output <file>', 'Write SARIF to this file')
    .option('--fail-on <level>', 'Exit 1 on: error (default) | warning | none', 'error')
    .option('--lock <file>', `MCP server lock file, relative to --path (default ${DEFAULT_LOCK_FILE})`)
    .option('--update-lock', 'Approve the current MCP servers by writing their fingerprints to the lock file')
    .action((opts: { path: string; json?: boolean; sarif?: boolean; sarifOutput?: string; failOn: string; lock?: string; updateLock?: boolean }) => {
      const root = path.resolve(opts.path);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        log.error(`Not a directory: ${opts.path}`);
        process.exit(2);
        return;
      }
      if (!['error', 'errors', 'warning', 'warnings', 'any', 'none'].includes(opts.failOn)) {
        log.error(`Unknown --fail-on level '${opts.failOn}'. Use error, warning or none.`);
        process.exit(2);
        return;
      }

      const report = scanAgentConfig({ root, lockFile: opts.lock, updateLock: opts.updateLock });
      const exitCode = agentConfigExitCode(report, opts.failOn);
      const machineOutput = opts.json || (opts.sarif && !opts.sarifOutput);

      if (isGitHubActions()) emitGitHubAnnotations(agentConfigToRunResult(report), machineOutput ? process.stderr : process.stdout);

      if (opts.sarif) {
        const sarif = sarifToJson(buildSarifLog(agentConfigToRunResult(report), PKG_VERSION, process.env.GITHUB_WORKSPACE ?? root, AGENT_CONFIG_AUTOMATION_ID));
        if (opts.sarifOutput) fs.writeFileSync(opts.sarifOutput, sarif, 'utf8');
        else process.stdout.write(sarif + '\n');
        if (!opts.json) {
          process.exit(exitCode);
          return;
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({ version: PKG_VERSION, ...report }, null, 2) + '\n');
        process.exit(exitCode);
        return;
      }

      log.banner('AI GUARD');
      printReport(report);
      process.exit(exitCode);
    });
}
