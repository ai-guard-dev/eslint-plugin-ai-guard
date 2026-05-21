// ── Reliability (was: error-handling) ─────────────────────────────────────────
import { noEmptyCatch } from './reliability/no-empty-catch';
import { noBroadException } from './reliability/no-broad-exception';
import { noCatchLogRethrow } from './reliability/no-catch-log-rethrow';
import { noCatchWithoutUse } from './reliability/no-catch-without-use';

// ── Async ──────────────────────────────────────────────────────────────────────
import { noAsyncArrayCallback } from './async/no-async-array-callback';
import { noFloatingPromise } from './async/no-floating-promise';
import { noAwaitInLoop } from './async/no-await-in-loop';
import { noAsyncWithoutAwait } from './async/no-async-without-await';
import { noRedundantAwait } from './async/no-redundant-await';

// ── Security ───────────────────────────────────────────────────────────────────
import { noHardcodedSecret } from './security/no-hardcoded-secret';
import { noEvalDynamic } from './security/no-eval-dynamic';
import { noSqlStringConcat } from './security/no-sql-string-concat';
import { noUnsafeDeserialize } from './security/no-unsafe-deserialize';
import { requireAuthMiddleware } from './security/require-auth-middleware';
import { requireAuthzCheck } from './security/require-authz-check';

// ── AI Patterns (was: quality + logic) ────────────────────────────────────────
import { noConsoleInHandler } from './ai-patterns/no-console-in-handler';
import { noDuplicateLogicBlock } from './ai-patterns/no-duplicate-logic-block';
import { noDeadBranch } from './ai-patterns/no-dead-branch';

/**
 * All rules exported by the plugin.
 * Each key is the rule name (without the plugin prefix).
 *
 * Categories (internal source directories):
 *   reliability/  — error handling & exception patterns
 *   async/        — async/await & promise patterns
 *   security/     — secrets, injection, auth gaps
 *   ai-patterns/  — AI-specific code slop: dead code, quality issues
 */
export const allRules = {
  // Reliability
  'no-empty-catch': noEmptyCatch,
  'no-broad-exception': noBroadException,
  'no-catch-log-rethrow': noCatchLogRethrow,
  'no-catch-without-use': noCatchWithoutUse,
  // Async
  'no-async-array-callback': noAsyncArrayCallback,
  'no-floating-promise': noFloatingPromise,
  'no-await-in-loop': noAwaitInLoop,
  'no-async-without-await': noAsyncWithoutAwait,
  'no-redundant-await': noRedundantAwait,
  // Security
  'no-hardcoded-secret': noHardcodedSecret,
  'no-eval-dynamic': noEvalDynamic,
  'no-sql-string-concat': noSqlStringConcat,
  'no-unsafe-deserialize': noUnsafeDeserialize,
  'require-auth-middleware': requireAuthMiddleware,
  'require-authz-check': requireAuthzCheck,
  // AI Patterns
  'no-console-in-handler': noConsoleInHandler,
  'no-duplicate-logic-block': noDuplicateLogicBlock,
  'no-dead-branch': noDeadBranch,
} as const;

export type RuleKey = keyof typeof allRules;
