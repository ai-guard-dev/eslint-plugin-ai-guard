/**
 * ai_guard_check_package: check npm packages before installing them.
 *
 * Contacts registry.npmjs.org and api.npmjs.org. Packages that the workspace
 * installs from a private registry (.npmrc, .yarnrc.yml, bunfig.toml) are
 * skipped, so their names are never sent to the public registry.
 */
import { assessPackages, type PackageAssessment } from '../../../cli/utils/deps/assess.js';
import { parsePackageArg, type PackageRequest } from '../../../cli/utils/deps/package-spec.js';
import { readRegistryConfig } from '../../../cli/utils/deps/registry-config.js';
import { RegistryClient } from '../../../cli/utils/deps/registry.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CheckPackageResult, CheckedPackage } from '../types.js';

export const MAX_PACKAGES = 20;

function toResult(input: string, a: PackageAssessment): CheckedPackage {
  return {
    input,
    name: a.request.name,
    spec: a.request.spec,
    verdict: a.verdict,
    ...(a.reason ? { reason: a.reason } : {}),
    findings: a.findings,
    ...(a.facts ? { facts: a.facts } : {}),
    ...(a.similarTo ? { similarTo: a.similarTo } : {}),
  };
}

export async function checkPackageTool(
  input: { packages: string[]; minAgeDays?: number; minWeeklyDownloads?: number },
  workspace = getWorkspaceRoot(),
  client: RegistryClient = new RegistryClient(),
): Promise<CheckPackageResult> {
  const results: CheckedPackage[] = [];
  const requests: Array<{ input: string; request: PackageRequest }> = [];
  for (const raw of input.packages.slice(0, MAX_PACKAGES)) {
    const request = parsePackageArg(raw);
    if (request) requests.push({ input: raw, request });
    else results.push({ input: raw, name: raw, spec: null, verdict: 'skipped', reason: 'not an npm registry package (git, URL, path or invalid name)', findings: [] });
  }

  const assessments = await assessPackages(requests.map((r) => r.request), {
    client,
    registryConfig: readRegistryConfig(workspace),
    cwd: workspace,
    minAgeDays: input.minAgeDays,
    minWeeklyDownloads: input.minWeeklyDownloads,
  });
  results.push(...assessments.map((a, i) => toResult(requests[i].input, a)));

  const unchecked = results.filter((r) => r.verdict === 'unchecked');
  const blocked = results.filter((r) => r.verdict === 'block');
  return {
    success: true,
    status: unchecked.length > 0 ? 'partial' : 'complete',
    // Only a complete check can say "safe": a package that could not be looked up is not known to be safe.
    safeToInstall: blocked.length === 0 && unchecked.length === 0,
    packages: results,
    errors: unchecked.map((r) => ({ code: 'REGISTRY_UNAVAILABLE', message: `${r.name}: ${r.reason ?? 'could not be checked'}` })),
  };
}
