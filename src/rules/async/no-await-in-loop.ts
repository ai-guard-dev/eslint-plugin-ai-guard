import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import path from 'path';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

const LOOP_TYPES = new Set([
  AST_NODE_TYPES.ForStatement,
  AST_NODE_TYPES.ForInStatement,
  AST_NODE_TYPES.ForOfStatement,
  AST_NODE_TYPES.WhileStatement,
  AST_NODE_TYPES.DoWhileStatement,
]);

const SUPPRESSION_REGEX = /ai-guard-disable\s+no-await-in-loop\b/i;

const RETRY_NAME_REGEX = /(retry|retries|attempt|attempts|fallback|tryagain|recovery)/i;
const SEQUENTIAL_DEPENDENCY_NAME_REGEX = /(previous|prev|last|carry|accumulator|stateful)/i;
// Simulation, animation, and step-by-step patterns — sequential await is intentional
const SIMULATION_NAME_REGEX = /(simulat|animat|demo|visuali|step|scene|frame|render|tick|sequence|tutorial|lesson|walk)/i;

const ERROR_CODE_HINTS = [
  'access-denied',
  'timeout',
  'rate-limit',
  'not-found',
];

const CONTROL_AWAIT_HINTS = [
  'sleep',
  'delay',
  'wait',
  'throttle',
  'ratelimit',
  'backoff',
];

// Timer calls inside a loop indicate intentional sequencing (animation/polling)
const TIMER_FUNCTION_NAMES = new Set([
  'setinterval',
  'settimeout',
  'requestanimationframe',
  'queuemicrotask',
  'sleep',
  'delay',
  'wait',
]);

const MUTATION_METHOD_NAMES = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'set',
  'add',
  'delete',
  'clear',
]);

type LoopNode =
  | TSESTree.ForStatement
  | TSESTree.ForInStatement
  | TSESTree.ForOfStatement
  | TSESTree.WhileStatement
  | TSESTree.DoWhileStatement;

interface IntentAnalysis {
  isIndependent: boolean;
}

function isFunctionNode(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  );
}

function isNodeLike(value: unknown): value is TSESTree.Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function walkNode(
  node: TSESTree.Node,
  visitor: (current: TSESTree.Node) => void,
  skipNestedFunctions: boolean,
  isRoot = true,
): void {
  visitor(node);

  for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (key === 'parent' || !value) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isNodeLike(item)) continue;
        if (skipNestedFunctions && !isRoot && isFunctionNode(item)) continue;
        walkNode(item, visitor, skipNestedFunctions, false);
      }
      continue;
    }

    if (!isNodeLike(value)) continue;
    if (skipNestedFunctions && !isRoot && isFunctionNode(value)) continue;
    walkNode(value, visitor, skipNestedFunctions, false);
  }
}

function collectPatternNames(pattern: TSESTree.Node, bucket: Set<string>): void {
  if (pattern.type === AST_NODE_TYPES.Identifier) {
    bucket.add(pattern.name);
    return;
  }

  if (pattern.type === AST_NODE_TYPES.AssignmentPattern) {
    collectPatternNames(pattern.left, bucket);
    return;
  }

  if (pattern.type === AST_NODE_TYPES.RestElement) {
    collectPatternNames(pattern.argument, bucket);
    return;
  }

  if (pattern.type === AST_NODE_TYPES.ArrayPattern) {
    for (const element of pattern.elements) {
      if (!element) continue;
      if (element.type === AST_NODE_TYPES.RestElement) {
        collectPatternNames(element.argument, bucket);
        continue;
      }
      collectPatternNames(element, bucket);
    }
    return;
  }

  if (pattern.type === AST_NODE_TYPES.ObjectPattern) {
    for (const prop of pattern.properties) {
      if (prop.type === AST_NODE_TYPES.RestElement) {
        collectPatternNames(prop.argument, bucket);
        continue;
      }
      collectPatternNames(prop.value, bucket);
    }
  }
}

function getLoopNodeName(type: AST_NODE_TYPES): string {
  switch (type) {
    case AST_NODE_TYPES.ForStatement:
      return 'for loop';
    case AST_NODE_TYPES.ForInStatement:
      return 'for...in loop';
    case AST_NODE_TYPES.ForOfStatement:
      return 'for...of loop';
    case AST_NODE_TYPES.WhileStatement:
      return 'while loop';
    case AST_NODE_TYPES.DoWhileStatement:
      return 'do...while loop';
    default:
      return 'loop';
  }
}

function hasSuppressionComment(comments: readonly TSESTree.Comment[]): boolean {
  return comments.some((comment) => SUPPRESSION_REGEX.test(comment.value));
}

function hasFileSuppression(sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  return hasSuppressionComment(sourceCode.getAllComments());
}

