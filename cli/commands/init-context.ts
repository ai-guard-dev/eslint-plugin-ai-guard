import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { checkbox, confirm } from '@inquirer/prompts';
import { log } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentId = 'claude' | 'cursor' | 'copilot';

type RuleCategory = 'async' | 'security' | 'error-handling' | 'quality';

interface AgentTarget {
  id: AgentId;
  label: string;
  filePath: string;
  generate: (version: string, categories: RuleCategory[]) => string;
}

// ─── Rule Category Mapping ────────────────────────────────────────────────────

const RULE_CATEGORIES: Record<RuleCategory, string[]> = {
  'error-handling': [
    'no-empty-catch',
    'no-broad-exception',
    'no-catch-log-rethrow',
    'no-catch-without-use',
  ],
  async: [
    'no-async-array-callback',
    'no-floating-promise',
    'no-await-in-loop',
    'no-async-without-await',
    'no-redundant-await',
  ],
  security: [
    'no-hardcoded-secret',
    'no-eval-dynamic',
    'no-sql-string-concat',
    'no-unsafe-deserialize',
    'require-auth-middleware',
    'require-authz-check',
  ],
  quality: [
    'no-console-in-handler',
    'no-duplicate-logic-block',
    'no-dead-branch',
  ],
};

const ALL_CATEGORIES: RuleCategory[] = ['error-handling', 'async', 'security', 'quality'];

// ─── Template Sections ────────────────────────────────────────────────────────

function errorHandlingSection(): string {
  return `## Error Handling
**Never** generate empty catch blocks:
  ❌  try { await fetchUser() } catch (e) {}
  ✅  try { await fetchUser() } catch (e) { logger.error(e); throw e; }

**Never** catch (e: any) — use specific types or narrow with instanceof.

**Never** catch, log, and immediately rethrow without adding context:
  ❌  catch (e) { console.error(e); throw e; }
  ✅  catch (e) { throw new Error('fetchUser failed', { cause: e }); }`;
}

function asyncSection(): string {
  return `## Async Correctness
**Never** pass async callbacks to array.map(), filter(), forEach(), or reduce():
  ❌  const results = ids.map(async (id) => await fetchUser(id));
  ✅  const results = await Promise.all(ids.map((id) => fetchUser(id)));

**Never** use await inside a for...of or while loop when parallel execution
is possible:
  ❌  for (const id of ids) { const user = await fetchUser(id); }
  ✅  const users = await Promise.all(ids.map(fetchUser));

**Never** call an async function without await or .catch():
  ❌  sendEmail(user);
  ✅  await sendEmail(user);

**Never** declare a function async if it never uses await.`;
}

function securitySection(): string {
  return `## Security
**Never** hardcode secrets, API keys, tokens, or passwords inline:
  ❌  const apiKey = 'sk-prod-abc123';
  ✅  const apiKey = process.env.API_KEY;

**Never** concatenate user input into SQL strings:
  ❌  db.query('SELECT * FROM users WHERE id = ' + req.params.id);
  ✅  db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);

**Never** use eval() or new Function() with dynamic/user-supplied strings.

**Never** call JSON.parse() on req.body, req.query, or req.params directly
without schema validation.

**Always** add authentication middleware before route handlers:
  ❌  router.get('/admin/users', getUsers);
  ✅  router.get('/admin/users', requireAuth, getUsers);

**Always** verify that the authenticated user owns or has access to the
resource being accessed when using req.params.id or similar identifiers.`;
}

function qualitySection(): string {
  return `## Code Quality
**Never** leave console.log or console.debug statements inside HTTP route
handlers or event listeners in production code.

**Never** copy-paste the same logic block consecutively — extract shared
logic into a helper function or consolidate duplicated code.`;
}

type SectionFn = () => string;
const SECTION_MAP: Record<RuleCategory, SectionFn> = {
  'error-handling': errorHandlingSection,
  async: asyncSection,
  security: securitySection,
  quality: qualitySection,
};

function getSections(categories: RuleCategory[]): string {
  return categories.map((cat) => SECTION_MAP[cat]()).join('\n\n');
}

function workflowGuidanceMarkdown(): string {
  return `## Workflow Guardrails
- Follow user and repository instructions first; apply these rules on top.
- Reuse existing project patterns and libraries before introducing new abstractions.
- If a rule must be bypassed intentionally, add a suppression comment with reason:
  \`ai-guard-disable <rule-name> -- reason: <why>\`.
- Before finalizing changes, run tests/lint and \`ai-guard run\` when available.`;
}

function workflowGuidanceCursor(): string {
  return `## Workflow Guardrails

- Follow user and repository instructions first.
- Prefer existing project patterns and dependencies.
- If bypassing a rule intentionally, add: ai-guard-disable <rule-name> -- reason: <why>.
- Validate generated code with tests/lint and ai-guard run when available.`;
}

