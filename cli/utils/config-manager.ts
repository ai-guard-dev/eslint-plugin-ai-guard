import fs from 'fs';
import path from 'path';
import type { ConfigType } from './detector.js';

export type Preset = 'recommended' | 'strict' | 'security' | 'agent';

// ─── File I/O primitives ──────────────────────────────────────────────────────

export function backupConfig(configPath: string): string {
  const backupPath = `${configPath}.bak`;
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

export function readConfig(configPath: string): string {
  return fs.readFileSync(configPath, 'utf-8');
}

export function writeConfig(configPath: string, content: string): void {
  fs.writeFileSync(configPath, content, 'utf-8');
}

// ─── Flat Config Generator (ESLint v9) ────────────────────────────────────────
//
// Generates a clean eslint.config.mjs that:
//  1. Uses direct spread of the preset config object (no object wrapping)
//  2. Explicitly names plugin so IDEs resolve it
//  3. Puts ignores first so they apply to all following configs

export function generateFlatConfig(preset: Preset): string {
  return `import aiGuard from 'eslint-plugin-ai-guard';

export default [
  // Ignore generated / dependency directories
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'out/**',
    ],
  },

  // ai-guard: catch AI-generated code patterns
  {
    plugins: {
      'ai-guard': aiGuard,
    },
    rules: {
      ...aiGuard.configs.${preset}.rules,
    },
  },
];
`;
}

// ─── Legacy Config Generator (ESLint v8) ──────────────────────────────────────

export function generateLegacyConfig(preset: Preset): string {
  return `module.exports = {
  plugins: ['ai-guard'],
  extends: ['plugin:ai-guard/${preset}'],
  ignorePatterns: [
    'node_modules/',
    '.next/',
    'dist/',
    'build/',
    'coverage/',
    'out/',
  ],
};
`;
}

// ─── Flat Config Patching (ESLint v9) ─────────────────────────────────────────

const AI_GUARD_MARKER = 'eslint-plugin-ai-guard';

export function isInvalidAiGuardConfig(content: string): boolean {
  if (!content.includes('eslint-plugin-ai-guard') && !content.includes('ai-guard')) {
    return false;
  }

  // Old invalid shape: plugin assigned to aiGuard.default
  if (/['"]ai-guard['"]\s*:\s*aiGuard\.default/.test(content)) return true;

  // Old invalid shape: rules sourced directly from aiGuard.recommended/strict/security
  if (/\.\.\.aiGuard\.(recommended|strict|security)\.rules/.test(content)) return true;
  if (/rules\s*:\s*aiGuard\.(recommended|strict|security)\.rules/.test(content)) return true;

  return false;
}

export function repairInvalidFlatConfig(content: string): string {
  let repaired = content;
  
  // 1. Fix plugin assignment: 'ai-guard': aiGuard.default -> 'ai-guard': aiGuard
  repaired = repaired.replace(/(['"]ai-guard['"]\s*:\s*)aiGuard\.default/g, '$1aiGuard');
  
  // 2. Fix raw assignment: rules: aiGuard.PRESET.rules -> rules: { ...aiGuard.configs.PRESET.rules }
  repaired = repaired.replace(
    /rules\s*:\s*aiGuard\.([a-zA-Z0-9_]+)\.rules(,?)/g,
    'rules: {\n      ...aiGuard.configs.$1.rules,\n    }$2',
  );
  
  // 3. Fix spread assignment: ...aiGuard.PRESET.rules -> ...aiGuard.configs.PRESET.rules
  repaired = repaired.replace(/\.\.\.aiGuard\.([a-zA-Z0-9_]+)\.rules/g, '...aiGuard.configs.$1.rules');
  
  return repaired;
}

export function patchFlatConfig(existing: string, preset: Preset): string {
  if (isInvalidAiGuardConfig(existing)) {
    return repairInvalidFlatConfig(existing);
  }

  // If already configured and valid — leave untouched
  if (existing.includes(AI_GUARD_MARKER)) {
    return existing;
  }

  const importLine = `import aiGuard from 'eslint-plugin-ai-guard';\n`;

  const rulesBlock = `
  // ai-guard injected by ai-guard CLI
  {
    plugins: {
      'ai-guard': aiGuard,
    },
    rules: {
      ...aiGuard.configs.${preset}.rules,
    },
  },
`;

  // Prepend import after the last existing import, or at the very top
  let patched = existing;
  const lastImportIdx = findLastImportEnd(patched);
  if (lastImportIdx > -1) {
    patched =
      patched.slice(0, lastImportIdx) +
      importLine +
      patched.slice(lastImportIdx);
  } else {
    patched = importLine + patched;
  }

  // Insert rule block before the closing `];` of the export default array
  const lastBracket = patched.lastIndexOf('];');
  if (lastBracket !== -1) {
    patched =
      patched.slice(0, lastBracket) + rulesBlock + patched.slice(lastBracket);
  }

  return patched;
}

/** Find index just after the last `import … from '…';` line */
function findLastImportEnd(src: string): number {
  const lines = src.split('\n');
  let lastImportLine = -1;
  let charCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*import\s+/.test(line)) lastImportLine = i;
    charCount += line.length + 1; // +1 for \n
  }
  if (lastImportLine === -1) return -1;

  // Recalculate offset to end of that line
  let offset = 0;
  for (let i = 0; i <= lastImportLine; i++) {
    offset += lines[i].length + 1;
  }
  return offset;
}

// ─── Legacy Config Patching (ESLint v8) ───────────────────────────────────────

export function patchLegacyConfig(existing: string, preset: Preset): string {
  if (existing.includes('ai-guard')) {
    return existing; // already configured
  }

  let patched = existing;

  if (patched.includes('plugins:')) {
    patched = patched.replace(/plugins:\s*\[/, `plugins: ['ai-guard', `);
  } else {
    patched = patched.replace(
      'module.exports = {',
      `module.exports = {\n  plugins: ['ai-guard'],`,
    );
  }

  if (patched.includes('extends:')) {
    patched = patched.replace(
      /extends:\s*\[/,
      `extends: ['plugin:ai-guard/${preset}', `,
    );
  } else {
    patched = patched.replace(
      'module.exports = {',
      `module.exports = {\n  extends: ['plugin:ai-guard/${preset}'],`,
    );
  }

  return patched;
}

export function switchFlatPreset(existing: string, preset: Preset): string {
  let patched = existing;

  patched = patched.replace(
    /\.\.\.aiGuard\.configs\.(recommended|strict|security)\.rules/g,
    `...aiGuard.configs.${preset}.rules`,
  );

  patched = patched.replace(
    /['"]ai-guard\/(recommended|strict|security)['"]/g,
    `'ai-guard/${preset}'`,
  );

  return patched;
}

export function switchLegacyPreset(existing: string, preset: Preset): string {
  let patched = existing;

  patched = patched.replace(
    /['"]plugin:ai-guard\/(recommended|strict|security)['"]/g,
    `'plugin:ai-guard/${preset}'`,
  );

  patched = patched.replace(
    /['"]ai-guard\/(recommended|strict|security)['"]/g,
    `'ai-guard/${preset}'`,
  );

  return patched;
}

// ─── Nuke-ignore removal ──────────────────────────────────────────────────────

/**
 * Remove `ignorePatterns: ["**\/*"]` from legacy configs.
 * Returns `{ content, changed }`.
 */
export function removeNukeIgnore(existing: string): {
  content: string;
  changed: boolean;
} {
  const nukePatterns = [/"?\*\*\/\*"?/g];
  const hasNuke =
    existing.includes('"**/*"') || existing.includes("'**/*'");

  if (!hasNuke) return { content: existing, changed: false };

  // Replace the entire ignorePatterns array value when it contains **/*
  let patched = existing
    .replace(
      /ignorePatterns:\s*\[.*?\*\*\/\*.*?\]/gs,
      `ignorePatterns: ['node_modules/', '.next/', 'dist/', 'build/', 'coverage/']`,
    )
    .replace(
      /ignores:\s*\[.*?\*\*\/\*.*?\]/gs,
      `ignores: ['node_modules/**', '.next/**', 'dist/**', 'build/**', 'coverage/**']`,
    );

  // Safety: if the regex above didn't match (complex multi-line), fall back to
  // a line-by-line strip of **/* entries
  for (const re of nukePatterns) {
    patched = patched.replace(re, '');
  }

  return { content: patched, changed: patched !== existing };
}

// ─── Ignore pattern helpers ───────────────────────────────────────────────────

const DEFAULT_FLAT_IGNORES = [
  'node_modules/**',
  '.next/**',
  'dist/**',
  'build/**',
  'coverage/**',
  'out/**',
];

const DEFAULT_LEGACY_IGNORES = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'coverage/',
  'out/',
];

export function addIgnoresToFlatConfig(existing: string): string {
  if (existing.includes('ignores:')) return existing;

  const block = `
  // Default ignores added by ai-guard CLI
  {
    ignores: ${JSON.stringify(DEFAULT_FLAT_IGNORES)},
  },
`;

  const lastBracket = existing.lastIndexOf('];');
  if (lastBracket !== -1) {
    return existing.slice(0, lastBracket) + block + existing.slice(lastBracket);
  }
  return existing;
}

export function addIgnoresToLegacyConfig(existing: string): string {
  if (existing.includes('ignorePatterns')) return existing;
  return existing.replace(
    'module.exports = {',
    `module.exports = {\n  ignorePatterns: ${JSON.stringify(DEFAULT_LEGACY_IGNORES)},`,
  );
}

// ─── Config file path resolution ──────────────────────────────────────────────

export function getConfigFilePath(
  configType: ConfigType,
  cwd = process.cwd(),
): string {
  switch (configType) {
    case 'flat-js':
      return path.join(cwd, 'eslint.config.js');
    case 'flat-mjs':
      return path.join(cwd, 'eslint.config.mjs');
    case 'flat-cjs':
      return path.join(cwd, 'eslint.config.cjs');
    case 'eslintrc-js':
      return path.join(cwd, '.eslintrc.js');
    case 'eslintrc-cjs':
      return path.join(cwd, '.eslintrc.cjs');
    case 'eslintrc-json':
      return path.join(cwd, '.eslintrc.json');
    default:
      return path.join(cwd, '.eslintrc.js');
  }
}

// ─── Post-init config validation ──────────────────────────────────────────────

/**
 * Lightweight structural validation of a generated/patched flat config.
 * Does NOT require ESLint to be loadable — just checks the text.
 * Returns an array of problem strings; empty = looks valid.
 */
export function validateFlatConfigText(content: string): string[] {
  const problems: string[] = [];

  if (!content.includes('export default')) {
    problems.push('Missing `export default` — file must be an ES module');
  }
  if (!content.includes('eslint-plugin-ai-guard') && !content.includes('aiGuard')) {
    problems.push('Plugin import not found — ai-guard plugin may not be referenced');
  }
  if (!content.trim().endsWith('];') && !content.trim().endsWith('];')) {
    // minor — not fatal
  }

  // Detect nuke ignore that would prevent any files from being linted
  if (content.includes('"**/*"') || content.includes("'**/*'")) {
    problems.push(
      'Config contains "**/*" ignore pattern — this will prevent all files from being linted',
    );
  }

  return problems;
}

export function validateLegacyConfigText(content: string): string[] {
  const problems: string[] = [];

  if (!content.includes('module.exports')) {
    problems.push('Missing `module.exports` — legacy config must use CJS exports');
  }
  if (!content.includes('ai-guard')) {
    problems.push('Plugin not referenced — add ai-guard to plugins and extends');
  }
  if (content.includes('"**/*"') || content.includes("'**/*'")) {
    problems.push(
      'Config contains "**/*" ignore pattern — this will prevent all files from being linted',
    );
  }

  return problems;
}
