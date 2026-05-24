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

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── GitHub Actions helpers ───────────────────────────────────────────────────

function getInput(name, defaultValue = '') {
  const envName = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  return (process.env[envName] ?? '').trim() || defaultValue;
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
    execSync(cmd, { cwd, stdio: 'inherit', shell: true });
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
  const command = changedOnly ? 'changed' : 'run';
  const prFlag = changedOnly && process.env.GITHUB_BASE_REF ? '--pr' : '';

  const presetFlag = preset !== 'recommended'
    ? (preset === 'strict' ? '--strict' : '--security')
    : '';

  const sarifOutputPath = path.resolve(cwd, sarifOutput);

  const args = [
    command,
    prFlag,
    `--path ${scanPath}`,
    presetFlag,
    `--fail-on ${failOn}`,
    `--sarif-output ${sarifOutputPath}`,
    '--sarif',
  ].filter(Boolean).join(' ');

  // ── Run ai-guard ──────────────────────────────────────────────────────────
  startGroup('AI Guard — Scan results');

  const result = spawnSync(
    'npx',
    ['--yes', 'ai-guard', ...args.split(' ').filter(Boolean)],
    {
      cwd,
      stdio: 'inherit',
      shell: true,
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
  let filesScanned = 0;
  let durationMs = 0;

  if (fs.existsSync(sarifOutputPath)) {
    try {
      const sarif = JSON.parse(fs.readFileSync(sarifOutputPath, 'utf-8'));
      const runs = sarif.runs ?? [];
      for (const run of runs) {
        issuesFound += (run.results ?? []).length;
        filesScanned += (run.artifacts ?? []).length;
        durationMs = run.properties?.durationMs ?? durationMs;
      }
    } catch {
      warn('Could not parse SARIF output to extract metrics.');
    }

    // Set SARIF output path for upload-sarif action
    setOutput('sarif-file', sarifOutputPath);
    info(`SARIF written to: ${sarifOutputPath}`);
  } else if (uploadSarif) {
    warn(`SARIF file not found at ${sarifOutputPath}. SARIF upload will not work.`);
  }

  setOutput('issues-found', String(issuesFound));
  setOutput('high-confidence-count', String(highCount));
  setOutput('medium-confidence-count', String(mediumCount));
  setOutput('files-scanned', String(filesScanned));
  setOutput('duration-ms', String(durationMs));

  // ── Exit with correct code ────────────────────────────────────────────────
  // The CLI already exited with the right code via process.exit.
  // When using spawnSync, we propagate that code.
  if (result.status !== null && result.status !== 0) {
    if (failOn === 'none') {
      // Report-only mode — never fail the workflow
      info('fail-on: none — findings reported but not failing build.');
      process.exit(0);
    }
    process.exit(result.status);
  }

  process.exit(0);
}

main().catch((err) => {
  error(`AI Guard action failed: ${err.message}`);
  process.exit(1);
});
