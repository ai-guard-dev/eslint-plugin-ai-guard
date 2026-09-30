import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { log } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    PostToolUse?: ClaudeHookMatcher[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AI_GUARD_HOOK_COMMAND = 'node_modules/.bin/ai-guard claude-hook';
const AI_GUARD_HOOK_MATCHER = 'Edit|Write';
const SETTINGS_DIR = '.claude';
const SETTINGS_FILE = 'settings.json';
const SETTINGS_LOCAL_FILE = 'settings.local.json';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if a hook entry is an AI Guard hook.
 */
function isAiGuardHook(hook: ClaudeHookEntry): boolean {
  return (
    hook.type === 'command' &&
    typeof hook.command === 'string' &&
    hook.command.includes('ai-guard') &&
    hook.command.includes('claude-hook')
  );
}

/**
 * Check if a matcher block already contains an AI Guard hook.
 */
function matcherHasAiGuard(matcher: ClaudeHookMatcher): boolean {
  return Array.isArray(matcher.hooks) && matcher.hooks.some(isAiGuardHook);
}

/**
 * Read and parse Claude settings JSON. Returns null if file doesn't exist.
 * Throws on malformed JSON with a helpful message.
 */
export function readClaudeSettings(settingsPath: string): ClaudeSettings | null {
  if (!fs.existsSync(settingsPath)) {
    return null;
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8').trim();
  if (raw === '') {
    return {};
  }

  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse ${settingsPath}: ${msg}\n` +
      'Fix the JSON syntax or remove the file, then re-run this command.',
    );
  }
}

/**
 * Write Claude settings JSON with readable formatting.
 */
export function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): void {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Merge the AI Guard PostToolUse hook into existing settings.
 * Returns { settings, changed } where changed indicates if modification was needed.
 */
export function mergeAiGuardHook(
  settings: ClaudeSettings,
): { settings: ClaudeSettings; changed: boolean } {
  // Deep-clone to avoid mutation
  const result: ClaudeSettings = JSON.parse(JSON.stringify(settings));

  // Ensure hooks object exists
  if (!result.hooks || typeof result.hooks !== 'object') {
    result.hooks = {};
  }

  // Ensure PostToolUse array exists
  if (!Array.isArray(result.hooks.PostToolUse)) {
    result.hooks.PostToolUse = [];
  }

  // Check if an Edit|Write matcher with our hook already exists
  const existingMatcher = result.hooks.PostToolUse.find(
    (m) => m.matcher === AI_GUARD_HOOK_MATCHER && matcherHasAiGuard(m),
  );

  if (existingMatcher) {
    // Already configured — no changes needed
    return { settings: result, changed: false };
  }

  // Check if there's an Edit|Write matcher WITHOUT our hook
  const editWriteMatcher = result.hooks.PostToolUse.find(
    (m) => m.matcher === AI_GUARD_HOOK_MATCHER,
  );

  const aiGuardHook: ClaudeHookEntry = {
    type: 'command',
    command: AI_GUARD_HOOK_COMMAND,
  };

  if (editWriteMatcher) {
    // Append our hook to the existing matcher's hooks array
    if (!Array.isArray(editWriteMatcher.hooks)) {
      editWriteMatcher.hooks = [];
    }
    editWriteMatcher.hooks.push(aiGuardHook);
  } else {
    // Create a new matcher entry
    result.hooks.PostToolUse.push({
      matcher: AI_GUARD_HOOK_MATCHER,
      hooks: [aiGuardHook],
    });
  }

  return { settings: result, changed: true };
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerInitClaudeCommand(program: Command): void {
  program
    .command('init-claude')
    .description('Configure Claude Code PostToolUse hook for AI Guard validation')
    .option('--dry-run', 'Preview what would change without writing any files')
    .option('--local', 'Write to .claude/settings.local.json instead of settings.json')
    .action((opts: { dryRun?: boolean; local?: boolean }) => {
      const cwd = process.cwd();
      const isDryRun = opts.dryRun === true;
      const useLocal = opts.local === true;

      const settingsFileName = useLocal ? SETTINGS_LOCAL_FILE : SETTINGS_FILE;
      const settingsPath = path.join(cwd, SETTINGS_DIR, settingsFileName);
      const relPath = path.join(SETTINGS_DIR, settingsFileName);

      log.banner('AI GUARD × CLAUDE CODE');

      if (isDryRun) {
        log.print(`  ${chalk.yellow('⚑  DRY RUN — no files will be written')}`);
        log.blank();
      }

      // ── Step 1: Check for local AI Guard binary ────────────────────────────

      log.section('Prerequisites');

      const localBin = path.join(cwd, 'node_modules', '.bin', 'ai-guard');
      const localBinCmd = path.join(cwd, 'node_modules', '.bin', 'ai-guard.cmd');
      const hasLocalBin = fs.existsSync(localBin) || fs.existsSync(localBinCmd);

      if (hasLocalBin) {
        log.success('AI Guard binary found in node_modules');
      } else {
        log.warn('AI Guard binary not found in node_modules/.bin/');
        log.blank();
        log.print(`  ${chalk.bold('Install it first:')}`);
        log.print(`    ${chalk.cyan('npm install --save-dev eslint-plugin-ai-guard')}`);
        log.blank();
        log.print(`  Then re-run ${chalk.cyan('ai-guard init-claude')}`);
        log.blank();
        process.exit(1);
        return;
      }

      // ── Step 2: Read existing settings ─────────────────────────────────────

      log.section('Configuration');

      let existingSettings: ClaudeSettings;

      try {
        const parsed = readClaudeSettings(settingsPath);
        if (parsed !== null) {
          existingSettings = parsed;
          log.info(`Found existing ${chalk.white(relPath)}`);
        } else {
          existingSettings = {};
          log.info(`No existing ${chalk.white(relPath)} — will create one`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(msg);
        log.blank();
        process.exit(1);
        return;
      }

      // ── Step 3: Merge hook ──────────────────────────────────────────────────

      const { settings: merged, changed } = mergeAiGuardHook(existingSettings);

      if (!changed) {
        log.success('AI Guard PostToolUse hook is already configured');
        log.blank();
        log.print(`  ${chalk.gray('No changes needed. The hook is already present in')} ${chalk.white(relPath)}`);
        log.blank();
        process.exit(0);
        return;
      }

      // ── Step 4: Write settings ─────────────────────────────────────────────

      if (isDryRun) {
        log.print(`  ${chalk.gray('[dry-run] would write:')} ${chalk.white(relPath)}`);
        log.blank();
        log.print(chalk.gray('─── Preview ─────────────────────────────────────────────'));
        log.blank();
        const preview = JSON.stringify(merged, null, 2);
        for (const line of preview.split('\n')) {
          log.print(chalk.gray(`  ${line}`));
        }
        log.blank();
        log.print(`  ${chalk.yellow('Dry run complete — no files written.')}`);
        log.print(`  Re-run without ${chalk.cyan('--dry-run')} to apply.`);
        log.blank();
        process.exit(0);
        return;
      }

      writeClaudeSettings(settingsPath, merged);
      log.success(`Wrote ${chalk.white(relPath)}`);

      // ── Step 5: Summary ────────────────────────────────────────────────────

      log.section('Setup Complete');
      log.blank();
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('Hook type:')} ${chalk.cyan('PostToolUse')}`);
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('Matcher:')} ${chalk.cyan(AI_GUARD_HOOK_MATCHER)}`);
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('Command:')} ${chalk.cyan(AI_GUARD_HOOK_COMMAND)}`);
      log.print(`  ${chalk.green('✔')}  ${chalk.bold('Settings:')} ${chalk.cyan(relPath)}`);
      log.blank();
      log.info('When Claude Code edits a JS/TS file, AI Guard will automatically');
      log.info('scan it for hardcoded secrets, unsafe eval, empty catches, and SQL injection.');
      log.blank();
      log.print(`  ${chalk.gray('Rules enabled (agent preset):')}`);
      log.print(`    ${chalk.yellow('•')} no-hardcoded-secret  ${chalk.gray('(high confidence)')}`);
      log.print(`    ${chalk.yellow('•')} no-eval-dynamic      ${chalk.gray('(high confidence)')}`);
      log.print(`    ${chalk.yellow('•')} no-empty-catch       ${chalk.gray('(high confidence)')}`);
      log.print(`    ${chalk.yellow('•')} no-sql-string-concat ${chalk.gray('(medium confidence)')}`);
      log.print(`    ${chalk.yellow('•')} no-floating-promise  ${chalk.gray('(high confidence)')}`);
      log.blank();
      log.info(`To remove: delete the AI Guard hook entry from ${chalk.cyan(relPath)}`);
      log.blank();
    });
}
