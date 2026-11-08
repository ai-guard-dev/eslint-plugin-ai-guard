/**
 * File-path heuristics shared by rules that should stay quiet outside
 * production source (tests, mocks, fixtures, stories, seed scripts).
 */

function normalize(filename: string): string {
  return filename.replace(/\\/g, '/').toLowerCase();
}

const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|__specs__|tests?|specs?|e2e|cypress|playwright)\/|\.(?:test|spec|e2e|cy)\.[cm]?[jt]sx?$/;

const NON_PRODUCTION_PATTERN =
  /(?:^|\/)(?:__mocks__|__fixtures__|mocks?|fixtures?|stories|storybook|\.storybook|seeds?|seeders|examples?|demos?|playground|sandbox|msw)\/|\.(?:stories|story|mock|mocks|fixture|fixtures|seed)\.[cm]?[jt]sx?$|(?:^|\/)seeds?\.[cm]?[jt]sx?$/;

/** Test files: `*.test.ts`, `*.spec.js`, anything under `tests/`, `__tests__/`, `e2e/`. */
export function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERN.test(normalize(filename));
}

/**
 * Test files plus code that exists only to fake or demonstrate data:
 * mocks, fixtures, Storybook stories, seed scripts, examples and demos.
 */
export function isNonProductionFile(filename: string): boolean {
  const normalized = normalize(filename);
  return TEST_FILE_PATTERN.test(normalized) || NON_PRODUCTION_PATTERN.test(normalized);
}