function workflowGuidanceCopilot(): string {
  return `## Required Workflow

- Follow user and repository instructions first.
- Prefer edits that match existing architecture and dependencies.
- If intentionally violating an ai-guard rule, add an inline suppression with a reason.
- Run tests/lint and \`ai-guard run\` before finalizing changes when possible.`;
}

// ─── CLAUDE.md Template ───────────────────────────────────────────────────────

function generateClaudeFile(version: string, categories: RuleCategory[]): string {
  return `<!-- DO NOT EDIT MANUALLY — generated by eslint-plugin-ai-guard -->
<!-- Regenerate: npx ai-guard init-context --force -->

# AI Guard Rules — Claude Code Instructions

You are coding in a project that uses eslint-plugin-ai-guard.
Avoid generating the following patterns. They will be flagged as lint errors.

${workflowGuidanceMarkdown()}

${getSections(categories)}

---
Generated by eslint-plugin-ai-guard v${version}.
Run \`npx ai-guard init-context --force\` to regenerate.
`;
}

// ─── .cursorrules Template ────────────────────────────────────────────────────

function cursorErrorHandling(): string {
  return `## Error Handling

Rule: no-empty-catch
Bad:  try { await fetchUser() } catch (e) {}
Good: try { await fetchUser() } catch (e) { logger.error(e); throw e; }

Rule: no-broad-exception
Bad:  catch (e: any) { handle(e); }
Good: catch (e) { if (e instanceof NetworkError) { retry(); } throw e; }

Rule: no-catch-log-rethrow
Bad:  catch (e) { console.error(e); throw e; }
Good: catch (e) { throw new Error('fetchUser failed', { cause: e }); }`;
}

function cursorAsyncSection(): string {
  return `## Async Correctness

Rule: no-async-array-callback
Bad:  const results = ids.map(async (id) => await fetchUser(id));
Good: const results = await Promise.all(ids.map((id) => fetchUser(id)));

Rule: no-await-in-loop
Bad:  for (const id of ids) { const user = await fetchUser(id); }
Good: const users = await Promise.all(ids.map(fetchUser));

Rule: no-floating-promise
Bad:  sendEmail(user);
Good: await sendEmail(user);

Rule: no-async-without-await
Bad:  async function getUser() { return db.findOne(id); }
Good: function getUser() { return db.findOne(id); }`;
}

function cursorSecuritySection(): string {
  return `## Security

Rule: no-hardcoded-secret
Bad:  const apiKey = 'sk-prod-abc123';
Good: const apiKey = process.env.API_KEY;

Rule: no-sql-string-concat
Bad:  db.query('SELECT * FROM users WHERE id = ' + req.params.id);
Good: db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);

Rule: no-eval-dynamic
Bad:  eval(userInput);
Good: Use a safe parser or allowlist approach instead.

Rule: no-unsafe-deserialize
Bad:  const data = JSON.parse(req.body);
Good: const data = schema.parse(req.body);

Rule: require-auth-middleware
Bad:  router.get('/admin/users', getUsers);
Good: router.get('/admin/users', requireAuth, getUsers);

Rule: require-authz-check
Bad:  const user = await db.findById(req.params.id); res.json(user);
Good: const user = await db.findById(req.params.id); if (user.ownerId !== req.user.id) throw new ForbiddenError(); res.json(user);`;
}

function cursorQualitySection(): string {
  return `## Code Quality

Rule: no-console-in-handler
Bad:  router.get('/users', (req, res) => { console.log('hit'); ... });
Good: router.get('/users', (req, res) => { logger.info('hit'); ... });

Rule: no-duplicate-logic-block
Bad:  Two identical consecutive code blocks copy-pasted.
Good: Extract the duplicated logic into a shared helper function.`;
}

const CURSOR_SECTION_MAP: Record<RuleCategory, () => string> = {
  'error-handling': cursorErrorHandling,
  async: cursorAsyncSection,
  security: cursorSecuritySection,
  quality: cursorQualitySection,
};

function generateCursorFile(version: string, categories: RuleCategory[]): string {
  const sections = categories.map((cat) => CURSOR_SECTION_MAP[cat]()).join('\n\n');

  return `# AI Guard Rules — Cursor Instructions
# DO NOT EDIT MANUALLY — generated by eslint-plugin-ai-guard
# Regenerate: npx ai-guard init-context --force

This project uses eslint-plugin-ai-guard to catch the 18 most common
anti-patterns generated by AI coding tools. Follow these rules when
generating or editing code in this project. Violations will be flagged
as lint errors.

${workflowGuidanceCursor()}

${sections}

---
These rules mirror eslint-plugin-ai-guard v${version}.
Run \`npx ai-guard init-context --force\` to regenerate.
`;
}

// ─── .github/copilot-instructions.md Template ─────────────────────────────────

