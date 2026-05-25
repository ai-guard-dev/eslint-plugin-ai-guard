/**
 * SARIF 2.1.0 output generator for eslint-plugin-ai-guard.
 *
 * SARIF (Static Analysis Results Interchange Format) is the standard format
 * for GitHub Code Scanning, Azure DevOps, and other CI platforms. By outputting
 * SARIF, ai-guard findings appear as PR annotations in GitHub.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 *
 * === SARIF SCHEMA COMPLIANCE ===
 * GitHub Code Scanning validates SARIF against the 2.1.0 schema.
 * Key requirements enforced here:
 *  - properties.tags: uniqueItems=true (duplicates cause upload rejection)
 *  - region.startLine: minimum=1 (0 causes schema error)
 *  - level: must be "error"|"warning"|"note"|"none"
 *  - kind: must be "fail"|"open"|"informational" (or omitted)
 *  - All string properties: must be non-empty strings, not undefined/null
 */

import type { RunResult, IssueDetail, FileResult } from './eslint-runner.js';
import { ISSUE_CONFIDENCE, ISSUE_CATEGORY, ISSUE_ASYNC_RISK_TYPE, ISSUE_REMEDIATION } from './eslint-runner.js';
import { CONFIDENCE_TIER } from './logger.js';
import { PKG_VERSION } from './version.js';
import type { ConfidenceTier } from './logger.js';

// ─── SARIF type definitions ────────────────────────────────────────────────────

interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

interface SarifRegion {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
  message?: { text: string };
}

interface SarifReportingDescriptor {
  id: string;
  shortDescription: { text: string };
  fullDescription?: { text: string };
  help?: { text: string; markdown?: string };
  helpUri?: string;
  defaultConfiguration?: { level: 'error' | 'warning' | 'note' | 'none' };
  properties?: {
    tags?: string[];
    confidence?: string;
    category?: string;
    'problem.severity'?: string;
  };
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note' | 'none';
  kind?: 'fail' | 'open' | 'informational';
  rank?: number;  // 0-100 confidence rank for GitHub UI ordering
  message: { text: string };
  locations: SarifLocation[];
  properties?: {
    confidence?: string;
    asyncRiskType?: string;
    category?: string;
  };
}

interface SarifTool {
  driver: {
    name: string;
    version: string;
    informationUri: string;
    rules: SarifReportingDescriptor[];
  };
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  artifacts?: Array<{ location: SarifArtifactLocation }>;
  properties?: Record<string, unknown>;
}

interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

// ─── Rule metadata ────────────────────────────────────────────────────────────
//
// IMPORTANT: Tags here are the BASE tags. The category-derived tag is added
// separately in buildRuleDescriptors, then the full list is deduplicated via
// sanitizeSarifTags() before emission. This prevents schema violations when
// a category tag (e.g. "async-reliability") is already present in base tags.

