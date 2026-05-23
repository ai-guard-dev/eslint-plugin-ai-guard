import chalk from 'chalk';
import type { EcosystemIssue, ParserError } from '../utils/eslint-runner.js';

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

// ── Confidence tiers ──────────────────────────────────────────────────────────
// high   = very low FP rate, high signal, should always be investigated
// medium = moderate confidence, context-dependent
// low    = style/suggestion level, may have intentional exceptions

export const CONFIDENCE_TIER: Record<string, 'high' | 'medium' | 'low'> = {
  // High confidence — near-zero false positive rate
  'ai-guard/no-hardcoded-secret': 'high',
  'ai-guard/no-eval-dynamic': 'high',
  'ai-guard/no-floating-promise': 'high',
  'ai-guard/no-empty-catch': 'high',
  // Medium confidence — context matters, usually valid
  'ai-guard/no-sql-string-concat': 'medium',
  'ai-guard/no-await-in-loop': 'medium',
  'ai-guard/require-auth-middleware': 'medium',
  'ai-guard/require-authz-check': 'medium',
  'ai-guard/no-catch-log-rethrow': 'medium',
  'ai-guard/no-catch-without-use': 'medium',
  'ai-guard/no-unsafe-deserialize': 'medium',
  // Low confidence — suggestions, may be intentional
  'ai-guard/no-async-without-await': 'low',
  'ai-guard/no-async-array-callback': 'low',
  'ai-guard/no-dead-branch': 'low',
  'ai-guard/no-broad-exception': 'low',
  'ai-guard/no-console-in-handler': 'low',
  'ai-guard/no-duplicate-logic-block': 'low',
  'ai-guard/no-redundant-await': 'low',
};

// ── Ecosystem issue fix suggestions ──────────────────────────────────────────

const ECOSYSTEM_FIX_HINTS: Record<string, string> = {
  'react-hooks/exhaustive-deps': 'npm install --save-dev eslint-plugin-react-hooks',
  'react-hooks/rules-of-hooks': 'npm install --save-dev eslint-plugin-react-hooks',
  '@typescript-eslint/': 'npm install --save-dev @typescript-eslint/eslint-plugin @typescript-eslint/parser',
  'import/': 'npm install --save-dev eslint-plugin-import',
  'jsx-a11y/': 'npm install --save-dev eslint-plugin-jsx-a11y',
  'prettier/': 'npm install --save-dev eslint-plugin-prettier',
};

function getEcosystemFix(ruleId: string | null): string | null {
  if (!ruleId) return null;
  for (const [prefix, fix] of Object.entries(ECOSYSTEM_FIX_HINTS)) {
    if (ruleId.startsWith(prefix)) return fix;
  }
  return null;
}

// ── Logger ────────────────────────────────────────────────────────────────────

const PREFIX = {
  success: chalk.green('✔'),
  error: chalk.red('✖'),
  warn: chalk.yellow('⚠'),
  info: chalk.cyan('ℹ'),
  section: chalk.bold.white,
  bullet: chalk.gray('•'),
  ecosystem: chalk.yellow('⚠'),
  parser: chalk.magenta('⚡'),
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

  /**
   * Ecosystem section — distinct styling to communicate it's NOT ai-guard output
   */
  ecosystemSection(title: string): void {
    console.log('');
    console.log(chalk.bold.yellow(`  ── ${title} ──`) + chalk.dim(' (not ai-guard findings)'));
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
   * Print an ESLint ecosystem issue (missing rule definition, foreign plugin rule, etc.)
   * with a clear disclaimer that this is NOT an ai-guard finding.
   */
  ecosystemIssue(issue: EcosystemIssue, count = 1): void {
    const ruleLabel = issue.ruleId ? chalk.yellow(issue.ruleId) : chalk.gray('(no rule id)');
    const typeLabel =
      issue.type === 'missing-rule'
        ? chalk.dim('[missing rule definition]')
        : issue.type === 'config-error'
        ? chalk.dim('[config error]')
        : chalk.dim('[foreign rule]');

    const countLabel = count > 1 ? chalk.gray(` × ${count}`) : '';

    console.log(`  ${PREFIX.ecosystem}  ${ruleLabel} ${typeLabel}${countLabel}`);
    console.log(`       ${chalk.gray('File:')} ${chalk.dim(issue.filePath)}${issue.line > 0 ? chalk.dim(`:${issue.line}`) : ''}`);
    console.log(`       ${chalk.gray('Msg:')}  ${chalk.dim(issue.message.slice(0, 120))}`);

    const fix = getEcosystemFix(issue.ruleId);
    if (fix) {
      console.log(`       ${chalk.cyan('→ Fix:')} ${chalk.yellow(fix)}`);
    }
    console.log(
      chalk.dim(`       Note: This comes from your ESLint config, not from ai-guard.`),
    );
    console.log('');
  },

  /**
   * Print a parser/syntax error — clearly NOT an ai-guard finding.
   */
  parserError(pe: ParserError): void {
    console.log(`  ${PREFIX.parser}  ${chalk.magenta('Parse failure')}  ${chalk.dim(pe.filePath)}${pe.line > 0 ? chalk.dim(`:${pe.line}`) : ''}`);
    console.log(`       ${chalk.dim(pe.message.slice(0, 120))}`);
    console.log('');
  },

  /**
   * Print a category summary line with icon, label, and count.
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
   * Print the scan stats line.
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
