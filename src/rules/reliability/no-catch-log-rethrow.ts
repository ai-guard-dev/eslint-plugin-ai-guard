import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

function isConsoleCallStatement(statement: TSESTree.Statement): boolean {
  if (statement.type !== AST_NODE_TYPES.ExpressionStatement) {
    return false;
  }

  const expression = statement.expression;
  if (expression.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  if (expression.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }

  return (
    expression.callee.object.type === AST_NODE_TYPES.Identifier &&
    expression.callee.object.name === 'console' &&
    expression.callee.property.type === AST_NODE_TYPES.Identifier &&
    ['log', 'error', 'warn', 'info', 'debug'].includes(expression.callee.property.name)
  );
}

function isRethrowOfCatchParam(
  statement: TSESTree.Statement,
  catchParamName: string
): boolean {
  return (
    statement.type === AST_NODE_TYPES.ThrowStatement &&
    statement.argument !== null &&
    statement.argument.type === AST_NODE_TYPES.Identifier &&
    statement.argument.name === catchParamName
  );
}

export const noCatchLogRethrow = createRule({
  name: 'no-catch-log-rethrow',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow catch blocks that only log and rethrow the same error. AI tools frequently generate catch-log-rethrow patterns that add noise without recovery or context.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      catchLogRethrow:
        'This catch block only logs and rethrows the same error. AI tools frequently generate this noisy pattern without adding recovery. Either remove the catch block or add meaningful handling/context.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node) {
        if (!node.param || node.param.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        const bodyStatements = node.body.body;
        if (bodyStatements.length < 2) {
          return;
        }

        const lastStatement = bodyStatements[bodyStatements.length - 1];
        if (!isRethrowOfCatchParam(lastStatement, node.param.name)) {
          return;
        }

        const leadingStatements = bodyStatements.slice(0, -1);
        const allConsoleCalls = leadingStatements.every(isConsoleCallStatement);

        if (allConsoleCalls) {
          context.report({
            node,
            messageId: 'catchLogRethrow',
          });
        }
      },
    };
  },
});

export default noCatchLogRethrow;