function hasLoopSuppression(
  loopNode: LoopNode,
  sourceCode: Readonly<TSESLint.SourceCode>,
): boolean {
  const commentsBefore = sourceCode.getCommentsBefore(loopNode);
  if (hasSuppressionComment(commentsBefore)) {
    return true;
  }

  const allComments = sourceCode.getAllComments();
  const nearComments = allComments.filter((comment) => {
    if (!comment.range || !loopNode.range) {
      return false;
    }

    const [, commentEnd] = comment.range;
    const [loopStart] = loopNode.range;
    return commentEnd <= loopStart && loopStart - commentEnd < 160;
  });

  return hasSuppressionComment(nearComments);
}

function getCalleeName(callee: TSESTree.Node): string | null {
  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name;
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return callee.property.name;
  }

  return null;
}

function getRootIdentifierName(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }

  if (node.type === AST_NODE_TYPES.MemberExpression) {
    return getRootIdentifierName(node.object);
  }

  return null;
}

function collectLocalBindings(loopNode: LoopNode): Set<string> {
  const bindings = new Set<string>();

  if (loopNode.type === AST_NODE_TYPES.ForStatement && loopNode.init?.type === AST_NODE_TYPES.VariableDeclaration) {
    for (const decl of loopNode.init.declarations) {
      collectPatternNames(decl.id, bindings);
    }
  }

  if (
    (loopNode.type === AST_NODE_TYPES.ForOfStatement || loopNode.type === AST_NODE_TYPES.ForInStatement) &&
    loopNode.left.type === AST_NODE_TYPES.VariableDeclaration
  ) {
    for (const decl of loopNode.left.declarations) {
      collectPatternNames(decl.id, bindings);
    }
  }

  walkNode(
    loopNode.body,
    (node) => {
      if (node.type === AST_NODE_TYPES.VariableDeclarator) {
        collectPatternNames(node.id, bindings);
      }

      if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
        bindings.add(node.id.name);
      }
    },
    true,
  );

  return bindings;
}

function collectSiblingStatements(loopNode: LoopNode): TSESTree.Statement[] {
  if (!loopNode.parent || loopNode.parent.type !== AST_NODE_TYPES.BlockStatement) {
    return [];
  }

  const siblings = loopNode.parent.body;
  const idx = siblings.findIndex((stmt) => stmt === loopNode);
  if (idx === -1) return [];

  const result: TSESTree.Statement[] = [];
  if (idx > 0) result.push(siblings[idx - 1]);
  if (idx < siblings.length - 1) result.push(siblings[idx + 1]);
  return result;
}

function nodeContainsErrorCodeHint(node: TSESTree.Node): boolean {
  let found = false;

  walkNode(
    node,
    (current) => {
      if (found) return;
      if (current.type !== AST_NODE_TYPES.Literal || typeof current.value !== 'string') {
        return;
      }

      const lower = current.value.toLowerCase();
      if (ERROR_CODE_HINTS.some((hint) => lower.includes(hint))) {
        found = true;
      }
    },
    true,
  );

  return found;
}