const RULE_DOCS: Record<string, { shortDesc: string; tags: string[] }> = {
  'ai-guard/no-empty-catch':          { shortDesc: 'Empty catch block silently swallows errors', tags: ['reliability'] },
  'ai-guard/no-broad-exception':      { shortDesc: 'Catching broad Exception/Error masks specific failures', tags: ['reliability'] },
  'ai-guard/no-catch-log-rethrow':    { shortDesc: 'Catch block logs and rethrows — use one or the other', tags: ['reliability'] },
  'ai-guard/no-catch-without-use':    { shortDesc: 'Caught error variable is not used', tags: ['reliability'] },
  'ai-guard/no-floating-promise':     { shortDesc: 'Promise not awaited or error-handled — async failures will be silently swallowed', tags: ['async', 'async-reliability'] },
  'ai-guard/no-await-in-loop':        { shortDesc: 'Sequential await in loop — consider Promise.all for parallel execution', tags: ['async', 'async-reliability', 'performance'] },
  'ai-guard/no-async-without-await':  { shortDesc: 'Async function contains no await expressions', tags: ['async', 'async-reliability'] },
  'ai-guard/no-async-array-callback': { shortDesc: 'Async callback in array method may not behave as expected', tags: ['async', 'async-reliability'] },
  'ai-guard/no-redundant-await':      { shortDesc: 'Redundant await on already-resolved value', tags: ['async'] },
  'ai-guard/no-hardcoded-secret':     { shortDesc: 'Hardcoded secret or credential detected', tags: ['security', 'secrets'] },
  'ai-guard/no-eval-dynamic':         { shortDesc: 'Dynamic eval or Function constructor is dangerous', tags: ['security'] },
  'ai-guard/no-sql-string-concat':    { shortDesc: 'SQL query built via string concatenation — SQL injection risk', tags: ['security', 'injection'] },
  'ai-guard/no-unsafe-deserialize':   { shortDesc: 'Unsafe deserialization of untrusted data', tags: ['security'] },
  'ai-guard/require-auth-middleware': { shortDesc: 'Route handler appears to lack authentication middleware', tags: ['security', 'auth'] },
  'ai-guard/require-authz-check':     { shortDesc: 'Handler lacks authorization check', tags: ['security', 'auth'] },
  'ai-guard/no-console-in-handler':   { shortDesc: 'console.log in request handler — use structured logging', tags: ['ai-patterns'] },
  'ai-guard/no-duplicate-logic-block':{ shortDesc: 'Duplicate logic block detected', tags: ['ai-patterns'] },
  'ai-guard/no-dead-branch':          { shortDesc: 'Dead code branch that can never execute', tags: ['ai-patterns'] },
};

const BASE_DOCS_URL = 'https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules';

// ─── SARIF Sanitizer ──────────────────────────────────────────────────────────
//
// Central sanitization layer. ALL SARIF metadata MUST pass through here before
// emission. This is the single source of truth for SARIF normalization.
//
// Root cause of the GitHub upload failure:
//   The category slug (e.g. "async-reliability") was appended to tags that
//   already contained it (e.g. ['async', 'async-reliability']), producing
//   ['async', 'async-reliability', 'async-reliability'] — violating the SARIF
//   schema's uniqueItems constraint on properties.tags.

/**
 * Deduplicate, normalize, and validate SARIF tags.
 *
 * Rules enforced:
 *  - Unique items (SARIF schema: uniqueItems: true)
 *  - No empty strings
 *  - Lowercase, hyphenated format
 *  - Never null or undefined items
 *
 * This MUST be called on all tags before SARIF serialization.
 */
export function sanitizeSarifTags(tags: (string | undefined | null)[]): string[] {
  return Array.from(
    new Set(
      tags
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.toLowerCase().trim().replace(/\s+/g, '-')),
    ),
  );
}

/**
 * Sanitize SARIF rule properties.
 * Ensures no undefined values, valid types, and schema-compliant structure.
 */
export function sanitizeSarifProperties(props: {
  tags: (string | undefined | null)[];
  confidence: string | undefined;
  category: string | undefined;
  problemSeverity: string | undefined;
}): SarifReportingDescriptor['properties'] {
  return {
    tags: sanitizeSarifTags(props.tags),
    confidence: props.confidence ?? 'low',
    category: props.category ?? 'AI Patterns',
    'problem.severity': props.problemSeverity ?? 'low',
  };
}

/**
 * Sanitize a SARIF rule descriptor.
 * Guards against undefined shortDescription, missing help text,
 * and invalid/empty properties.
 */
export function sanitizeSarifRule(rule: SarifReportingDescriptor): SarifReportingDescriptor {
  return {
    ...rule,
    shortDescription: {
      text: rule.shortDescription.text || `ai-guard rule: ${rule.id}`,
    },
    fullDescription: rule.fullDescription?.text
      ? rule.fullDescription
      : { text: rule.shortDescription.text || `ai-guard rule: ${rule.id}` },
    properties: rule.properties
      ? {
          ...rule.properties,
          // Re-deduplicate tags at the rule level as a final safety net
          tags: rule.properties.tags
            ? sanitizeSarifTags(rule.properties.tags)
            : [],
        }
      : undefined,
  };
}

/**
 * Sanitize a complete SARIF log.
 * Applies all sanitizers to every rule descriptor and result.
 * This is the final line of defense before serialization.
 */
