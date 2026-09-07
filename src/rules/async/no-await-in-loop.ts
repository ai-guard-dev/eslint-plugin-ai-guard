import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import path from 'path';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
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
// Simulation, animation, and step-by-step patterns â€” sequential await is intentional
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
  | TSESTree.doWhileStatement;

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
        hasEarlyExit€ôÑÉÕ”ì(€€€€€ô((€€€€€¥˜€¡¹½‘”¹ÑåÁ”€ôôôMQ}9=}QeAL¹QÉåMÑ…Ñ•µ•¹Ð€˜˜¹½‘”¹¡…¹‘±•È¤ì(€€€€€€€±•Ð…Ñ¡!…Í½¹Ñ¥¹Õ”€ô™…±Í”ì(€€€€€€€Ý…±­9½‘” (€€€€€€€€€¹½‘”¹¡…¹‘±•È¹‰½‘ä°(€€€€€€€€€€¡…Ñ¡9½‘”¤€ôøì(€€€€€€€€€€€¥˜€¡…Ñ¡9½‘”¹ÑåÁ”€ôôôMQ}9=}QeAL¹½¹Ñ¥¹Õ•MÑ…Ñ•µ•¹Ð¤ì(€€€€€€€€€€€€€…Ñ¡!…Í½¹Ñ¥¹Õ”€ôÑÉÕ”ì(€€€€€€€€€€€ô(€€€€€€€€€ô°(€€€€€€€€€ÑÉÕ”°(€€€€€€€€¤ì((€€€€€€€¥˜€¡…Ñ¡!…Í½¹Ñ¥¹Õ”¤ì(€€€€€€€€€¡…Í…Ñ¡½¹Ñ¥¹Õ”€ôÑÉÕ”ì(€€€€€€€ô(€€€€€ô((€€€€€¥˜€¡¹½‘”¹ÑåÁ”€ôôôMQ}9=}QeAL¹…±±áÁÉ•ÍÍ¥½¸¤ì(€€€€€€€¥˜€ (€€€€€€€€€¹½‘”¹…±±•”¹ÑåÁ”€ôôôMQ}9=}QeAL¹5•µ‰•ÉáÁÉ•ÍÍ¥½¸€˜˜(€€€€€€€€€¹½‘”¹…±±•”¹ÁÉ½Á•ÉÑä¹ÑåÁ”€ôôôMQ}9=}QeAL¹%‘•¹Ñ¥™¥•È(€€€€€€€€¤ì(€€€€€€€€€½¹ÍÐµ•Ñ¡½€ô¹½‘”¹…±±•”¹ÁÉ½Á•ÉÑä¹¹…µ”¹Ñ½1½Ý•É…Í” ¤ì(€€€€€€€€€¥˜€¡5UQQ%=9}5Q!=}95L¹¡…Ì¡µ•Ñ¡½¤¤ì(€€€€€€€€€€€½¹ÍÐÉ½½Ð€ô•ÑI½½Ñ%‘•¹Ñ¥™¥•É9…µ”¡¹½‘”¹…±±•”¹½‰©•Ð¤ì(€€€€€€€€€€€¥˜€¡É½½Ð€˜˜€…±½…±	¥¹‘¥¹Ì¹¡…Ì¡É½½Ð¤¤ì(€€€€€€€€€€€€€¡…ÍM•ÅÕ•¹Ñ¥…±•Á•¹‘•¹ä€ôÑÉÕ”ì(€€€€€€€€€€€ô(€€€€€€€€€ô(€€€€€€€ô(€€€€€ô((€€€€€¥˜€¡¹½‘”¹ÑåÁ”€ôôôMQ}9=}QeAL¹1¥Ñ•É…°€˜˜ÑåÁ•½˜¹½‘”¹Ù…±Õ”€ôôô€ÍÑÉ¥¹œœ¤ì(€€€€€€€½¹ÍÐ±½Ý•È€ô¹½‘”¹Ù…±Õ”¹Ñ½1½Ý•É…Í” ¤ì(€€€€€€€¥˜€¡II=I}=}!%9QL¹Í½µ” ¡¡¥¹Ð¤€ôø±½Ý•È¹¥¹±Õ‘•Ì¡¡¥¹Ð¤¤¤ì(€€€€€€€€€¡…ÍÉÉ½É½‘•!¥¹Ð€ôÑÉÕ”ì(€€€€€€€ô(€€€€€ô(€€€ô°(€€€ÑÉÕ”°(€€¤ì((€¥˜€ …¡…ÍI•ÑÉå9…µ•!¥¹Ð€˜˜Í¥‰±¥¹MÑ…Ñ•µ•¹ÑÌ¹±•¹Ñ €ø€À¤ì(€€€™½È€¡½¹ÍÐÍ¥‰±¥¹œ½˜Í¥‰±¥¹MÑ…Ñ•µ•¹ÑÌ¤ì(€€€€€¥˜€¡¹½‘•½¹Ñ…¥¹ÍÉÉ½É½‘•!¥¹Ð¡Í¥‰±¥¹œ¤¤ì(€€€€€€€¡…ÍÉÉ½É½‘•!¥¹Ð€ôÑÉÕ”ì(€€€€€ô((€€€€€Ý…±­9½‘”(€€€€€€€Í¥‰±¥¹œ°(€€€€€€€€¡¹½‘”¤€ôøì(€€€€€€€€€¥˜€¡¹½‘”¹ÑåÁ”€ôôôMQ}9=}QeAL¹%‘•¹Ñ¥™¥•È¤ì(€€€€€€€€€€€¡•­%‘•¹Ñ¥™¥•É9…µ”¡¹½‘”¹¹…µ”¤ì(€€€€€€€€€ô(€€€€€€€ô°(€€€€€€€ÑÉÕ”°(€€€€€€¤ì(€€€ô(€ô((€½¹ÍÐ¡…ÍI•ÑÉå=É…±±‰…­%¹Ñ•¹Ð€ô(€€€¡…ÍI•ÑÉå9…µ•!¥¹Ðñð(€€€¡…Í½Õ¹Ñ•É%¹É•µ•¹Ðñð(€€€¡…Í…É±åá¥Ðñð(€€€¡…Í…Ñ¡½¹Ñ¥¹Õ”ñð(€€€¡…ÍÉÉ½É½‘•!¥¹Ðñð(€€€¡…ÍM•ÅÕ•¹Ñ¥…±•Á•¹‘•¹äñð(€€€¡…Í½¹ÑÉ½±Ý…¥Ðì((€É•ÑÕÉ¸ì(€€€¥Í%¹‘•Á•¹‘•¹Ðè€…¡…ÍI•ÑÉå=É…±±‰…­%¹Ñ•¹Ð°(€ôì)ô()™Õ¹Ñ¥½¸•Ñ1½½Á	½‘åMÑ…Ñ•µ•¹ÑÌ¡±½½Á9½‘”è1½½Á9½‘”¤èQMMQÉ•”¹MÑ…Ñ•µ•¹Ñmtì(€É•ÑÕÉ¸±½½Á9½‘”¹‰½‘ä¹ÑåÁ”€ôôôMQ}9=}QeAL¹	±½­MÑ…Ñ•µ•¹Ð(€€€€ü±½½Á9½‘”¹‰½‘ä¹‰½‘ä(€€€€èm±½½Á9½‘”¹‰½‘åtì)ô()™Õ¹Ñ¥½¸•Ñ½É=™A…É…µ9…µ”¡±½½Á9½‘”èQMMQÉ•”¹½É=™MÑ…Ñ•µ•¹Ð¤èÍÑÉ¥¹œð¹Õ±°ì(€¥˜€¡±½½Á9½‘”¹±•™Ð¹ÑåÁ”€ôôôMQ}9=}QeAL¹%‘•¹Ñ¥™¥•È¤ì(€€€É•ÑÕÉ¸±½½Á9½‘”¹±•™Ð¹¹…µ”ì(€ô((€¥˜€¡±½½Á9½‘”¹±•™Ð¹ÑåÁ”€ôôôMQ}9=}QeAL¹Y…É¥…‰±••±…É…Ñ¥½¸¤ì(€€€¥˜€¡±½½Á9½‘”¹±•™Ð¹‘•±…É…Ñ¥½¹Ì¹±•¹Ñ €„ôô€Ä¤É•ÑÕÉ¸¹Õ±°ì(€€€½¹ÍÐ¥€ô±½½Á9½‘”¹±•™Ð¹‘•±…É…Ñ¥½¹ÍlÁt¹¥ì(€€€¥˜€¡¥¹ÑåÁ”€„ôôMQ}9=}QeAL¹%‘•¹Ñ¥™¥•È¤É•ÑÕÉ¸¹Õ±°ì(€€€É•ÑÕÉ¸¥¹¹…µ”ì(€ô((€É•ÑÕÉ¸¹Õ±°ì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘M…™•ÕÑ½™¥à (€±½½Á9½‘”è1½½Á9½‘”°(€…Ý…¥Ñ9½‘”èQMMQÉ•”¹Ý…¥ÑáÁÉ•ÍÍ¥½¸°(€Í½ÕÉ•½‘”èI•…‘½¹±äñQMM1¥¹Ð¹M½ÕÉ•½‘”ø°(¤èÍÑÉ¥¹œð¹Õ±°ì(€¥˜€ (€€€€…±½½Á9½‘”¹Á…É•¹Ðñð(€€€±½½Á9½‘”¹Á…É•¹Ð¹ÑåÁ”€„ôôMQ}9=}QeAL¹	±½­MÑ…Ñ•µ•¹Ðñð(€€€€…±½½Á9½‘”¹Á…É•¹Ð¹Á…É•¹Ðñð(€€€€…¥ÍÕ¹Ñ¥½¹9½‘”¡±½½Á9½‘”¹Á…É•¹Ð¹Á…É•¹Ð¤(€€¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô((€¥˜€¡±½½Á9½‘”¹ÑåÁ”€„ôôMQ}9=}QeAL¹½É=™MÑ…Ñ•µ•¹Ðñð±½½Á9½‘”¹…Ý…¥Ð¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô((€½¹ÍÐ±½½ÁMÑ…Ñ•µ•¹ÑÌ€ô•Ñ1½½Á	½‘åMÑ…Ñ•µ•¹ÑÌ¡±½½Á9½‘”¤ì(€¥˜€¡±½½ÁMÑ…Ñ•µ•¹ÑÌ¹±•¹Ñ €„ôô€Ä¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô((€½¹ÍÐ½¹±åMÑ…Ñ•µ•¹Ð€ô±½½ÁMÑ…Ñ•µ•¹ÑÍlÁtì(€¥˜€ (€€€½¹±åMÑ…Ñ•µ•¹Ð¹ÑåÁ”€„ôôMQ}9=}QeAL¹áÁÉ•ÍÍ¥½¹MÑ…Ñ•µ•¹Ðñð(€€€½¹±åMÑ…Ñ•µ•¹Ð¹•áÁÉ•ÍÍ¥½¸¹ÑåÁ”€„ôôMQ}9=}QeAL¹Ý…¥ÑáÁÉ•ÍÍ¥½¸ñð(€€€½¹±åMÑ…Ñ•µ•¹Ð¹•áÁÉ•ÍÍ¥½¸€„ôô…Ý…¥Ñ9½‘”ñð(€€€½¹±åMÑ…Ñ•µ•¹Ð¹•áÁÉ•ÍÍ¥½¸¹…ÉÕµ•¹Ð¹ÑåÁ”€„ôôMQ}9=}QeAL¹…±±áÁÉ•ÍÍ¥½¸(€€¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô((€½¹ÍÐÁ…É…µ9…µ”€ô•Ñ½É=™A…É…µ9…µ”¡±½½Á9½‘”¤ì(€¥˜€ …Á…É…µ9…µ”¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô((€½¹ÍÐ¥Ñ•É…‰±•Q•áÐ€ôÍ½ÕÉ•½‘”¹•ÑQ•áÐ¡±½½Á9½‘”¹É¥¡Ð¤ì(€½¹ÍÐ…Ý…¥Ñ•‘…±±Q•áÐ€ôÍ½ÕÉ•½‘”¹•ÑQ•áÐ¡½¹±åMÑ…Ñ•µ•¹Ð¹•áÁÉ•ÍÍ¥½¸¹…ÉÕµ•¹Ð¤ì((€É•ÑÕÉ¸…Ý…¥ÐAÉ½µ¥Í”¹…±° ‘í¥Ñ•É…‰±•Q•áÑô¹µ…À¡…Íå¹Œ€ ‘íÁ…É…µ9…µ•ô¤€ôø…Ý…¥Ð€‘í…Ý…¥Ñ•‘…±±Q•áÑô¤¤í€ì)ô()•áÁ½ÉÐ½¹ÍÐ¹½Ý…¥Ñ%¹1½½À€ôÉ•…Ñ•IÕ±”¡ì(€¹…µ”è€¹¼µ…Ý…¥Ðµ¥¸µ±½½Àœ°(€µ•Ñ„èì(€€€ÑåÁ”è€ÍÕ•ÍÑ¥½¸œ°(€€€‘½Ìèì(€€€€€‘•ÍÉ¥ÁÑ¥½¸è(€€€€€€€€¥Í…±±½Ü¥¹‘•Á•¹‘•¹Ð…Ý…¥Ñ€ÕÍ…”¥¹Í¥‘”±½½ÁÌ°Ý¡¥±”…±±½Ý¥¹œ¥¹Ñ•¹Ñ¥½¹…°É•ÑÉä½™…±±‰…¬½Í•ÅÕ•¹Ñ¥…°Ý½É­™±½ÝÌ¸$Ñ½½±Ì™É•ÅÕ•¹Ñ±ä•¹•É…Ñ”…¥‘•¹Ñ…°Í•ÅÕ•¹Ñ¥…°…Ý…¥ÑÌÝ¡•É”AÉ½µ¥Í”¹…±°Ý½Õ±‰”Í…™•È…¹™…ÍÑ•È¸%¹±Õ‘•Ì„Í…™”…ÕÑ½™¥à™½ÈÍ¥µÁ±”¥¹‘•Á•¹‘•¹Ð±½½ÁÌ¸œ°(€€€ô°(€€€™¥á…‰±”è€½‘”œ°(€€€Í¡•µ„èl(€€€€€ì(€€€€€€€ÑåÁ”è€½‰©•Ðœ°(€€€€€€€ÁÉ½Á•ÉÑ¥•Ìèì(€€€€€€€€€…±±½ÝA…ÑÑ•É¹Ìèì(€€€€€€€€€€€ÑåÁ”è€…ÉÉ…äœ°(€€€€€€€€€€€¥Ñ•µÌèìÑåÁ”è€ÍÑÉ¥¹œœô°(€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€¥±”±½ˆÁ…ÑÑ•É¹ÌÑ¼Í­¥À€¡”¹œ¸°€¨¨¼¨¹Ñ•ÍÐ¹ÑÌ°€¨¨½Í¥µÕ±…Ñ¥½¸¼¨¨¤œ°(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€€€…‘‘¥Ñ¥½¹…±AÉ½Á•ÉÑ¥•Ìè™…±Í”°(€€€€€ô°(€€€t°(€€€µ•ÍÍ…•Ìèì(€€€€€…Ý…¥Ñ%¹1½½Àè(€€€€€€€€M•ÅÕ•¹Ñ¥…°…Ý…¥Ñ€¥¹Í¥‘”„íí±½½ÁQåÁ•õôƒŠBP¥˜Ñ¡•Í”¥Ñ•µÌ…É”¥¹‘•Á•¹‘•¹Ð°½¹Í¥‘•ÈAÉ½µ¥Í”¹…±° ¥€™½ÈÁ…É…±±•°•á•ÕÑ¥½¸¸%˜Í•ÅÕ•¹Ñ¥…°½É‘•Èµ…ÑÑ•ÉÌ°Ñ¡¥Ìµ…ä‰”¥¹Ñ•¹Ñ¥½¹…°¸œ°(€€€ô°(€ô°(€‘•™…Õ±Ñ=ÁÑ¥½¹Ìèmíõt°(€É•…Ñ”¡½¹Ñ•áÐ°m½ÁÑ¥½¹Ít¤ì(€€€¥˜€¡¡…Í¥±•MÕÁÁÉ•ÍÍ¥½¸¡½¹Ñ•áÐ¹Í½ÕÉ•½‘”¤¤ì(€€€€€É•ÑÕÉ¸íôì(€€€ô((€€€€¼¼¥±”µ±•Ù•°ÍÕÁÁÉ•ÍÍ¥½¸èÑ•ÍÐ™¥±•Ì…¹Í¥µÕ±…Ñ¥½¸½‘•µ¼™¥±•ÌÕÍ”Í•ÅÕ•¹Ñ¥…°…Ý…¥Ð¥¹Ñ•¹Ñ¥½¹…±±ä(€€€½¹ÍÐ™¥±•¹…µ”€ô½¹Ñ•áÐ¹™¥±•¹…µ”€üü½¹Ñ•áÐ¹•Ñ¥±•9…µ”ü¸ ¤€üü€œœì(€€€½¹ÍÐ™¥±•	…Í•¹…µ”€ôÁ…Ñ ¹‰…Í•¹…µ”¡™¥±•¹…µ”¤¹Ñ½1½Ý•É…Í” ¤ì(€€€½¹ÍÐ™¥±•A…Ñ €ô™¥±•¹…µ”¹Ñ½1½Ý•É…Í” ¤ì((€€€½¹ÍÐ¥ÍQ•ÍÑ¥±”€ô(€€€€€™¥±•	…Í•¹…µ”¹¥¹±Õ‘•Ì œ¹Ñ•ÍÐ¸œ¤ñð(€€€€€™¥±•	…Í•¹…µ”¹¥¹±Õ‘•Ì œ¹ÍÁ•Œ¸œ¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½}}Ñ•ÍÑÍ}|¼œ¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½Ñ•ÍÐ¼œ¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½Ñ•ÍÑÌ¼œ¤ì((€€€½¹ÍÐ¥ÍM¥µÕ±…Ñ¥½¹¥±”€ô(€€€€€M%5U1Q%=9}95}I`¹Ñ•ÍÐ¡™¥±•	…Í•¹…µ”¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½Í¥µÕ±…Ñ¥½¸¼œ¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½‘•µ¼¼œ¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½…¹¥µ…Ñ¥½¸¼œ¤ñð(€€€€€™¥±•A…Ñ ¹¥¹±Õ‘•Ì œ½™¥áÑÕÉ•Ì¼œ¤ì((€€€€¼¼MÕÁÁÉ•ÍÌ•¹Ñ¥É•±ä™½ÈÑ•ÍÐ…¹Í¥µÕ±…Ñ¥½¸™¥±•Ì(€€€¥˜€¡¥ÍQ•ÍÑ¥±”ñð¥ÍM¥µÕ±…Ñ¥½¹¥±”¤ì(€€€€€É•ÑÕÉ¸íôì(€€€ô((€€€€¼¼¡•¬ÕÍ•ÈµÁÉ½Ù¥‘•…±±½ÝA…ÑÑ•É¹Ì€¡‰…Í¥ŒÍÕ™™¥à½ÍÕ‰ÍÑÉ¥¹œµ…Ñ¡¥¹œ¤(€€€½¹ÍÐì…±±½ÝA…ÑÑ•É¹Ì€ômtô€ô½ÁÑ¥½¹Ì…Ìì…±±½ÝA…ÑÑ•É¹ÌüèÍÑÉ¥¹mtôì(€€€™½È€¡½¹ÍÐÁ…ÑÑ•É¸½˜…±±½ÝA…ÑÑ•É¹Ì¤ì(€€€€€€¼¼M¥µÁ±”Á…ÑÑ•É¸è¥˜™¥±”Á…Ñ ½¹Ñ…¥¹ÌÑ¡”¹½¸µ±½ˆÁ…ÉÐ(€€€€€½¹ÍÐ±•…¹•€ôÁ…ÑÑ•É¸¹É•Á±…” ½p©p¨½œ°€œœ¤¹É•Á±…” ½p¨½œ°€œœ¤¹É•Á±…” ½p¼½œ°Á…Ñ ¹Í•À¤ì(€€€€€¥˜€¡±•…¹•€˜˜™¥±•A…Ñ ¹¥¹±Õ‘•Ì¡±•…¹•¹Ñ½1½Ý•É…Í” ¤¤¤ì(€€€€€€€É•ÑÕÉ¸íôì(€€€€€ô(€€€ô((€€€½¹ÍÐ±½½Á%¹Ñ•¹Ñ…¡”€ô¹•Ü]•…­5…Àñ1½½Á9½‘”°%¹Ñ•¹Ñ¹…±åÍ¥Ìø ¤ì(€€€½¹ÍÐÉ•Á½ÉÑ•‘1½½ÁÌ€ô¹•Ü]•…­M•Ðñ1½½Á9½‘”ø ¤ì((€€€€¼¨¨(€€€€€¨QÉ…¬…¹•ÍÑ½ÈÍ½Á”‰½Õ¹‘…É¥•Ì€¡™Õ¹Ñ¥½¹Ì¤Í¼Ý”‘½¸Ð™±…œ…Ý…¥Ð(€€€€€¨•áÁÉ•ÍÍ¥½¹Ì¥¹Í¥‘”„¹•ÍÑ•…Íå¹Œ™Õ¹Ñ¥½¸Ñ¡…Ð¡…ÁÁ•¹ÌÑ¼‰”¥¹Í¥‘”„±½½À¸(€€€€€¨¼(€€€½¹ÍÐ™Õ¹Ñ¥½¹	½Õ¹‘…ÉäèQMMQÉ•”¹9½‘•mt€ômtì((€€€™Õ¹Ñ¥½¸•¹Ñ•ÉÕ¹Ñ¥½¸¡¹½‘”èQMMQÉ•”¹9½‘”¤ì(€€€€€™Õ¹Ñ¥½¹	½Õ¹‘…Éä¹ÁÕÍ ¡¹½‘”¤ì(€€€ô(€€€™Õ¹Ñ¥½¸•á¥ÑÕ¹Ñ¥½¸ ¤ì(€€€€€™Õ¹Ñ¥½¹	½Õ¹‘…Éä¹Á½À ¤ì(€€€ô((€€€É•ÑÕÉ¸ì(€€€€€Õ¹Ñ¥½¹•±…É…Ñ¥½¸è•¹Ñ•ÉÕ¹Ñ¥½¸°(€€€€€Õ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸è•¹Ñ•ÉÕ¹Ñ¥½¸°(€€€€€ÉÉ½ÝÕ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸è•¹Ñ•ÉÕ¹Ñ¥½¸°(€€€€€€Õ¹Ñ¥½¹•±…É…Ñ¥½¸é•á¥Ðœè•á¥ÑÕ¹Ñ¥½¸°(€€€€€€Õ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸é•á¥Ðœè•á¥ÑÕ¹Ñ¥½¸°(€€€€€€ÉÉ½ÝÕ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸é•á¥Ðœè•á¥ÑÕ¹Ñ¥½¸°((€€€€€Ý…¥ÑáÁÉ•ÍÍ¥½¸¡¹½‘”¤ì(€€€€€€€€¼¼]…±¬ÕÀ…¹•ÍÑ½ÉÌ±½½­¥¹œ™½È„±½½À°‰ÕÐÍÑ½À…Ð…¹ä™Õ¹Ñ¥½¸‰½Õ¹‘…Éä(€€€€€€€½¹ÍÐ…¹•ÍÑ½ÉÌ€ô½¹Ñ•áÐ¹Í½ÕÉ•½‘”¹•Ñ¹•ÍÑ½ÉÌ¡¹½‘”¤ì(€€€€€€€½¹ÍÐÕÉÉ•¹ÑÕ¹Ñ¥½¸€ô™Õ¹Ñ¥½¹	½Õ¹‘…Éåm™Õ¹Ñ¥½¹	½Õ¹‘…Éä¹±•¹Ñ €´€Åtì((€€€€€€€±•Ð•¹±½Í¥¹1½½Àè1½½Á9½‘”ð¹Õ±°€ô¹Õ±°ì(€€€€€€€™½È€¡±•Ð¤€ô…¹•ÍÑ½ÉÌ¹±•¹Ñ €´€Äì¤€øô€Àì¤´´¤ì(€€€€€€€€€½¹ÍÐ…¹•ÍÑ½È€ô…¹•ÍÑ½ÉÍm¥tì((€€€€€€€€€€¼¼MÑ½À¥˜Ý”¡¥ÐÑ¡”ÕÉÉ•¹Ð™Õ¹Ñ¥½¸‰½Õ¹‘…Éä(€€€€€€€€€¥˜€¡…¹•ÍÑ½È€ôôôÕÉÉ•¹ÑÕ¹Ñ¥½¸¤ì(€€€€€€€€€€€‰É•…¬ì(€€€€€€€€€ô((€€€€€€€€€¥˜€¡1==A}QeAL¹¡…Ì¡…¹•ÍÑ½È¹ÑåÁ”…ÌMQ}9=}QeAL¤¤ì(€€€€€€€€€€€•¹±½Í¥¹1½½À€ô…¹•ÍÑ½È…Ì1½½Á9½‘”ì(€€€€€€€€€€€‰É•…¬ì(€€€€€€€€€ô(€€€€€€€ô((€€€€€€€¥˜€ …•¹±½Í¥¹1½½À¤ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€ô((€€€€€€€¥˜€¡É•Á½ÉÑ•‘1½½ÁÌ¹¡…Ì¡•¹±½Í¥¹1½½À¤¤ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€ô((€€€€€€€¥˜€¡¡…Í1½½ÁMÕÁÁÉ•ÍÍ¥½¸¡•¹±½Í¥¹1½½À°½¹Ñ•áÐ¹Í½ÕÉ•½‘”¤¤ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€ô((€€€€€€€½¹ÍÐ¥¹Ñ•¹Ð€ô±½½Á%¹Ñ•¹Ñ…¡”¹•Ð¡•¹±½Í¥¹1½½À¤€üü…¹…±åé•%¹Ñ•¹Ð¡•¹±½Í¥¹1½½À¤ì(€€€€€€€±½½Á%¹Ñ•¹Ñ…¡”¹Í•Ð¡•¹±½Í¥¹1½½À°¥¹Ñ•¹Ð¤ì((€€€€€€€€¼¼%¹Ñ•¹Ðµ…Ý…É”‰•¡…Ù¥½Èè(€€€€€€€€¼¼É•ÑÉä½™…±±‰…¬½Í•ÅÕ•¹Ñ¥…°±½½ÁÌ…É”ÍÕÁÁÉ•ÍÍ•€¡¹¼É•Á½ÉÐ¤¸(€€€€€€€¥˜€ …¥¹Ñ•¹Ð¹¥Í%¹‘•Á•¹‘•¹Ð¤ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€ô((€€€€€€€½¹ÍÐ™¥áQ•áÐ€ô‰Õ¥±‘M…™•ÕÑ½™¥à¡•¹±½Í¥¹1½½À°¹½‘”°½¹Ñ•áÐ¹Í½ÕÉ•½‘”¤ì(€€€€€€€½¹ÍÐ±½½Á9…µ”€ô•Ñ1½½Á9½‘•9…µ”¡•¹±½Í¥¹1½½À¹ÑåÁ”…ÌMQ}9=}QeAL¤ì((€€€€€€€½¹Ñ•áÐ¹É•Á½ÉÐ¡ì(€€€€€€€€€¹½‘”°(€€€€€€€€€µ•ÍÍ…•%è€…Ý…¥Ñ%¹1½½Àœ°(€€€€€€€€€‘…Ñ„èì±½½ÁQåÁ”è±½½Á9…µ”ô°(€€€€€€€€€™¥àè(€€€€€€€€€€€™¥áQ•áÐ€ôôô¹Õ±°(€€€€€€€€€€€€€€üÕ¹‘•™¥¹•(€€€€€€€€€€€€€€è€¡™¥á•È¤€ôø™¥á•È¹É•Á±…•Q•áÐ¡•¹±½Í¥¹1½½À…ÌÕ¹­¹½Ý¸…ÌQMMQÉ•”¹9½‘”°™¥áQ•áÐ¤°(€€€€€€€ô¤ì((€€€€€€€É•Á½ÉÑ•‘1½½ÁÌ¹…‘¡•¹±½Í¥¹1½½À¤ì(€€€€€ô°(€€€ôì(€ô°)ô¤ì()•áÁ½ÉÐ‘•™…Õ±Ð¹½Ý…¥Ñ%¹1½½Àì