function analyzeIntent(loopNode: LoopNode): IntentAnalysis {
  if (loopNode.type === AST_NODE_TYPES.ForOfStatement && loopNode.await) {
    return { isIndependent: false };
  }

  const localBindings = collectLocalBindings(loopNode);
  const siblingStatements = collectSiblingStatements(loopNode);

  let hasRetryNameHint = false;
  let hasCounterIncrement = false;
  let hasEarlyExit = false;
  let hasCatchContinue = false;
  let hasErrorCodeHint = false;
  let hasSequentialDependency = false;
  let hasControlAwait = false;

  const checkIdentifierName = (name: string): void => {
    if (RETRY_NAME_REGEX.test(name)) {
      hasRetryNameHint = true;
    }

    if (SEQUENTIAL_DEPENDENCY_NAME_REGEX.test(name)) {
      hasSequentialDependency = true;
    }

    // Simulation/animation/step names indicate intentional sequential behavior
    if (SIMULATION_NAME_REGEX.test(name)) {
      hasSequentialDependency = true;
    }
  };

  walkNode(
    loopNode,
    (node) => {
      if (node.type === AST_NODE_TYPES.Identifier) {
        checkIdentifierName(node.name);
      }

      if (node.type === AST_NODE_TYPES.AwaitExpression &&
        node.argument.type === AST_NODE_TYPES.CallExpression
      ) {
        const calleeName = getCalleeName(node.argument.callee);
        if (calleeName) {
          const lower = calleeName.toLowerCase();
          if (CONTROL_AWAIT_HINTS.some((hint) => lower.includes(hint))) {
            hasControlAwait = true;
          }
          // Awaiting a timer function = intentional sequencing
          if (TIMER_FUNCTION_NAMES.has(lower)) {
            hasControlAwait = true;
          }
        }
      }

      if (node.type === AST_NODE_TYPES.UpdateExpression) {
        const target = node.argument;
        if (target.type === AST_NODE_TYPES.Identifier) {
          checkIdentifierName(target.name);
          if (RETRY_NAME_REGEX.test(target.name)) {
            hasCounterIncrement = true;
          }
          if (!localBindings.has(target.name)) {
            hasSequentialDependency = true;
          }
        }
      }

      if (node.type === AST_NODE_TYPES.AssignmentExpression) {
        if (node.left.type === AST_NODE_TYPES.Identifier) {
          checkIdentifierName(node.left.name);
          if (RETRY_NAME_REGEX.test(node.left.name)) {
            hasCounterIncrement = true;
          }
          if (!localBindings.has(node.left.name)) {
            hasSequentialDependency = true;
          }
        }

        if (node.left.type === AST_NODE_TYPES.MemberExpression) {
          const root = getRootIdentifierName(node.left.object);
          if (root && !localBindings.has(root)) {
            hasSequentialDependency = true;
          }
        }
      }

      if (
        node.type === AST_NODE_TYPES.ReturnStatement ||
        node.type === AST_NODE_TYPES.BreakStatement ||
        node.type === AST_NODE_TYPES.ContinueStatement
      ) {
        hasEarlyExit = true;
      }

      if (node.type === AST_NODE_TYPES.TryStatement && node.handler) {
        let catchHasContinue = false;
        walkNode(
          node.handler.body,
          (catchNode) => {
            if (catchNode.type === AST_NODE_TYPES.ContinueStatement) {
              catchHasContinue = true;
            }
          },
          true,
        );

        if (catchHasContinue) {
          hasCatchContinue = true;
        }
      }

      if (node.type === AST_NODE_TYPES.CallExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.property.type === AST_NODE_TYPES.Identifier
        ) {
          const method = node.callee.property.name.toLowerCase();
          if (MUTATION_METHOD_NAMES.has(method)) {
            const root = getRootIdentifierName(node.callee.object);
            if (root && !localBindings.has(root)) {
              hasSequentialDependency = true;
            }
          }
        }
      }

      if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') {
        const lower = node.value.toLowerCase();
        if (ERROR_CODE_HINTS.some((hint) => lower.includes(hint))) {
          hasErrorCodeHint = true;
        }
      }
    },
    true,
  );

  if (!hasRetryNameHint && siblingStatements.length > 0) {
    for (const sibling of siblingStatements) {
      if (nodeContainsErrorCodeHint(sibling)) {
        hasErrorCodeHint = true;
      }

      walkNode(
        sibling,
        (node) => {
          if (node.type === AST_NODE_TYPES.Identifier) {
            checkIdentifierName(node.name);
          }
        },
        true,
      );
    }
  }

  const hasRetryOrFallbackIntent =
    hasRetryNameHint ||
    hasCounterIncrement ||
    hasEarlyExit ||
    hasCatchContinue ||
    hasErrorCodeHint ||
    hasSequentialDependency ||
    hasControlAwait;

  return {
    isIndependent: !hasRetryOrFallbackIntent,
  };
}

function getLoopBodyStatements(loopNode: LoopNode): TSESTree.Statement[] {
  return loopNode.body.type === AST_NODE_TYPES.BlockStatement
    ? loopNode.body.body
    : [loopNode.body];
}

function getForOfParamName(loopNode: TSESTree.ForOfStatement): string | null {
  if (loopNode.left.type === AST_NODE_TYPES.Identifier) {
    return loopNode.left.name;
  }

  if (loopNode.left.type === AST_NODE_TYPES.VariableDeclaration) {
    if (loopNode.left.declarations.length !== 1) return null;
    const id = loopNode.left.declarations[0].id;
    if (id.type !== AST_NODE_TYPES.Identifier) return null;
    return id.name;
  }

  return null;
}

function buildSafeAutofix(
  loopNode: LoopNode,
  awaitNode: TSESTree.AwaitExpression,
  sourceCode: Readonly<TSESLint.SourceCode>,
): string | null {
  if (
    !loopNode.parent ||
    loopNode.parent.type !== AST_NODE_TYPES.BlockStatement ||
    !loopNode.parent.parent ||
    !isFunctionNode(loopNode.parent.parent)
  ) {
    return null;
  }

  if (loopNode.type !== AST_NODE_TYPES.ForOfStatement || loopNode.await) {
    return null;
  }

  const loopStatements = getLoopBodyStatements(loopNode);
  if (loopStatements.length !== 1) {
    return null;
  }

  const onlyStatement = loopStatements[0];
  if (
    onlyStatement.type !== AST_NODE_TYPES.ExpressionStatement ||
    onlyStatement.expression.type !== AST_NODE_TYPES.AwaitExpression ||
    onlyStatement.expression !== awaitNode ||
    onlyStatement.expression.argument.type !== AST_NODE_TYPES.CallExpression
  ) {
    return null;
  }

  const paramName = getForOfParamName(loopNode);
  if (!paramName) {
    return null;
  }

  const iterableText = sourceCode.getText(loopNode.right);
  const awaitedCallText = sourceCode.getText(onlyStatement.expression.argument);

  return `await Promise.all(${iterableText}.map(async (${paramName}) => await ${awaitedCallText}));`;
}

