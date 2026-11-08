/**
 * Reusable AST helper utilities for rule authors.
 */
import type { TSESTree } from '@typescript-eslint/utils';

/**
 * Check if a node is an async function (any type: declaration, expression, or arrow).
 */
export function isAsyncFunction(
  node: TSESTree.Node
): node is
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression {
  return (
    (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') &&
    node.async
  );
}

function isFunctionNode(node: TSESTree.Node): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

/**
 * True if `predicate` matches `node` or any descendant. With `skipFunctions`,
 * nested function bodies are not entered (their awaits/returns are their own).
 */
export function someDescendant(
  node: TSESTree.Node,
  predicate: (n: TSESTree.Node) => boolean,
  options: { skipFunctions?: boolean } = {}
): boolean {
  const stack: TSESTree.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as TSESTree.Node;
    if (predicate(current)) return true;
    if (options.skipFunctions && current !== node && isFunctionNode(current)) continue;
    for (const key of Object.keys(current)) {
      if (key === 'parent') continue;
      const value = (current as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && 'type' in item) stack.push(item as TSESTree.Node);
        }
      } else if (value && typeof value === 'object' && 'type' in value) {
        stack.push(value as TSESTree.Node);
      }
    }
  }
  return false;
}

/**
 * Array method names that iterate over elements.
 */
export const ARRAY_ITERATION_METHODS = [
  'map',
  'filter',
  'forEach',
  'reduce',
  'flatMap',
  'find',
  'findIndex',
  'some',
  'every',
] as const;

/**
 * Check if a CallExpression is a method call on an object (e.g., arr.map()).
 */
export function isMethodCall(
  node: TSESTree.CallExpression,
  methodName: string
): boolean {
  return (
    node.callee.type === 'MemberExpression' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === methodName
  );
}

/**
 * Check if a CallExpression is a call to one of the given method names.
 */
export function isMethodCallOneOf(
  node: TSESTree.CallExpression,
  methodNames: readonly string[]
): boolean {
  return (
    node.callee.type === 'MemberExpression' &&
    node.callee.property.type === 'Identifier' &&
    methodNames.includes(node.callee.property.name)
  );
}
