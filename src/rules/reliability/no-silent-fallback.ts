import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import { getEnvAccess, isGenericSecretEnvName, isImportMetaEnv, isProcessEnv } from '../../utils/env-access';
import { isNonProductionFile } from '../../utils/file-context';
import { someDescendant } from '../../utils/ast-helpers';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/** Test-runner configs legitimately hardcode throwaway secrets. */
const TEST_CONFIG_FILE = /(?:^|[\\/])(?:vitest|jest|playwright|cypress|karma)\.(?:config|setup)[^\\/]*$/i;

/** Fallbacks that are durations or numbers, e.g. `JWT_SECRET_TTL || '15m'`. */
const NON_SECRET_VALUE = /^(?:\d+(?:\.\d+)?[a-z]{0,3}|true|false)$/i;

function getStaticString(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') return node.value;
  if (node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** Leftmost operands of `a || b || 'x'` (same operator), excluding the final fallback. */
function collectPrimaryOperands(node: TSESTree.LogicalExpression): TSESTree.Expression[] {
  const operands: TSESTree.Expression[] = [];
  let current: TSESTree.Expression = node.left;
  while (current.type === AST_NODE_TYPES.LogicalExpression && current.operator === node.operator) {
    operands.unshift(current.right);
    current = current.left;
  }
  operands.unshift(current);
  return operands;
}

const ENVIRONMENT_ENV_NAME = /^(?:NODE_ENV|APP_ENV|ENVIRONMENT|ENV|VERCEL_ENV|DEV|PROD|MODE)$/;
const ENVIRONMENT_FLAG_NAME = /^(?:is)?(?:dev|development|local|test|testing|debug)(?:mode|env|build)?$/i;

function containsEnvironmentCheck(node: TSESTree.Node): boolean {
  return someDescendant(node, (n) => {
    const access = getEnvAccess(n);
    if (access) return ENVIRONMENT_ENV_NAME.test(access.name);
    return n.type === AST_NODE_TYPES.Identifier && ENVIRONMENT_FLAG_NAME.test(n.name);
  });
}

/** Inside `if (process.env.NODE_ENV !== 'production') { ... }` or `isDev ? ... : ...`. */
function isGuardedByEnvironmentCheck(node: TSESTree.Node): boolean {
  let child: TSESTree.Node = node;
  let parent = node.parent;
  while (parent) {
    if (parent.type === AST_NODE_TYPES.IfStatement && parent.test !== child && containsEnvironmentCheck(parent.test)) {
      return true;
    }
    if (parent.type === AST_NODE_TYPES.ConditionalExpression && parent.test !== child && containsEnvironmentCheck(parent.test)) {
      return true;
    }
    if (parent.type === AST_NODE_TYPES.LogicalExpression && parent.right === child && containsEnvironmentCheck(parent.left)) {
      return true;
    }
    if (
      parent.type === AST_NODE_TYPES.FunctionDeclaration ||
      parent.type === AST_NODE_TYPES.FunctionExpression ||
      parent.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return false;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** Awaits inside nested functions belong to those functions, not this try block. */
function containsAwait(node: TSESTree.Node): boolean {
  return someDescendant(node, (n) => n.type === AST_NODE_TYPES.AwaitExpression, { skipFunctions: true });
}

function emptyCollection(node: TSESTree.Expression | null): '[]' | '{}' | null {
  if (!node) return null;
  if (node.type === AST_NODE_TYPES.ArrayExpression && node.elements.length === 0) return '[]';
  if (node.type === AST_NODE_TYPES.ObjectExpression && node.properties.length === 0) return '{}';
  if (node.type === AST_NODE_TYPES.TSAsExpression) return emptyCollection(node.expression);
  return null;
}

function displayValue(value: string): string {
  return value.length > 24 ? `${value.slice(0, 21)}...` : value;
}

type MessageIds = 'hardcodedSecretFallback' | 'swallowedFailure';

export const noSilentFallback = createRule<[], MessageIds>({
  name: 'no-silent-fallback',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow fallbacks that hide failures: secret env vars that default to a hardcoded value (`process.env.JWT_SECRET || "secret"`) and catch blocks that turn a failed awaited call into an empty result (`catch { return [] }`). AI tools add these to make code run without configuration or to make an error go away, and the failure resurfaces later as forged tokens or silently empty data.',
    },
    schema: [],
    messages: {
      hardcodedSecretFallback:
        '`{{name}}` falls back to the hardcoded value "{{value}}" when the env var is missing. In production that means running with a secret anyone can read in the repository (for a JWT secret, anyone can forge tokens). Fail at startup instead: `if (!process.env.{{name}}) throw new Error("{{name}} is not set")`.',
      swallowedFailure:
        'This catch block turns any failure of the awaited call into `{{value}}`. Callers cannot tell "no data" from "the request failed", and the error is never logged. Log and rethrow, or return an explicit error state the caller must handle.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.physicalFilename || context.filename;
    if (isNonProductionFile(filename) || TEST_CONFIG_FILE.test(filename)) return {};

    function reportSecretFallback(node: TSESTree.Node, name: string, value: string): void {
      if (value.trim() === '' || NON_SECRET_VALUE.test(value.trim())) return;
      if (isGuardedByEnvironmentCheck(node)) return;
      context.report({
        node,
        messageId: 'hardcodedSecretFallback',
        data: { name, value: displayValue(value) },
      });
    }

    return {
      LogicalExpression(node): void {
        if (node.operator !== '||' && node.operator !== '??') return;
        // Only the outermost expression of a chain carries the final fallback.
        if (node.parent.type === AST_NODE_TYPES.LogicalExpression && node.parent.left === node && node.parent.operator === node.operator) {
          return;
        }
        const value = getStaticString(node.right);
        if (value === null) return;

        const secretName = collectPrimaryOperands(node)
          .map((operand) => getEnvAccess(operand))
          .find((access) => access !== null && isGenericSecretEnvName(access.name))?.name;
        if (!secretName) return;

        reportSecretFallback(node, secretName, value);
      },

      // process.env.JWT_SECRET ? process.env.JWT_SECRET : 'dev-secret'
      ConditionalExpression(node): void {
        const tested = getEnvAccess(node.test);
        const used = getEnvAccess(node.consequent);
        if (!tested || !used || tested.name !== used.name || !isGenericSecretEnvName(tested.name)) return;
        const value = getStaticString(node.alternate);
        if (value === null) return;
        reportSecretFallback(node, tested.name, value);
      },

      // const { JWT_SECRET = 'dev-secret' } = process.env;
      VariableDeclarator(node): void {
        if (!node.init || node.id.type !== AST_NODE_TYPES.ObjectPattern) return;
        if (!isProcessEnv(node.init) && !isImportMetaEnv(node.init)) return;
        for (const property of node.id.properties) {
          if (property.type !== AST_NODE_TYPES.Property) continue;
          if (property.value.type !== AST_NODE_TYPES.AssignmentPattern) continue;
          if (property.key.type !== AST_NODE_TYPES.Identifier) continue;
          const name = property.key.name;
          if (!isGenericSecretEnvName(name)) continue;
          const value = getStaticString(property.value.right);
          if (value === null) continue;
          reportSecretFallback(property, name, value);
        }
      },

      CatchClause(node): void {
        const statements = node.body.body;
        if (statements.length !== 1) return;
        const only = statements[0];
        if (only.type !== AST_NODE_TYPES.ReturnStatement) return;
        const value = emptyCollection(only.argument);
        if (!value) return;
        // A comment in the catch documents that the fallback is deliberate.
        if (context.sourceCode.getCommentsInside(node.body).length > 0) return;

        const tryStatement = node.parent;
        if (tryStatement.type !== AST_NODE_TYPES.TryStatement || !containsAwait(tryStatement.block)) return;

        context.report({ node: only, messageId: 'swallowedFailure', data: { value } });
      },
    };
  },
});

export default noSilentFallback;
