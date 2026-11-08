import { ESLintUtils, AST_NODE_TYPES, ASTUtils } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import { getEnvAccess } from '../../utils/env-access';
import { isNonProductionFile } from '../../utils/file-context';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/** Env vars compared against 'test': NODE_ENV === 'test'. */
const MODE_ENV_NAMES = new Set(['NODE_ENV', 'APP_ENV', 'ENV', 'ENVIRONMENT', 'BABEL_ENV', 'MODE']);
/** Env vars that are only set by test runners. */
const TEST_FLAG_ENV_NAMES = new Set([
  'VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'JEST_WORKER_ID', 'MOCHA_WORKER_ID', 'NODE_TEST_CONTEXT',
  'TEST', 'IS_TEST', 'TESTING',
]);
/** Globals that exist only inside a test runner: typeof jest !== 'undefined'. */
const TEST_GLOBALS = new Set(['jest', 'vi', 'describe', 'it', 'expect', 'beforeEach']);

/** Test setup, helpers and tooling config legitimately branch on the test environment. */
const TEST_SUPPORT_FILE =
  /(?:^|[\\/])(?:setup-?tests?|test-?setup|vitest\.setup|jest\.setup|jest\.config|vitest\.config|test-?utils?|test-?helpers?)\.[cm]?[jt]sx?$|[\\/](?:testing|test-?utils|test-?helpers|__testutils__)[\\/]|(?:^|[\\/])[^\\/]*\.config\.[cm]?[jt]s$|(?:^|[\\/])\.?(?:babel|eslint|prettier)rc\.[cm]?js$/i;

type Polarity = 'test' | 'not-test' | 'in-source' | null;

function isTestString(node: TSESTree.Node): boolean {
  return node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string' && /^test(?:ing)?$/i.test(node.value);
}

function isImportMetaVitest(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    node.object.type === AST_NODE_TYPES.MetaProperty &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === 'vitest'
  );
}

function flip(p: Polarity): Polarity {
  if (p === 'test') return 'not-test';
  if (p === 'not-test') return 'test';
  return p;
}

type FunctionNode = TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression;

/** Whether the code inside `if (expr)` runs only (or always) under a test runner. */
function polarityOf(expr: TSESTree.Node, sourceCode: Readonly<TSESLint.SourceCode>, depth = 0): Polarity {
  if (depth > 3) return null;
  if (isImportMetaVitest(expr)) return 'in-source';

  const access = getEnvAccess(expr);
  if (access && TEST_FLAG_ENV_NAMES.has(access.name)) return 'test';

  switch (expr.type) {
    case AST_NODE_TYPES.UnaryExpression:
      return expr.operator === '!' ? flip(polarityOf(expr.argument, sourceCode, depth + 1)) : null;
    case AST_NODE_TYPES.BinaryExpression: {
      if (!['===', '==', '!==', '!='].includes(expr.operator)) return null;
      const equal = expr.operator === '===' || expr.operator === '==';
      const sides: Array<[TSESTree.Node, TSESTree.Node]> = [[expr.left, expr.right], [expr.right, expr.left]];
      for (const [a, b] of sides) {
        const env = getEnvAccess(a);
        if (env && MODE_ENV_NAMES.has(env.name) && isTestString(b)) return equal ? 'test' : 'not-test';
        // typeof jest !== 'undefined'
        if (
          a.type === AST_NODE_TYPES.UnaryExpression && a.operator === 'typeof' &&
          a.argument.type === AST_NODE_TYPES.Identifier && TEST_GLOBALS.has(a.argument.name) &&
          b.type === AST_NODE_TYPES.Literal && typeof b.value === 'string'
        ) {
          const defined = b.value !== 'undefined';
          return equal === defined ? 'test' : 'not-test';
        }
      }
      return null;
    }
    case AST_NODE_TYPES.LogicalExpression: {
      const left = polarityOf(expr.left, sourceCode, depth + 1);
      const right = polarityOf(expr.right, sourceCode, depth + 1);
      if (left === 'in-source' || right === 'in-source') return 'in-source';
      if (expr.operator === '&&') return left === 'test' || right === 'test' ? 'test' : null;
      return left ?? right;
    }
    case AST_NODE_TYPES.Identifier: {
      // const isTest = process.env.NODE_ENV === 'test'
      const variable = ASTUtils.findVariable(sourceCode.getScope(expr), expr);
      const def = variable?.defs[0];
      if (def?.type !== 'Variable' || variable!.references.some((r) => r.isWrite() && !r.init)) return null;
      const init = (def.node as TSESTree.VariableDeclarator).init;
      return init ? polarityOf(init, sourceCode, depth + 1) : null;
    }
    case AST_NODE_TYPES.CallExpression: {
      // const isTestEnv = () => process.env.NODE_ENV === 'test'
      if (expr.callee.type !== AST_NODE_TYPES.Identifier || expr.arguments.length > 0) return null;
      const variable = ASTUtils.findVariable(sourceCode.getScope(expr), expr.callee);
      const def = variable?.defs[0];
      let fn: FunctionNode | null = null;
      if (def?.type === 'FunctionName' && def.node.type === AST_NODE_TYPES.FunctionDeclaration) fn = def.node;
      if (def?.type === 'Variable') {
        const init = (def.node as TSESTree.VariableDeclarator).init;
        if (init?.type === AST_NODE_TYPES.ArrowFunctionExpression || init?.type === AST_NODE_TYPES.FunctionExpression) fn = init;
      }
      if (!fn) return null;
      if (fn.body.type !== AST_NODE_TYPES.BlockStatement) return polarityOf(fn.body, sourceCode, depth + 1);
      const only = fn.body.body.length === 1 ? fn.body.body[0] : null;
      return only?.type === AST_NODE_TYPES.ReturnStatement && only.argument ? polarityOf(only.argument, sourceCode, depth + 1) : null;
    }
    default:
      return null;
  }
}

