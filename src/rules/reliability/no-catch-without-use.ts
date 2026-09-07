import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
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

        // Use AST traversal to detect actual identifier references,
        // not raw text (which would match comments/strings) (M3).
        const hasUsage = containsIdentifierReference(node.body, catchParamName);

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

/**
 * Walk the AST subtree looking for an Identifier node referencing `paramName`.
 * Only actual AST identifier references count — string literals, comments,
 * and property keys of unrelated objects are excluded (M3).
 */
function containsIdentifierReference(node: TSESTree.Node, paramName: string): boolean {
  if (!node) return false;

  if (
    node.type === AST_NODE_TYPES.Identifier &&
    node.name === paramName
  ) {
    // Exclude property keys in non-computed member expressions:
    // obj.error  ←  `error` is a property name, not a variable reference
    const parent = node.parent;
    if (
      parent &&
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.property === node &&
      !parent.computed
    ) {
      // Not a variable reference — it's a property access
    } else {
      return true;
    }
  }

  for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (key === 'parent' || key === 'type') continue;
    if (!value) continue;

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          if (containsIdentifierReference(child as TSESTree.Node, paramName)) return true;
        }
      }
      continue;
    }

    if (typeof value === 'object' && 'type' in value) {
      if (containsIdentifierReference(value as TSESTree.Node, paramName)) return true;
    }
  }

  return false;
}

export default noCatchWithoutUse;
