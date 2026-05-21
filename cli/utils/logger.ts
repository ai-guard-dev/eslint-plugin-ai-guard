import chalk from 'chalk';

// ── Category icon + color map ──────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  Security: '🔴',
  Reliability: '🟠',
  'Async Stability': '🟡',
  'AI Patterns': '🔵',
};

const CATEGORY_ORDER = ['Security', 'Reliability', 'Async Stability', 'AI Patterns'];

export { CATEGORY_ICONS, CATEGORY_ORDER };

// ── Rule → category map ────────────────────────────────────────────────────────

export const RULE_CATEGORY: Record<string, string> = {
  'ai-guard/no-empty-catch': 'Reliability',
  'ai-guard/no-broad-exception': 'Reliability',
  'ai-guard/no-catch-log-rethrow': 'Reliability',
  'ai-guard/no-catch-without-use': 'Reliability',
  'ai-guard/no-floating-promise': 'Async Stability',
  'ai-guard/no-await-in-loop': 'Async Stability',
  'ai-guard/no-async-array-callback': 'Async Stability',
  'ai-guard/no-async-without-await': 'Async Stability',
  'ai-guard/no-redundant-await': 'Async Stability',
  'ai-guard/no-hardcoded-secret': 'Security',
  'ai-guard/no-eval-dynamic': 'Security',
  'ai-guard/no-sql-string-concat': 'Security',
  'ai-guard/no-unsafe-deserialize': 'Security',
  'ai-guard/require-auth-middleware': 'Security',
  'ai-guard/require-authz-check': 'Security',
  'ai-guard/no-console-in-handler': 'AI Patterns',
  'ai-guard/no-duplicate-logic-block': 'AI Patterns',
  'ai-guard/no-dead-branch': 'AI Patterns',
};

const PREFIX = {
  success: chalk.green('✔'),
  error: chalk.red('✖'),
  warn: chalk.yellow('⚠'),
  info: chalk.cyan('ℹ'),
  section: chalk.bold.white,
  bullet: chalk.gray('•'),
};

export const log = {
  info(msg: string): void {
    console.log(`  ${PREFIX.info}  ${chalk.white(msg)}`);
  },

  success(msg: string): void {
    console.log(`  ${PREFIX.success}  ${chalk.green(msg)}`);
  },

  warn(msg: string): void {
    console.log(`  ${PREFIX.warn}  ${chalk.yellow(msg)}`);
  },

  error(msg: string): void {
    console.error(`  ${PREFIX.error}  ${chalk.red(msg)}`);
  },

  section(title: string): void {
    console.log('');
    console.log(chalk.bold.cyan(`  ── ${title} ──`));
    console.log('');
  },

  rule(ruleName: string, count: number): void {
    console.log(
      `    ${PREFIX.bullet} ${chalk.yellow(ruleName)} ${chalk.gray(`(${count} issue${count !== 1 ? 's' : ''})`)}`,
    );
  },

  file(filePath: string, count: number): void {
    console.log(
      `    ${PREFIX.bullet} ${chalk.white(filePath)} ${chalk.gray(`→ ${count} issue${count !== 1 ? 's' : ''}`)}`,
    );
  },

  issue(msg: string, severity: 1 | 2, line: number, col: number): void {
    const icon = severity === 2 ? chalk.red('error') : chalk.yellow(' warn');
    console.log(
      `      ${chalk.gray(`${line}:${col}`).padEnd(12)} ${icon}  ${chalk.white(msg)}`,
    );
  },

  /**
   * Print a category summary line with icon, label, and count.
   * e.g.  🔴 Security        3 errors · 0 warnings
   */
  category(icon: string, label: string, errors: number, warnings: number): void {
    const parts: string[] = [];
    if (errors > 0) parts.push(chalk.red(`${errors} error${errors !== 1 ? 's' : ''}`));
    if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
    const counts = parts.length > 0 ? parts.join(chalk.gray(' · ')) : chalk.gray('0');
    const labelPadded = label.padEnd(18);
    console.log(`  ${icon}  ${chalk.bold.white(labelPadded)} ${counts}`);
  },

  /**
   * Print the scan stats line: files scanned, duration, preset.
   */
  scanStats(filesScanned: number, filesWithIssues: number, durationMs: number, preset: string): void {
    console.log(
      `  ${chalk.gray('Files scanned:')}  ${chalk.white(String(filesScanned))}  ` +
      `${chalk.gray('·')}  ${chalk.gray('Issues in:')}  ${chalk.white(String(filesWithIssues))} file${filesWithIssues !== 1 ? 's' : ''}  ` +
      `${chalk.gray('·')}  ${chalk.gray('Duration:')}  ${chalk.white(durationMs + 'ms')}  ` +
      `${chalk.gray('·')}  ${chalk.gray('Preset:')}  ${chalk.cyan(preset)}`,
    );
  },

  divider(): void {
    console.log(chalk.gray('  ' + '─'.repeat(60)));
  },

  blank(): void {
    console.log('');
  },

  banner(title: string): void {
    console.log('');
    console.log(chalk.bold.bgCyan.black(`  ${title}  `));
    console.log('');
  },

  print(msg: string): void {
    console.log(msg);
  },

  debug(msg: string): void {
    if (process.env.AI_GUARD_DEBUG === '1') {
      console.log(`  ${chalk.gray('·')}  ${chalk.gray(msg)}`);
    }
  },
};