function copilotQuickRef(categories: RuleCategory[]): string {
  const lines: string[] = [];

  if (categories.includes('error-handling')) {
    lines.push(
      'Never: generate empty catch blocks',
      'Never: catch (e: any) without narrowing',
      'Never: catch, log, and rethrow without adding context',
    );
  }
  if (categories.includes('async')) {
    lines.push(
      'Never: pass async callbacks to .map(), .filter(), .forEach()',
      'Never: use await inside loops when Promise.all() works',
      'Never: call async functions without await or .catch()',
      'Never: mark functions async if they never await',
    );
  }
  if (categories.includes('security')) {
    lines.push(
      'Never: hardcode API keys, secrets, or passwords',
      'Never: concatenate user input into SQL strings',
      'Never: use eval() or new Function() with dynamic input',
      'Never: JSON.parse() untrusted input without validation',
      'Always: add auth middleware before route handlers',
      'Always: verify resource ownership in handlers',
    );
  }
  if (categories.includes('quality')) {
    lines.push(
      'Never: leave console.log in route handlers',
      'Never: copy-paste identical consecutive code blocks',
    );
  }

  return lines.map((l) => `- ${l}`).join('\n');
}

function copilotDetails(categories: RuleCategory[]): string {
  const details: string[] = [];

  if (categories.includes('async')) {
    details.push(`### no-floating-promise
\`\`\`typescript
// ❌ Bad — promise rejected silently
sendEmail(user);

// ✅ Good
await sendEmail(user);
\`\`\``);

    details.push(`### no-async-array-callback
\`\`\`typescript
// ❌ Bad — returns Promise[], not values
ids.map(async (id) => await fetchUser(id));

// ✅ Good
await Promise.all(ids.map((id) => fetchUser(id)));
\`\`\``);
  }

  if (categories.includes('error-handling')) {
    details.push(`### no-empty-catch
\`\`\`typescript
// ❌ Bad — error swallowed silently
try { await fetchUser() } catch (e) {}

// ✅ Good
try { await fetchUser() } catch (e) { logger.error(e); throw e; }
\`\`\``);
  }

  if (categories.includes('security')) {
    details.push(`### no-hardcoded-secret
\`\`\`typescript
// ❌ Bad
const apiKey = 'sk-prod-abc123';

// ✅ Good
const apiKey = process.env.API_KEY;
\`\`\``);

    details.push(`### no-sql-string-concat
\`\`\`typescript
// ❌ Bad — SQL injection
db.query('SELECT * FROM users WHERE id = ' + req.params.id);

// ✅ Good
db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
\`\`\``);
  }

  return details.join('\n\n');
}

function generateCopilotFile(version: string, categories: RuleCategory[]): string {
  return `<!-- DO NOT EDIT MANUALLY — generated by eslint-plugin-ai-guard -->
<!-- Regenerate: npx ai-guard init-context --force -->

# AI Guard — GitHub Copilot Instructions

This project uses \`eslint-plugin-ai-guard\`. Follow these rules to avoid
generating patterns that will be flagged as lint errors.

${workflowGuidanceCopilot()}

## Quick Reference

${copilotQuickRef(categories)}

## Details

${copilotDetails(categories)}

---
Generated by eslint-plugin-ai-guard v${version}.
Run \`npx ai-guard init-context --force\` to regenerate.
`;
}

// ─── Agent Definitions ────────────────────────────────────────────────────────

const AGENTS: AgentTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    filePath: 'CLAUDE.md',
    generate: generateClaudeFile,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    filePath: '.cursorrules',
    generate: generateCursorFile,
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    filePath: path.join('.github', 'copilot-instructions.md'),
    generate: generateCopilotFile,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPackageVersion(cwd: string): string {
  try {
    const pkgPath = path.join(cwd, 'node_modules', 'eslint-plugin-ai-guard', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }

  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    }
  } catch { /* fall through */ }

  return '0.0.0';
}

function parseCategories(raw: string | undefined): RuleCategory[] {
  if (!raw) return ALL_CATEGORIES;
  const parts = raw.split(',').map((s) => s.trim().toLowerCase());
  const valid: RuleCategory[] = [];
  for (const part of parts) {
    if (part in RULE_CATEGORIES) {
      valid.push(part as RuleCategory);
    }
  }
  return valid.length > 0 ? valid : ALL_CATEGORIES;
}

function normalizeSelectedAgents(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string');
  }

  if (typeof raw === 'string') {
    return [raw];
  }

  return [];
}

// ─── Exported for tests ───────────────────────────────────────────────────────

export {
  generateClaudeFile,
  generateCursorFile,
  generateCopilotFile,
  parseCategories,
  normalizeSelectedAgents,
  AGENTS,
  ALL_CATEGORIES,
};
export type { AgentTarget, RuleCategory };