/** A hard-coded result: a literal, a literal object/array, a mock-named value, Promise.resolve(literal). */
function isCanned(node: TSESTree.Node | null | undefined, sc: Readonly<TSESLint.SourceCode>, depth = 0): boolean {
  if (!node || depth > 6) return false;
  switch (node.type) {
    case AST_NODE_TYPES.Literal:
      return !('regex' in node && node.regex);
    case AST_NODE_TYPES.TemplateLiteral:
      return node.expressions.length === 0;
    case AST_NODE_TYPES.Identifier:
      if (node.name === 'undefined') return true;
      // const MOCK_USER = { id: 1 } — a constant bound to a literal value
      {
        const variable = ASTUtils.findVariable(sc.getScope(node), node);
        const def = variable?.defs[0];
        if (def?.type !== 'Variable') return false;
        const declarator = def.node as TSESTree.VariableDeclarator;
        const declaration = declarator.parent as TSESTree.VariableDeclaration;
        return declaration.kind === 'const' && declarator.id.type === AST_NODE_TYPES.Identifier && isCanned(declarator.init, sc, depth + 1);
      }
    case AST_NODE_TYPES.UnaryExpression:
      return isCanned(node.argument, sc, depth + 1);
    case AST_NODE_TYPES.ArrayExpression:
      return node.elements.every((e) => e !== null && e.type !== AST_NODE_TYPES.SpreadElement && isCanned(e, sc, depth + 1));
    case AST_NODE_TYPES.ObjectExpression:
      return node.properties.every((p) => p.type === AST_NODE_TYPES.Property && !p.computed && isCanned(p.value, sc, depth + 1));
    case AST_NODE_TYPES.CallExpression:
      return (
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.object.type === AST_NODE_TYPES.Identifier &&
        node.callee.object.name === 'Promise' &&
        node.callee.property.type === AST_NODE_TYPES.Identifier &&
        node.callee.property.name === 'resolve' &&
        (node.arguments.length === 0 || isCanned(node.arguments[0], sc, depth + 1))
      );
    case AST_NODE_TYPES.AwaitExpression:
      return isCanned(node.argument, sc, depth + 1);
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
      return isCanned(node.expression, sc, depth + 1);
    default:
      return false;
  }
}

function isNullish(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Literal) return node.value === null;
  if (node.type === AST_NODE_TYPES.Identifier) return node.name === 'undefined';
  if (node.type === AST_NODE_TYPES.UnaryExpression) return node.operator === 'void';
  return false;
}

/** A fabricated result: canned, and not just null/undefined ("do nothing in tests"). */
function isFabricated(node: TSESTree.Node, sc: Readonly<TSESLint.SourceCode>): boolean {
  return isCanned(node, sc) && !isNullish(node);
}

/** Return statements in a branch, not counting nested functions. */
function cannedReturns(node: TSESTree.Node | null | undefined, sc: Readonly<TSESLint.SourceCode>, out: TSESTree.ReturnStatement[] = []): TSESTree.ReturnStatement[] {
  if (!node) return out;
  switch (node.type) {
    case AST_NODE_TYPES.ReturnStatement:
      if (node.argument && isFabricated(node.argument, sc)) out.push(node);
      return out;
    case AST_NODE_TYPES.BlockStatement:
      for (const statement of node.body) cannedReturns(statement, sc, out);
      return out;
    case AST_NODE_TYPES.IfStatement:
      cannedReturns(node.consequent, sc, out);
      cannedReturns(node.alternate, sc, out);
      return out;
    case AST_NODE_TYPES.TryStatement:
      cannedReturns(node.block, sc, out);
      return out;
    default:
      return out;
  }
}

