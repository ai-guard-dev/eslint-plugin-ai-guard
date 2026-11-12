// Checks that AI Guard's rules give identical results in ESLint and in Oxlint (as a JS plugin).
//
// Both linters run every rule at "error" over tests/fixtures (including tests/fixtures/oxlint,
// which triggers each rule at least once) and the findings are compared by file, rule and line.
// Fails when the results differ or a rule was never exercised. Needs a build: npm run build.
//
// Usage: npm run test:oxlint
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const dist = path.join(root, 'dist', 'index.js');
if (!fs.existsSync(dist)) {
  console.error('dist/index.js is missing. Run "npm run build" first.');
  process.exit(2);
}
const plugin = require(dist);
const rules = Object.keys((plugin.default ?? plugin).rules).sort();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-oxlint-parity-'));
try {
  const corpus = path.join(work, 'corpus');
  fs.cpSync(path.join(root, 'tests', 'fixtures'), corpus, { recursive: true });
  // A project of its own: no-undeclared-import reads every package.json up to the
  // first directory with .git, and nothing above the temp directory may count
  // (a ~/package.json would make results differ between machines).
  fs.mkdirSync(path.join(work, '.git'));
  fs.writeFileSync(path.join(corpus, 'package.json'), JSON.stringify({ name: 'ai-guard-oxlint-corpus', private: true, dependencies: { express: '^4.21.0' } }, null, 2));
  // Generated here so the repository never contains a raw invisible character.
  fs.writeFileSync(path.join(corpus, 'oxlint', 'invisible.js'), `export const user = 'admin${String.fromCharCode(0x200b)}user';\n`);

  const ruleLevels = Object.fromEntries(rules.map((r) => [`ai-guard/${r}`, 'error']));
  const oxConfig = path.join(work, '.oxlintrc.json');
  fs.writeFileSync(oxConfig, JSON.stringify({
    jsPlugins: [dist.replace(/\\/g, '/')],
    categories: { correctness: 'off', suspicious: 'off', pedantic: 'off', perf: 'off', style: 'off', restriction: 'off', nursery: 'off' },
    rules: ruleLevels,
  }, null, 2));
  const esConfig = path.join(work, 'eslint.config.mjs');
  const url = (p) => new URL(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`).href;
  fs.writeFileSync(esConfig, `import plugin from ${JSON.stringify(url(dist))};
import tsParser from ${JSON.stringify(url(require.resolve('@typescript-eslint/parser')))};
export default [{
  files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
  plugins: { 'ai-guard': plugin.default ?? plugin },
  languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
  linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
  rules: ${JSON.stringify(ruleLevels)},
}];
`);

  // Run each linter's own bin script with Node: no shell, so paths with spaces are safe.
  const bin = (name) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    return path.join(root, 'node_modules', name, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name]);
  };
  const run = (name, args) => {
    const res = spawnSync(process.execPath, [bin(name), ...args], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0 && res.status !== 1) throw new Error(`${name} failed (exit ${res.status}): ${res.stderr || res.stdout}`.slice(0, 2000));
    return JSON.parse(res.stdout);
  };
  const rel = (f) => path.relative(corpus, path.resolve(work, f)).replace(/\\/g, '/');

  const eslint = new Set();
  for (const file of run('eslint', ['--config', esConfig, '--no-config-lookup', '--format', 'json', corpus])) {
    for (const m of file.messages) {
      if (!m.ruleId) throw new Error(`ESLint could not lint ${rel(file.filePath)}: ${m.message}`);
      eslint.add(`${rel(file.filePath)}|${m.ruleId}|${m.line}`);
    }
  }
  const oxlint = new Set();
  for (const d of run('oxlint', ['-c', oxConfig, '--format', 'json', corpus]).diagnostics) {
    const m = /^ai-guard\((.+)\)$/.exec(d.code ?? '');
    if (!m) throw new Error(`Unexpected Oxlint diagnostic: ${d.code} ${d.message}`);
    oxlint.add(`${rel(d.filename)}|ai-guard/${m[1]}|${d.labels?.[0]?.span?.line}`);
  }

  const onlyEslint = [...eslint].filter((k) => !oxlint.has(k)).sort();
  const onlyOxlint = [...oxlint].filter((k) => !eslint.has(k)).sort();
  const exercised = new Set([...eslint].map((k) => k.split('|')[1].slice('ai-guard/'.length)));
  const missing = rules.filter((r) => !exercised.has(r));
  const oxVersion = execFileSync(process.execPath, [bin('oxlint'), '--version'], { encoding: 'utf8' }).trim();

  console.log(`${oxVersion}: ${eslint.size} ESLint findings, ${oxlint.size} Oxlint findings, ${exercised.size}/${rules.length} rules exercised`);
  if (onlyEslint.length > 0) console.log(`Only in ESLint:\n  ${onlyEslint.join('\n  ')}`);
  if (onlyOxlint.length > 0) console.log(`Only in Oxlint:\n  ${onlyOxlint.join('\n  ')}`);
  if (missing.length > 0) console.log(`Never exercised (add a case to tests/fixtures/oxlint): ${missing.join(', ')}`);
  if (onlyEslint.length > 0 || onlyOxlint.length > 0 || missing.length > 0) process.exit(1);
  console.log('Identical results.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
