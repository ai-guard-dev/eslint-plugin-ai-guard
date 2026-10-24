#!/usr/bin/env node
/**
 * AI Guard GitHub Action — entrypoint.js
 *
 * This file runs as the action entry point (runs: using: node20, main: action/entrypoint.js).
 * It orchestrates dependency installation, ai-guard execution, SARIF upload setup,
 * and GitHub step summary writing.
 *
 * Design principles:
 * - Fail gracefully — never crash the entire workflow
 * - Minimal magic — just thin orchestration over the CLI
 * - Composable — SARIF output is always written to a file for upload-sarif action
 * - Trustworthy — only surface real ai-guard findings, never ecosystem noise
 */

// Use require('child_process') at call time (not destructured at module load)
// so that vi.spyOn(require('child_process'), 'spawnSync') works in tests.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── GitHub Actions helpers ───────────────────────────────────────────────────

function getInput(name, defaultValue = '') {
  const withHyphen = `INPUT_${name.toUpperCase()}`;
  const withUnderscore = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const val = process.env[withHyphen] ?? process.env[withUnderscore];
  return (val !== undefined && val !== null ? String(val).trim() : '') || defaultValue;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

function info(msg) {
  process.stdout.write(`\u001b[34mℹ\u001b[0m  ${msg}\n`);
}

function warn(msg) {
  process.stdout.write(`\u001b[33m⚠\u001b[0m  ${msg}\n`);
}

function error(msg) {
  process.stdout.write(`\u001b[31m✖\u001b[0m  ${msg}\n`);
  process.stdout.write(`::error::${msg}\n`);
}

function startGroup(name) {
  process.stdout.write(`::group::${name}\n`);
}

function endGroup() {
  process.stdout.write(`::endgroup::\n`);
}

// ─── Package manager detection ────────────────────────────────────────────────

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function installDependencies(cwd, pm) {
  const cmds = {
    npm:  'npm ci --prefer-offline 2>&1 || npm install --prefer-offline 2>&1',
    pnpm: 'pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1',
    yarn: 'yarn install --frozen-lockfile 2>&1 || yarn install 2>&1',
  };
  const cmd = cmds[pm] ?? cmds.npm;
  try {
    childProcess.execSync(cmd, { cwd, stdio: 'inherit', shell: true });
    return true;
  } catch {
    warn('Dependency installation failed. Attempting to continue without it.');
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Inputs ────────────────────────────────────────────────────────────────
  const preset          = getInput('preset', 'recommended');
  const failOn          = getInput('fail-on', 'high');
  const changedOnly     = getInput('changed-only', 'true') === 'true';
  const scanPath        = getInput('path', '.');
  const uploadSarif     = getInput('upload-sarif', 'true') === 'true';
  const workingDir      = getInput('working-directory', '.');
  const pmInput         = getInput('package-manager', 'auto');
  const sarifOutput     = getInput('sarif-output', 'ai-guard-results.sarif');
  const installDeps     = getInput('install-deps', 'true') === 'true';
  const baselineFile    = getInput('baseline', '');
  const integrity       = getInput('integrity', 'off');
  const inlineSuppress  = getInput('inline-suppressions', '');
  const baseRef         = getInput('base-ref', '');

  const cwd = path.resolve(workingDir);

  // ── Detect package manager ────────────────────────────────────────────────
  const pm = pmInput === 'auto' ? detectPackageManager(cwd) : pmInput;
  info(`Package manager: ${pm}`);
  info(`Scan mode: ${changedOnly ? 'changed files only' : 'full scan'}`);
  info(`Preset: ${preset}`);
  info(`Fail on: ${failOn}`);

  // ── Install dependencies ──────────────────────────────────────────────────
  if (installDeps) {
    startGroup('Installing dependencies');
    installDependencies(cwd, pm);
    endGroup();
  }

  // ── Build ai-guard command ────────────────────────────────────────────────
  // Build argv as a structured array — NEVER join and split, to preserve
  // paths and values containing spaces or shell metacharacters.
  const command = changedOnly ? 'changed' : 'run';

  const sarifOutputPath = path.resolve(cwd, sarifOutput);

  const cliArgs = [command];

  // Base-ref resolution for changed-file detection:
  // 1. Explicit base-ref input takes priority (works on push events)
  // 2. GITHUB_BASE_REF is used via --pr on pull_request events
  // 3. Neither → scans uncommitted changes
  if (changedOnly && baseRef) {
    // Validate: must be a safe Git ref (no shell injection, no options)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/~^-]*$/.test(baseRef) || baseRef.includes('..')) {
      error(`Invalid base-ref '${baseRef}'. Expected a branch name like 'main' or 'develop'.`);
      process.exit(1);
      return;
    }
    cliArgs.push('--base', baseRef);
  } else if (changedOnly && process.env.GITHUB_BASE_REF) {
    cliArgs.push('--pr');
  }

  cliArgs.push('--path', scanPath);

  if (preset === 'strict') {
    cliArgs.push('--strict');
  } else if (preset === 'security') {
    cliArgs.push('--security');
  } else if (preset === 'agent') {
    cliArgs.push('--preset', 'agent');
  }

  cliArgs.push('--fail-on', failOn);

  // Baseline filtering applies to PR (changed-only) scans; full scans keep
  // reporting everything so the baseline itself stays visible.
  if (changedOnly && baselineFile) {
    cliArgs.push('--baseline', baselineFile);
  } else if (baselineFile) {
    warn('The baseline input only applies when changed-only is true — ignoring it for this full scan.');
  }

  // Check integrity compares the PR with its base, so it needs changed-only mode.
  if (!['off', 'report', 'enforce'].includes(integrity)) {
    error(`Invalid integrity input '${integrity}'. Use off, report or enforce.`);
    process.exit(1);
    return;
  }
  if (integrity !== 'off' && changedOnly) {
    cliArgs.push('--integrity', integrity);
  } else if (integrity !== 'off') {
    warn('The integrity input only applies when changed-only is true — ignoring it for this full scan.');
  }
  if (inlineSuppress) {
    cliArgs.push('--inline-suppressions', inlineSuppress);
  }
  cliArgs.push('--sarif-output', sarifOutputPath);
  cliArgs.push('--sarif');

  // ── Run ai-guard ──────────────────────────────────────────────────────────
  startGroup('AI Guard — Scan results');

  const localBin = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'ai-guard.cmd' : 'ai-guard');
  const hasLocal = fs.existsSync(localBin);
  const exe = hasLocal ? localBin : 'npx';
  const args = hasLocal ? cliArgs : ['--yes', '-p', 'eslint-plugin-ai-guard', 'ai-guard', ...cliArgs];

  const result = childProcess.spawnSync(
    exe,
    args,
    {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
      },
    },
  );

  endGroup();

  // ── Read SARIF results ────────────────────────────────────────────────────
  let issuesFound = 0;
  let highCount = 0;
  let mediumCount = 0;
  let integrityHigh = 0;
  let integrityAdvisory = 0;
  let filesScanned = 0;
  let durationMs = 0;

  if (fs.existsSync(sarifOutputPath)) {
    try {
      const sarif = JSON.parse(fs.readFileSync(sarifOutputPath, 'utf-8'));
      const runs = sarif.runs ?? [];
      for (const run of runs) {
        const results = run.results ?? [];

        // Count confidence levels from SARIF result properties.precision.
        // Check-integrity results are counted separately from lint findings.
        for (const result of results) {
          if (result.properties?.aiGuardIntegrity) {
            if (result.properties.integrityTier === 'high') integrityHigh++;
            else integrityAdvisory++;
            continue;
          }
          issuesFound++;
          const precision = result.properties?.precision;
          if (precision === 'high') {
            highCount++;
          } else if (precision === 'medium') {
            mediumCount++;
          }
        }

        // filesScanned is stored in run.properties by the SARIF builder
        filesScanned += run.properties?.filesScanned ?? 0;
        durationMs = run.properties?.durationMs ?? durationMs;
      }
    } catch {
      warn('Could not parse SARIF output to extract metrics.');
    }

    // Set SARIF output path for upload-sarif action
    setOutput('sarif-file', sarifOutputPath);
    info(`SARIF written to: ${sarifOutputPath}`);
  } else if (uploadSarif) {
    warn(`SARIF file not found at ${sarifOutputPath}. Creating fallback SARIF artifact.`);
    try {
      const emptySarif = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
          tool: { driver: { name: 'ai-guard', version: '1.3.0', informationUri: 'https://github.com/ai-guard-dev/eslint-plugin-ai-guard', rules: [] } },
          automationDetails: { id: 'ai-guard' },
          results: []
        }]
      };
      fs.writeFileSync(sarifOutputPath, JSON.stringify(emptySarif, null, 2), 'utf-8');
      setOutput('sarif-file', sarifOutputPath);
    } catch {}
  }

  setOutput('issues-found', String(issuesFound));
  setOutput('high-confidence-count', String(highCount));
  setOutput('medium-confidence-count', String(mediumCount));
  setOutput('files-scanned', String(filesScanned));
  setOutput('duration-ms', String(durationMs));
  if (integrity !== 'off' && changedOnly) {
    setOutput('integrity-high-count', String(integrityHigh));
    setOutput('integrity-advisory-count', String(integrityAdvisory));
  }

  // ── Exit with correct code ────────────────────────────────────────────────
  // The CLI already exited with the right code via process.exit.
  // When using spawnSync, we propagate that code.
  // A null status means the child was killed by a signal (e.g. OOM/SIGKILL) —
  // that must be treated as a failure, not a success.
  const exitStatus = result.status;
  if (exitStatus !== 0) {
    if (failOn === 'none' && !(integrity === 'enforce' && changedOnly)) {
      // Report-only mode — never fail the workflow
      info('fail-on: none — findings reported but not failing build.');
      process.exit(0);
    }
    // null status = signal kill (SIGKILL, OOM, etc.) — treat as failure code 1
    process.exit(exitStatus === null ? 1 : exitStatus);
  }

  process.exit(0);
}

main().catch((err) => {
  error(`AI Guard action failed: ${err.message}`);
  process.exit(1);
});
