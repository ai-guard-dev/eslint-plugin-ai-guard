import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/**
 * Checks if a node is the boolean literal `true` or `false`.
 */
function isBooleanLiteral(node: TSESTree.Node, value: boolean): boolean {
  return (
    node.type === AST_NODE_TYPES.Literal &&
    typeof node.value === 'boolean' &&
    node.value === value
  );
}

/**
 * Checks if a node is a numeric literal equal to zero.
 */
function isZeroLiteral(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.Literal &&
    typeof node.value === 'number' &&
    node.value === 0
  );
}

/**
 * Checks if a node is the string literal `""` or `''`.
 */
function isEmptyStringLiteral(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.Literal &&
    typeof node.value === 'string' &&
    node.value === ''
  );
}

/**
 * Returns true if the condition is statically always-true or always-false.
 * Handles:
 *   - `if (true)` / `if (false)`
 *   - `if (1)` / `if (0)`
 *   - `while (true)` (intentional infinite loops are common, so we exempt them)
 *   - `if (x && !x)` / `if (x || !x)` — self-contradictory / self-tautological
 *   - `x === x` when x is an identifier (trivially true)
 */
function isAlwaysTrue(node: TSESTree.Node): boolean {
  if (isBooleanLiteral(node, true)) return true;

  // x || !x is always true
  if (
    node.type === AST_NODE_TYPES.LogicalExpression &&
    node.operator === '||'
  ) {
    const { left, right } = node;
    if (
      left.type === AST_NODE_TYPES.Identifier &&
      right.type === AST_NODE_TYPES.UnaryExpression &&
      right.operator === '!' &&
      right.argument.type === AST_NODE_TYPES.Identifier &&
      left.name === right.argument.name
    ) {
      return true;
    }
  }

  // x === x (same identifier compared to itself)
  if (
    node.type === AST_NODE_TYPES.BinaryExpression &&
    (node.operator === '===' || node.operator === '==') &&
    node.left.type === AST_NODE_TYPES.Identifier &&
    node.right.type === AST_NODE_TYPES.Identifier &&
    node.left.name === node.right.name
  ) {
    return true;
  }

  return false;
}

function isAlwaysFalse(node: TSESTree.Node): boolean {
  if (isBooleanLiteral(node, false)) return true;
  if (isZeroLiteral(node)) return true;
  if (isEmptyStringLiteral(node)) return true;

  // x && !x is always false
  if (
    node.type === AST_NODE_TYPES.LogicalExpression &&
    node.operator === '&&'
  ) {
    const { left, right } = node;
    if (
      left.type === AST_NODE_TYPES.Identifier &&
      right.type === AST_NODE_TYPES.UnaryExpression &&
      right.operator === '!' &&
      right.argument.type === AST_NODE_TYPES.Identifier &&
      left.name === right.argument.name
    ) {
      return true;
    }
  }

  // x !== x (same identifier compared to itself with strict inequality)
  if (
    node.type === AST_NODE_TYPES.BinaryExpression &&
    (node.operator === '!==' || node.operator === '!=') &&
    node.left.type === AST_NODE_TYPES.Identifier &&
    node.right.type === AST_NODE_TYPES.Identifier &&
    node.left.name === node.right.name
  ) {
    return true;
  }

  return false;
}

export const noDeadBranch = createRule({
  name: 'no-dead-branch',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow conditions that are statically always-true or always-false. AI tools frequently generate dead branches like `if (true)`, `if (false)`, `if (x && !x)`, or `x === x` — leftover scaffolding that clutters the code and hides logical errors.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      alwaysTrue:
        'This condition is always `true` — the branch is never skipped. AI tools often generate this as leftover scaffolding. Remove the condition or replace it with the intended logic.',
      alwaysFalse:
        'This condition is always `false` — this branch is dead and never executed. AI tools often generate this as leftover scaffolding. Remove the dead branch entirely.',
      whileFalse:
        'This `while (false)` loop never executes. AI tools sometimes generate this as a placeholder. Remove it or replace with the intended loop condition.',
    },
  },
  defaultOptions: [],
  create(context) {
    function checkCondition(
      testNode: TSESTree.Expression | null,
      reportNode: TSESTree.Node,
      isBranchStatement: boolean,
    ): void {
      if (!testNode) return;

      if (isAlwaysFalse(testNode)) {
        context.report({
          node: reportNode,
          messageId: isBranchStatement ? 'alwaysFalse' : 'whileFalse',
        });
        return;
      }

      if (isAlwaysTrue(testNode)) {
        // while (true) is a common and intentional pattern for event loops
        // and retry mechanisms — don't flag it.
        if (reportNode.type === AST_NODE_TYPES.WhileStatement) return;

        context.report({
          node: reportNode,
          messageId: 'alwaysTrue',
        });
      }
    }

    return {
      IfStatement(node) {
        checkCondition(node.test, node, true);
      },

      WhileStatement(node) {
        // while (false) is always dead
        if (isAlwaysFalse(node.test)) {
          context.report({ node, messageId: 'whileFalse' });
        }
        // while (true) is intentional — skip
      },

      DoWhileStatement(node) {
        // do { ... } while (false) is a common C trick but AI tools
        // sometimes generate it erroneously in JS
        if (isAlwaysFalse(node.test)) {
          context.report({ node, messageId: 'whileFalse' });
        }
      },

      ConditionalExpression(node) {
        checkCondition(node.test, node, true);
      },
    };
  },
});

export default noDeadBranch;