// ─── Command Registration ────────────────────────────────────────────────────

export function registerInitContextCommand(program: Command): void {
  program
    .command('init-context')
    .description(
      'Generate AI agent instruction files (CLAUDE.md, .cursorrules, copilot-instructions.md)\n' +
      'so Claude Code, Cursor, and GitHub Copilot avoid the 18 most common AI anti-patterns.',
    )
    .option('-a, --all', 'Generate files for all agents (skip prompt)')
    .option('--force', 'Overwrite existing files without asking')
    .option('--dry-run', 'Print what would be generated without writing files')
    .option('--rules <categories>', 'Comma-separated categories: async,security,error-handling,quality')
    .action(async (opts: {
      all?: boolean;
      force?: boolean;
      dryRun?: boolean;
      rules?: string;
    }) => {
      const cwd = process.cwd();
      const version = getPackageVersion(cwd);
      const categories = parseCategories(opts.rules);
      const isDryRun = opts.dryRun === true;
      const isForce = opts.force === true;

      log.banner('AI GUARD INIT-CONTEXT');

      if (isDryRun) {
        log.print(`  ${chalk.yellow('⚑  DRY RUN — no files will be written')}`);
        log.blank();
      }

      // ── Select agents ──────────────────────────────────────────────────────

      let selectedAgents: AgentTarget[];

      if (opts.all) {
        selectedAgents = [...AGENTS];
      } else {
        let selected: string[];
        try {
          selected = await checkbox({
            message: 'Which AI agents do you use?',
            choices: [
              { name: 'Claude Code -> writes CLAUDE.md', value: 'claude' },
              { name: 'Cursor -> writes .cursorrules', value: 'cursor' },
              { name: 'GitHub Copilot -> writes .github/copilot-instructions.md', value: 'copilot' },
              { name: 'All three (recommended) -> writes all files', value: 'all' },
            ],
            required: true,
          });
        } catch {
          log.info('Selection cancelled. Nothing to do.');
          return;
        }

        if (selected.length === 0) {
          log.info('No valid agents selected. Use --all to generate all files.');
          return;
        }

        if (selected.includes('all')) {
          selectedAgents = [...AGENTS];
        } else {
          selectedAgents = AGENTS.filter((a) => selected.includes(a.id));
        }
      }

      log.info(`Categories: ${chalk.cyan(categories.join(', '))}`);
      log.info(`Version: ${chalk.cyan(version)}`);
      log.blank();

      // ── Generate files ─────────────────────────────────────────────────────

      const results: { file: string; status: 'created' | 'skipped' | 'dry-run' }[] = [];

      for (const agent of selectedAgents) {
        const fullPath = path.join(cwd, agent.filePath);
        const exists = fs.existsSync(fullPath);

        if (exists && !isForce && !isDryRun) {
          // Ask to overwrite
          const overwrite = await confirm({
            message: `${agent.filePath} already exists. Overwrite?`,
            default: false,
          });

          if (!overwrite) {
            results.push({ file: agent.filePath, status: 'skipped' });
            continue;
          }
        }

        const content = agent.generate(version, categories);

        if (isDryRun) {
          log.section(`Preview: ${agent.filePath}`);
          log.print(chalk.gray('─'.repeat(60)));
          for (const line of content.split('\n').slice(0, 20)) {
            log.print(chalk.gray(`  ${line}`));
          }
          log.print(chalk.gray('  ... (truncated)'));
          log.print(chalk.gray('─'.repeat(60)));
          log.blank();
          results.push({ file: agent.filePath, status: 'dry-run' });
          continue;
        }

        // Ensure parent directory exists (for .github/copilot-instructions.md)
        const parentDir = path.dirname(fullPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(fullPath, content, 'utf-8');
        results.push({ file: agent.filePath, status: 'created' });
      }

      // ── Summary ────────────────────────────────────────────────────────────

      log.section('Summary');

      for (const result of results) {
        switch (result.status) {
          case 'created':
            log.print(`  ${chalk.green('✅')} Created ${chalk.white(result.file)}`);
            break;
          case 'skipped':
            log.print(`  ${chalk.yellow('⏭')}  Skipped ${chalk.white(result.file)} ${chalk.gray('(already exists — use --force to overwrite)')}`);
            break;
          case 'dry-run':
            log.print(`  ${chalk.cyan('📝')} Would create ${chalk.white(result.file)}`);
            break;
        }
      }

      log.blank();

      if (isDryRun) {
        log.info('Dry run complete — no files were written.');
        log.info(`Re-run without ${chalk.cyan('--dry-run')} to apply.`);
      } else {
        const createdCount = results.filter((r) => r.status === 'created').length;
        if (createdCount > 0) {
          log.success(
            'Done. Your AI agents will now automatically avoid the 18 most common AI-generated code anti-patterns.',
          );
        }
      }

      log.blank();
    });
}