export function sanitizeSarifLog(log: SarifLog): SarifLog {
  return {
    ...log,
    runs: log.runs.map((run) => ({
      ...run,
      tool: {
        ...run.tool,
        driver: {
          ...run.tool.driver,
          rules: run.tool.driver.rules.map(sanitizeSarifRule),
        },
      },
    })),
  };
}

// ─── Confidence → SARIF mapping ──────────────────────────────────────────────

function confidenceToSarifLevel(confidence: string | undefined): 'error' | 'warning' | 'note' | 'none' {
  switch (confidence) {
    case 'high':          return 'error';
    case 'medium':        return 'warning';
    case 'low':           return 'warning';
    case 'informational': return 'note';
    default:              return 'warning';
  }
}

function confidenceToRank(confidence: string | undefined): number {
  switch (confidence) {
    case 'high':          return 90;
    case 'medium':        return 60;
    case 'low':           return 30;
    case 'informational': return 10;
    default:              return 30;
  }
}

function confidenceToGitHubSeverity(confidence: string | undefined): string {
  switch (confidence) {
    case 'high':          return 'high';
    case 'medium':        return 'medium';
    case 'low':           return 'low';
    case 'informational': return 'recommendation';
    default:              return 'low';
  }
}

function filePathToUri(filePath: string): string {
  // Convert relative paths to file-relative URIs for SARIF
  // SARIF uses %SRCROOT% or similar base IDs; we use a simple relative path
  return filePath.replace(/\\/g, '/');
}

function collectUsedRuleIds(result: RunResult): string[] {
  const ids = new Set<string>();
  for (const file of result.files) {
    for (const issue of file.issues) {
      ids.add(issue.ruleId);
    }
  }
  return [...ids].sort();
}

function buildRuleDescriptors(ruleIds: string[]): SarifReportingDescriptor[] {
  return ruleIds.map((id) => {
    const meta = RULE_DOCS[id];
    const shortName = id.replace('ai-guard/', '');
    const confidence = ISSUE_CONFIDENCE[id];
    const category = ISSUE_CATEGORY[id] ?? 'AI Patterns';
    const remediation = ISSUE_REMEDIATION[id];

    // Derive category slug (e.g. "Async Reliability" → "async-reliability")
    const categorySlug = category.toLowerCase().replace(/\s+/g, '-');

    // FIX: Combine base tags + category slug, then deduplicate via sanitizeSarifTags.
    // Previously, this was a naive spread: [...meta.tags, categorySlug]
    // which produced duplicates like ['async', 'async-reliability', 'async-reliability']
    // when the category slug was already present in the base tags.
    // Now sanitizeSarifTags() uses a Set to guarantee uniqueItems compliance.
    const rawTags = [...(meta?.tags ?? ['ai-guard']), categorySlug];

    const helpMarkdown = [
      `**${meta?.shortDesc ?? shortName}**`,
      '',
      remediation ? `**Fix:** ${remediation}` : '',
      '',
      `[View rule documentation](${BASE_DOCS_URL}/${shortName}.md)`,
    ].filter(Boolean).join('\n');

    return sanitizeSarifRule({
      id,
      shortDescription: {
        text: meta?.shortDesc ?? `ai-guard rule: ${shortName}`,
      },
      fullDescription: {
        text: meta?.shortDesc ?? `ai-guard rule: ${shortName}`,
      },
      help: {
        text: remediation ?? meta?.shortDesc ?? shortName,
        markdown: helpMarkdown,
      },
      helpUri: `${BASE_DOCS_URL}/${shortName}.md`,
      defaultConfiguration: {
        level: confidenceToSarifLevel(confidence),
      },
      properties: sanitizeSarifProperties({
        tags: rawTags,
        confidence,
        category,
        problemSeverity: confidenceToGitHubSeverity(confidence),
      }),
    });
  });
}