export const noAwaitInLoop = createRule({
  name: 'no-await-in-loop',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow independent `await` usage inside loops, while allowing intentional retry/fallback/sequential workflows. AI tools frequently generate accidental sequential awaits where Promise.all would be safer and faster. Includes a safe autofix for simple independent loops.',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          allowPatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'File glob patterns to skip (e.g., **/*.test.ts, **/simulation/**)',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      awaitInLoop:
        'Sequential `await` inside a {{loopType}} — if these items are independent, consider `Promise.all()` for parallel execution. If sequential order matters, this may be intentional.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    if (hasFileSuppression(context.sourceCode)) {
      return {};
    }

    // File-level suppression: test files and simulation/demo files use sequential await intentionally
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const fileBasename = path.basename(filename).toLowerCase();
    const filePath = filename.toLowerCase();

    const isTestFile =
      fileBasename.includes('.test.') ||
      fileBasename.includes('.spec.') ||
      filePath.includes('/__tests__/') ||
      filePath.includes('/test/') ||
      filePath.includes('/tests/');

    const isSimulationFile =
      SIMULATION_NAME_REGEX.test(fileBasename) ||
      filePath.includes('/simulation/') ||
      filePath.includes('/demo/') ||
      filePath.includes('/animation/') ||
      filePath.includes('/fixtures/');

    // Suppress entirely for test and simulation files
    if (isTestFile || isSimulationFile) {
      return {};
    }

    // Check user-provided allowPatterns (basic suffix/substring matching)
    const { allowPatterns = [] } = options as { allowPatterns?: string[] };
    for (const pattern of allowPatterns) {
      // Simple pattern: if file path contains the non-glob part
      const cleaned = pattern.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\//g, path.sep);
      if (cleaned && filePath.includes(cleaned.toLowerCase())) {
        return {};
      }
    }

    const loopIntentCache = new WeakMap<LoopNode, IntentAnalysis>();
    const reportedLoops = new WeakSet<LoopNode>();

    /**
     * Track ancestor scope boundaries (functions) so we don't flag await
     * expressions inside a nested async function that happens to be inside a loop.
     */
    const functionBoundary: TSESTree.Node[] = [];

    function enterFunction(node: TSESTree.Node) {
      functionBoundary.push(node);
    }
    function exitFunction() {
      functionBoundary.pop();
    }

    return {
      FunctionDeclaration: enterFunction,
      FunctionExpression: enterFunction,
      ArrowFunctionExpression: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      'FunctionExpression:exit': exitFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      AwaitExpression(node) {
        // Walk up ancestors looking for a loop, but stop at any function boundary
        const ancestors = context.sourceCode.getAncestors(node);
        const currentFunction = functionBoundary[functionBoundary.length - 1];

        let enclosingLoop: LoopNode | null = null;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const ancestor = ancestors[i];

          // Stop if we hit the current function boundary
          if (ancestor === currentFunction) {
            break;
          }

          if (LOOP_TYPES.has(ancestor.type as AST_NODE_TYPES)) {
            enclosingLoop = ancestor as LoopNode;
            break;
          }
        }

        if (!enclosingLoop) {
          return;
        }

        if (reportedLoops.has(enclosingLoop)) {
          return;
        }

        if (hasLoopSuppression(enclosingLoop, context.sourceCode)) {
          return;
        }

        const intent = loopIntentCache.get(enclosingLoop) ?? analyzeIntent(enclosingLoop);
        loopIntentCache.set(enclosingLoop, intent);

        // Intent-aware behavior:
        // retry/fallback/sequential loops are suppressed (no report).
        if (!intent.isIndependent) {
          return;
        }

        const fixText = buildSafeAutofix(enclosingLoop, node, context.sourceCode);
        const loopName = getLoopNodeName(enclosingLoop.type as AST_NODE_TYPES);

        context.report({
          node,
          messageId: 'awaitInLoop',
          data: { loopType: loopName },
          fix:
            fixText === null
              ? undefined
              : (fixer) => fixer.replaceText(enclosingLoop as unknown as TSESTree.Node, fixText),
        });

        reportedLoops.add(enclosingLoop);
      },
    };
  },
});

export default noAwaitInLoop;
