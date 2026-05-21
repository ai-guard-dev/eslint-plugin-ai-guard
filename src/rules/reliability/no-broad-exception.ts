import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

export const noBroadException = createRule({
  name: 'no-broad-exception',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow overly broad catch clause types such as `catch (e: any)` or `catch (e: unknown)` without narrowing. AI tools frequently use `any` type annotations on catch parameters, hiding the actual error type and preventing proper error handling.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      broadException:
        'Catch parameter has an overly broad type annotation `{{type}}`. AI tools frequently generate `catch (e: any)` which hides the real error type. Use a specific error type or narrow with `instanceof` checks inside the catch block.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node) {
        const param = node.param;
        if (!param) return;

        // Check for explicit type annotation: catch (e: any), catch (e: unknown)
        if (
          param.type === AST_NODE_TYPES.Identifier &&
          param.typeAnnotation &&
          param.typeAnnotation.typeAnnotation
        ) {
          const typeAnnotation = param.typeAnnotation.typeAnnotation;

          // catch (e: any)
          if (typeAnnotation.type === AST_NODE_TYPES.TSAnyKeyword) {
            context.report({
              node: param,
              messageId: 'broadException',
              data: { type: 'any' },
            });
            return;
          }

          // catch (e: unknown) — only flag if the parameter is never narrowed in the body
          if (typeAnnotation.type === AST_NODE_TYPES.TSUnknownKeyword) {
            // Check if the catch body contains instanceof checks or type guards
            const hasNarrowing = checkForNarrowing(node, param.name);
            if (!hasNarrowing) {
              context.report({
                node: param,
                messageId: 'broadException',
                data: { type: 'unknown' },
              });
            }
          }
        }
      },
    };
  },
});

/**
 * Check if the catch block body contains instanceof checks or other narrowing
 * patterns for the given parameter name.
 */
function checkForNarrowing(
  catchClause: { body: { body: readonly { type: string; [key: string]: any }[] } },
  paramName: string
): boolean {
  const bodyStatements = catchClause.body.body;

  for (const stmt of bodyStatements) {
    if (containsInstanceofCheck(stmt, paramName)) {
      return true;
    }
  }
  return false;
}

function containsInstanceofCheck(node: any, paramName: string): boolean {
  if (!node || typeof node !== 'object') return false;

  // Check for: e instanceof SomeError
  if (
    node.type === AST_NODE_TYPES.BinaryExpression &&
    node.operator === 'instanceof' &&
    node.left?.type === AST_NODE_TYPES.Identifier &&
    node.left.name === paramName
  ) {
    return true;
  }

  // Recurse into child nodes
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (containsInstanceofCheck(item, paramName)) return true;
      }
    } else if (child && typeof child === 'object' && child.type) {
      if (containsInstanceofCheck(child, paramName)) return true;
    }
  }
  return false;
}

export default noBroadException;