function buildSarifResult(issue: IssueDetail, file: FileResult): SarifResult {
  const confidence = ISSUE_CONFIDENCE[issue.ruleId];
  const asyncRiskType = ISSUE_ASYNC_RISK_TYPE[issue.ruleId];
  const category = ISSUE_CATEGORY[issue.ruleId];

  return {
    ruleId: issue.ruleId,
    level: confidenceToSarifLevel(confidence),
    kind: confidence === 'informational' ? 'informational' : 'fail',
    rank: confidenceToRank(confidence),
    message: { text: issue.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: filePathToUri(file.filePath),
            uriBaseId: '%SRCROOT%',
          },
          region: {
            startLine: Math.max(1, issue.line),
            startColumn: issue.column > 0 ? issue.column : 1,
            ...(issue.endLine !== undefined && { endLine: issue.endLine }),
            ...(issue.endColumn !== undefined && { endColumn: issue.endColumn }),
          },
        },
        message: { text: issue.message },
      },
    ],
    properties: {
      confidence: confidence ?? 'low',
      ...(asyncRiskType && { asyncRiskType }),
      ...(category && { category }),
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a RunResult to a SARIF 2.1.0 log object.
 *
 * Only ai-guard findings are included. Ecosystem issues and parser errors
 * are excluded — they are not ai-guard findings and should not appear in
 * Code Scanning results.
 *
 * All output passes through the SARIF sanitizer to guarantee:
 *  - unique tags (GitHub Code Scanning schema requirement)
 *  - no undefined values in properties
 *  - valid level/kind/rank values
 *  - startLine >= 1
 */
export function buildSarifLog(result: RunResult, version = PKG_VERSION): SarifLog {
  const usedRuleIds = collectUsedRuleIds(result);
  const rules = buildRuleDescriptors(usedRuleIds);

  const sarifResults: SarifResult[] = [];
  for (const file of result.files) {
    for (const issue of file.issues) {
      sarifResults.push(buildSarifResult(issue, file));
    }
  }

  const log: SarifLog = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ai-guard',
            version,
            informationUri: 'https://github.com/YashJadhav21/eslint-plugin-ai-guard',
            rules,
          },
        },
        results: sarifResults,
        properties: {
          preset: 'recommended',
          filesScanned: result.filesScanned,
          durationMs: result.durationMs,
          ecosystemIssuesCount: result.ecosystemIssues.length,
          parserErrorsCount: result.parserErrors.length,
        },
      },
    ],
  };

  // Final sanitization pass — guarantees GitHub-compatible, schema-valid output
  return sanitizeSarifLog(log);
}

/**
 * Serialize a SARIF log to a JSON string.
 * Use this for --sarif flag output: write to stdout or a file.
 */
export function sarifToJson(log: SarifLog): string {
  return JSON.stringify(log, null, 2);
}

// ─── Debug helpers ────────────────────────────────────────────────────────────

export interface SarifDebugInfo {
  rulesEmitted: Array<{
    id: string;
    rawTags: string[];
    sanitizedTags: string[];
    hasDuplicatesInRaw: boolean;
    confidence: string;
    category: string;
    level: string;
  }>;
  totalResults: number;
  version: string;
}

/**
 * Build debug info for --debug-sarif flag.
 * Shows raw vs. sanitized tags so you can verify deduplication.
 */
export function buildSarifDebugInfo(result: RunResult): SarifDebugInfo {
  const usedRuleIds = collectUsedRuleIds(result);

  const rulesEmitted = usedRuleIds.map((id) => {
    const meta = RULE_DOCS[id];
    const confidence = ISSUE_CONFIDENCE[id];
    const category = ISSUE_CATEGORY[id] ?? 'AI Patterns';
    const categorySlug = category.toLowerCase().replace(/\s+/g, '-');
    const rawTags = [...(meta?.tags ?? ['ai-guard']), categorySlug];
    const sanitizedTags = sanitizeSarifTags(rawTags);

    return {
      id,
      rawTags,
      sanitizedTags,
      hasDuplicatesInRaw: rawTags.length !== new Set(rawTags).size,
      confidence: confidence ?? 'low',
      category,
      level: confidenceToSarifLevel(confidence),
    };
  });

  return {
    rulesEmitted,
    totalResults: result.files.reduce((n, f) => n + f.issues.length, 0),
    version: PKG_VERSION,
  };
}