function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  let current: TSESTree.Node | undefined = node.parent;
  while (current) {
    if (
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression ||
      current.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** Every return statement of a function, not counting nested functions. */
function allReturns(node: TSESTree.Node, out: TSESTree.ReturnStatement[] = []): TSESTree.ReturnStatement[] {
  if (node.type === AST_NODE_TYPES.ReturnStatement) {
    out.push(node);
    return out;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!child || typeof child !== 'object' || !('type' in child)) continue;
      const c = child as TSESTree.Node;
      if (c.type === AST_NODE_TYPES.FunctionDeclaration || c.type === AST_NODE_TYPES.FunctionExpression || c.type === AST_NODE_TYPES.ArrowFunctionExpression) continue;
      allReturns(c, out);
    }
  }
  return out;
}

/**
 * `function logLevel() { if (isTest) return 'silent'; return 'info'; }` picks between
 * constants: configuration, not a shortcut. True when the function has other returns
 * and all of them are constants too.
 */
function isConstantSelector(fn: FunctionNode, testReturns: Set<TSESTree.ReturnStatement>, sc: Readonly<TSESLint.SourceCode>): boolean {
  if (fn.body.type !== AST_NODE_TYPES.BlockStatement) return false;
  const others = allReturns(fn.body).filter((r) => !testReturns.has(r));
  return others.length > 0 && others.every((r) => r.argument !== null && isCanned(r.argument, sc));
}

function enclosingFunctionName(node: TSESTree.Node): string | null {
  let current: TSESTree.Node | undefined = node.parent;
  while (current) {
    if (current.type === AST_NODE_TYPES.FunctionDeclaration && current.id) return current.id.name;
    if (current.type === AST_NODE_TYPES.FunctionExpression || current.type === AST_NODE_TYPES.ArrowFunctionExpression) {
      const parent = current.parent;
      if (parent?.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) return parent.id.name;
      if ((parent?.type === AST_NODE_TYPES.MethodDefinition || parent?.type === AST_NODE_TYPES.Property) && parent.key.type === AST_NODE_TYPES.Identifier) {
        return parent.key.name;
      }
      if (current.type === AST_NODE_TYPES.FunctionExpression && current.id) return current.id.name;
      return null;
    }
    current = current.parent;
  }
  return null;
}

export const noTestEnvBranch = createRule<[], 'cannedTestResult'>({
  name: 'no-test-env-branch',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow production code that returns a hard-coded result when it detects a test runner (`if (process.env.NODE_ENV === "test") return { ok: true }`). Tests then pass without running the real code. AI agents add these shortcuts to make failing tests pass. Test-environment checks that skip side effects (`if (NODE_ENV !== "test") app.listen()`) are allowed.',
    },
    schema: [],
    messages: {
      cannedTestResult:
        '{{name}} returns a hard-coded result when running under tests (`{{condition}}`), so tests pass without exercising the real code. AI agents add shortcuts like this to make failing tests pass. Remove the branch and make the real path testable: inject the dependency, or mock it in the test.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.physicalFilename || context.filename;
    if (isNonProductionFile(filename) || TEST_SUPPORT_FILE.test(filename)) return {};
    const sourceCode = context.sourceCode;

    function report(node: TSESTree.Node, condition: TSESTree.Node): void {
      // Module-level test switches are configuration, not shortcuts.
      if (!enclosingFunction(node)) return;
      const name = enclosingFunctionName(node);
      const text = sourceCode.getText(condition).replace(/\s+/g, ' ');
      context.report({
        node,
        messageId: 'cannedTestResult',
        data: {
          name: name ? `\`${name}\`` : 'This function',
          condition: text.length > 60 ? `${text.slice(0, 57)}...` : text,
        },
      });
    }

    return {
      IfStatement(node): void {
        const polarity = polarityOf(node.test, sourceCode);
        if (polarity !== 'test' && polarity !== 'not-test') return;
        const testBranch = polarity === 'test' ? node.consequent : node.alternate;
        const returns = cannedReturns(testBranch, sourceCode);
        if (returns.length === 0) return;
        const fn = enclosingFunction(node);
        if (fn && isConstantSelector(fn, new Set(returns), sourceCode)) return;
        for (const ret of returns) report(ret, node.test);
      },
      // return process.env.NODE_ENV === 'test' ? { ok: true } : realCall()
      ConditionalExpression(node): void {
        const parent = node.parent;
        const isReturned =
          parent?.type === AST_NODE_TYPES.ReturnStatement ||
          (parent?.type === AST_NODE_TYPES.ArrowFunctionExpression && parent.body === node);
        if (!isReturned) return;
        const polarity = polarityOf(node.test, sourceCode);
        if (polarity !== 'test' && polarity !== 'not-test') return;
        const testValue = polarity === 'test' ? node.consequent : node.alternate;
        const realValue = polarity === 'test' ? node.alternate : node.consequent;
        // Choosing between two constants (log levels, labels) is configuration, not a shortcut.
        if (isFabricated(testValue, sourceCode) && !isCanned(realValue, sourceCode)) report(testValue, node.test);
      },
    };
  },
});

export default noTestEnvBranch;
