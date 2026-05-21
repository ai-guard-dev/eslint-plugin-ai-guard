import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

export const noCatchWithoutUse = createRule({
  name: 'no-catch-without-use',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow catch parameters that are never used. AI tools frequently generate `catch (e)` while ignoring the error entirely, which hides actionable debugging context.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      unusedCatchParam:
        'Catch parameter `{{name}}` is never used. AI-generated catch blocks often include an unused error variable that hides missing error handling. Use it, remove it, or add explicit intent.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node) {
        if (!node.param || node.param.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        const catchParamName = node.param.name;

        // `_error` naming is a common convention to intentionally ignore values.
        if (catchParamName.startsWith('_')) {
          return;
        }

        // Token-based check is intentionally conservative: if the identifier appears
        // anywhere in the catch body, we treat it as used to avoid false positives.
        const tokens = context.sourceCode.getTokens(node.body);
        const hasUsage = tokens.some(
          (token) => token.type === 'Identifier' && token.value === catchParamName
        );

        if (!hasUsage) {
          context.report({
            node: node.param,
            messageId: 'unusedCatchParam',
            data: { name: catchParamName },
          });
        }
      },
    };
  },
});

export default noCatchWithoutUse;
