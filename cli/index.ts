import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { registerRunCommand } from './commands/run.js';
import { registerChangedCommand } from './commands/changed.js';
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerPresetCommand } from './commands/preset.js';
import { registerIgnoreCommand } from './commands/ignore.js';
import { registerBaselineCommand } from './commands/baseline.js';
import { registerInitContextCommand } from './commands/init-context.js';
import { registerReportCommand } from './commands/report.js';
import { log } from './utils/logger.js';

// ─── Version resolution ───────────────────────────────────────────────────────

function getVersion(): string {
  try {
    // In the bundled CLI output, __dirname is available (CJS bundle).
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('ai-guard')
  .description(
    'Production-grade CLI for eslint-plugin-ai-guard\n' +
    'Catch AI-generated code issues instantly — no ESLint config required.\n\n' +
    'Quick start:\n' +
    '  npx ai-guard run          Scan current project\n' +
    '  npx ai-guard changed      Scan only changed files (CI mode)\n' +
    '  npx ai-guard init         Auto-configure ESLint\n' +
    '  npx ai-guard init-context Generate AI agent rules\n' +
    '  npx ai-guard report       Generate shareable HTML report\n' +
    '  npx ai-guard doctor       Check your setup\n' +
    '  npx ai-guard baseline     Save baseline, track new issues only',
  )
  .version(getVersion(), '-v, --version', 'Print version number')
  .helpOption('-h, --help', 'Show help');

// ─── Register commands ────────────────────────────────────────────────────────

registerRunCommand(program);
registerChangedCommand(program);
registerInitCommand(program);
registerDoctorCommand(program);
registerPresetCommand(program);
registerIgnoreCommand(program);
registerBaselineCommand(program);
registerInitContextCommand(program);
registerReportCommand(program);

// ─── Global error handling ────────────────────────────────────────────────────

program.configureOutput({
  writeErr(str) {
    // Strip commander's default "error: " prefix for cleaner output
    const cleaned = str.replace(/^error:\s*/i, '').trim();
    log.error(cleaned);
  },
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg =
    reason instanceof Error ? reason.message : String(reason);
  log.error(`Unexpected error: ${msg}`);
  log.info('If this looks like a bug, please report it at:');
  log.info('  https://github.com/ai-guard-dev/eslint-plugin-ai-guard/issues');
  process.exit(1);
});

process.on('SIGINT', () => {
  log.blank();
  log.info('Cancelled.');
  process.exit(0);
});

// ─── Parse args ───────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(msg);
  process.exit(1);
});
