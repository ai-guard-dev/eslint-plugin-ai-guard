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
    'security-severity'?: string;
    precision?: string;
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
    'security-severity'?: string;
    precision?: string;
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
}): SarifReportingDescriptor['properties'] {
  const confidence = props.confidence ?? 'low';
  return {
    tags: sanitizeSarifTags(props.tags),
    confidence,
    category: props.category ?? 'AI Patterns',
    'security-severity': confidenceToSecuritySeverity(confidence),
    precision: confidenceToPrecision(confidence),
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

export function confidenceToSecuritySeverity(confidence: string | undefined): string {
  switch (confidence) {
    case 'high':          return '8.0';
    case 'medium':        return '5.0';
    case 'low':           return '3.0';
    case 'informational': return '1.0';
    default:              return '3.0';
  }
}

export function confidenceToPrecision(confidence: string | undefined): 'high' | 'medium' | 'low' {
  switch (confidence) {
    case 'high':          return 'high';
    case 'medium':        return 'medium';
    case 'low':           return 'low';
    case 'informational': return 'low';
    default:              return 'low';
  }
}

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

    // Combine base tags + category slug, then deduplicate via sanitizeSarifTags.
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
      'security-severity': confidenceToSecuritySeverity(confidence),
      precision: confidenceToPrecision(confidence),
      ...(asyncRiskType && { asyncRiskType }),
      ...(category && { category }),
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enhance rule tags with GitHub-recognized semantic tags based on rule type.
 * Ensures the tags array is clean and compliant.
 */
export function enhanceTagsWithGitHubSemantics(ruleId: string, baseTags: string[]): string[] {
  const category = ISSUE_CATEGORY[ruleId];
  const tags = [...baseTags];

  if (
    category === 'Security' ||
    ruleId.includes('secret') ||
    ruleId.includes('eval') ||
    ruleId.includes('sql') ||
    ruleId.includes('deserialize') ||
    ruleId.includes('auth')
  ) {
    tags.push('security', 'correctness', 'reliability');
  } else {
    tags.push('correctness', 'reliability');
  }

  return sanitizeSarifTags(tags);
}

/**
 * Centralized normalization layer to guarantee full GitHub Code Scanning compatibility.
 * Matches all required mappings for security-severity, precision, and result levels.
 */
export function normalizeSarifForGitHub(log: SarifLog): SarifLog {
  const normalizedRuns = log.runs.map((run) => {
    // 1. Normalize rules
    const rules = run.tool.driver.rules.map((rule) => {
      const confidence = ISSUE_CONFIDENCE[rule.id];
      const properties = rule.properties || {};

      // Map security-severity and precision
      properties['security-severity'] = confidenceToSecuritySeverity(confidence);
      properties['precision'] = confidenceToPrecision(confidence);

      // Enhance tags with GitHub-recognized semantic tags
      const currentTags = properties.tags || [];
      properties.tags = enhanceTagsWithGitHubSemantics(rule.id, currentTags);

      // Ensure deprecated problem.severity is not present
      delete (properties as any)['problem.severity'];

      // Ensure level is strictly error, warning, note
      const defaultConfiguration = rule.defaultConfiguration || { level: 'warning' };
      let normalizedConfigLevel = defaultConfiguration.level;
      if (!['error', 'warning', 'note', 'none'].includes(normalizedConfigLevel)) {
        normalizedConfigLevel = confidenceToSarifLevel(confidence);
      }
      if (normalizedConfigLevel === 'none') {
        normalizedConfigLevel = 'note';
      }

      return {
        ...rule,
        defaultConfiguration: {
          ...defaultConfiguration,
          level: normalizedConfigLevel,
        },
        properties,
      };
    });

    // 2. Normalize results
    const results = run.results.map((result) => {
      const confidence = ISSUE_CONFIDENCE[result.ruleId];
      const properties = result.properties || {};

      // Map security-severity and precision
      properties['security-severity'] = confidenceToSecuritySeverity(confidence);
      properties['precision'] = confidenceToPrecision(confidence);

      // Normalize result level to strictly error, warning, or note
      let normalizedLevel = result.level;
      if (!['error', 'warning', 'note', 'none'].includes(normalizedLevel)) {
        normalizedLevel = confidenceToSarifLevel(confidence);
      }
      if (normalizedLevel === 'none') {
        normalizedLevel = 'note';
      }

      // Ensure actionable findings use kind "fail", informational hints use kind "informational"
      const kind = confidence === 'informational' ? 'informational' : 'fail';

      return {
        ...result,
        level: normalizedLevel,
        kind,
        properties,
      };
    });

    return {
      ...run,
      tool: {
        ...run.tool,
        driver: {
          ...run.tool.driver,
          rules,
        },
      },
      results,
    };
  });

  return {
    ...log,
    runs: normalizedRuns,
  };
}

/**
 * Convert a RunResult to a SARIF 2.1.0 log object.
 *
 * Only ai-guard findings are included. Ecosystem issues and parser errors
 * are excluded — they are not ai-guard findings and should not appear in
 * Code Scanning results.
 *
 * All output passes through the SARIF sanitizer and central normalizer to guarantee
 * full GitHub compatibility and schema-validity.
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

  // Final sanitization & normalization pass — guarantees GitHub-compatible, schema-valid output
  return normalizeSarifForGitHub(sanitizeSarifLog(log));
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
    securitySeverity: string;
    precision: string;
  }>;
  resultsEmitted: Array<{
    ruleId: string;
    level: string;
    kind: string;
    securitySeverity: string;
    precision: string;
    filePath: string;
    line: number;
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
    const sanitizedTags = enhanceTagsWithGitHubSemantics(id, rawTags);

    return {
      id,
      rawTags,
      sanitizedTags,
      hasDuplicatesInRaw: rawTags.length !== new Set(rawTags).size,
      confidence: confidence ?? 'low',
      category,
      level: confidenceToSarifLevel(confidence),
      securitySeverity: confidenceToSecuritySeverity(confidence),
      precision: confidenceToPrecision(confidence),
    };
  });

  const resultsEmitted: SarifDebugInfo['resultsEmitted'] = [];
  for (const file of result.files) {
    for (const issue of file.issues) {
      const confidence = ISSUE_CONFIDENCE[issue.ruleId];
      resultsEmitted.push({
        ruleId: issue.ruleId,
        level: confidenceToSarifLevel(confidence),
        kind: confidence === 'informational' ? 'informational' : 'fail',
        securitySeverity: confidenceToSecuritySeverity(confidence),
        precision: confidenceToPrecision(confidence),
        filePath: file.filePath,
        line: issue.line,
      });
    }
  }

  return {
    rulesEmitted,
    resultsEmitted,
    totalResults: result.files.reduce((n, f) => n + f.issues.length, 0),
    version: PKG_VERSION,
  };
}
