import { ESLintUtils, AST_NODE_TYPES, AST_TOKEN_TYPES } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import { isNonProductionFile, isTestFile } from '../../utils/file-context';
import { someDescendant } from '../../utils/ast-helpers';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// ─── Elision comments ────────────────────────────────────────────────────────
// Left when a model rewrites a file and replaces code it did not reproduce
// with a marker. Shipping one usually means real code was deleted.

const CODE_NOUN =
  '(?:code|file|implementation|function|functions|component|components|class|logic|methods?|handlers?|routes?|tests?|cases|module|config|configuration|properties|fields|imports|exports|jsx|markup|styles?|content|body|types|interfaces|hooks|state|props|endpoints|queries|reducers|actions|selectors|middleware|helpers|utils|setup)';

const ELLIPSIS = '(?:\\.{3}|\\u2026)';

/** "rest of the code", "existing methods", "other tests". */
const SUBJECT =
  `(?:(?:all\\s+)?(?:the\\s+)?(?:rest|remainder)\\s+of\\s+(?:the\\s+|this\\s+|your\\s+)?${CODE_NOUN}` +
  `|(?:keep(?:ing)?\\s+)?(?:all\\s+)?(?:the\\s+|your\\s+)?(?:existing|previous|original|other|remaining|same|old|more)\\s+${CODE_NOUN})`;

/** "remains the same", "unchanged", "here", "omitted for brevity". */
const TAIL =
  '(?:\\s+(?:(?:remains?|stays?|is|are|left)\\s+)?(?:the same|unchanged|as is|as before|here|goes here|go here|omitted|elided|truncated|not shown|for brevity|omitted for brevity))';

const END = `\\s*(?:${ELLIPSIS})?\\s*[)\\].]?\\s*$`;

/** Forms that are elisions wherever they appear. */
const STRONG_ELISION: RegExp[] = [
  // "... existing code", "... rest of the code remains the same", "…(unchanged)"
  new RegExp(`^${ELLIPSIS}\\s*[(\\[]?\\s*${SUBJECT}${TAIL}?${END}`),
  new RegExp(`^${ELLIPSIS}\\s*[(\\[]?\\s*(?:unchanged|omitted|truncated|snip|same as (?:before|above))${END}`),
  // "existing code here", "other methods unchanged", "rest of the file stays the same"
  new RegExp(`^${SUBJECT}${TAIL}${END}`),
  // "your code here", "add your logic here", "implementation goes here"
  /^(?:\/\/\s*)?(?:todo:?\s*)?(?:your|add(?:\s+your)?|insert(?:\s+your)?|put(?:\s+your)?|implement(?:\s+your)?|write(?:\s+your)?)\s+(?:own\s+)?(?:code|logic|implementation|business logic)\s+(?:goes\s+)?here\b/,
  /^(?:the\s+)?(?:code|logic|implementation)\s+(?:goes|would go|omitted|truncated)\s+(?:here|for brevity)\b/,
];

/**
 * Forms that are also normal section labels ("// Rest of the implementation",
 * "// same as before"). They count only when no code follows before the block closes.
 */
const WEAK_ELISION: RegExp[] = [
  new RegExp(`^${SUBJECT}${END}`),
  new RegExp(`^[(\\[]?\\s*(?:unchanged|same as (?:before|above)|as before)${END}`),
];

/** Elision markers are short notes, not prose; long comments are documentation. */
const MAX_ELISION_COMMENT_LENGTH = 100;

function normalizeComment(comment: TSESTree.Comment): string {
  return comment.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join(' ')
    .trim()
    .toLowerCase();
}

function isElisionText(comment: TSESTree.Comment): 'strong' | 'weak' | null {
  // JSDoc blocks hold examples where elision is a normal writing device.
  if (comment.type === AST_TOKEN_TYPES.Block && comment.value.startsWith('*')) return null;
  const text = normalizeComment(comment);
  if (text.length === 0 || text.length > MAX_ELISION_COMMENT_LENGTH) return null;
  if (/^(?:eslint|ai-guard|@ts-|prettier|istanbul|c8|webpack|vite)/.test(text)) return null;
  if (STRONG_ELISION.some((pattern) => pattern.test(text))) return 'strong';
  if (WEAK_ELISION.some((pattern) => pattern.test(text))) return 'weak';
  return null;
}

const CLOSING_TOKENS = new Set(['}', ']', ')']);

const TYPE_ONLY_CONTAINERS = new Set<string>([
  AST_NODE_TYPES.TSInterfaceBody,
  AST_NODE_TYPES.TSTypeLiteral,
  AST_NODE_TYPES.TSModuleBlock,
]);

/**
 * `interface Session { // ...other properties }` is a hint for whoever extends
 * the type; nothing at runtime was deleted, and tsc reports missing members.
 */
function isInTypeOnlyContext(comment: TSESTree.Comment, sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  let node = sourceCode.getNodeByRangeIndex(comment.range[0]) as TSESTree.Node | null;
  while (node) {
    if (TYPE_ONLY_CONTAINERS.has(node.type)) return true;
    node = node.parent ?? null;
  }
  return false;
}

function isElisionComment(comment: TSESTree.Comment, sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  const strength = isElisionText(comment);
  if (strength === 'strong') return true;
  if (strength !== 'weak') return false;
  // A weak marker is an elision only when nothing follows it in the block.
  const next = sourceCode.getTokenAfter(comment, { includeComments: false });
  return next === null || CLOSING_TOKENS.has(next.value);
}

// ─── Stub bodies ─────────────────────────────────────────────────────────────

/**
 * Markers of unfinished work. Bare "implementation" is deliberately absent:
 * "// default implementation: no-op" documents an intentional empty body.
 */
const STUB_COMMENT_PATTERN =
  /\b(?:todo|fixme|xxx|tbd|stub|stubbed|placeholder|not (?:yet )?implemented|to be implemented|implement (?:this|me|later|here|logic)|needs? (?:an )?implementation|add (?:the )?(?:implementation|logic)|fill (?:this )?in)\b/i;

const NOT_IMPLEMENTED_MESSAGE =
  /^(?:(?:method|function|feature|endpoint|handler|this)\s+)?(?:is\s+)?(?:not\s+(?:yet\s+)?implemented|unimplemented|todo|implement me|not supported yet)\b/i;

/** Wording that marks an intentional "subclasses must override" contract. */
const OVERRIDE_CONTRACT = /\b(?:subclass|sub-class|override|overridden|derived|abstract|must be implemented|should be implemented|implemented by|child class)\b/i;

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isTrivialValue(node: TSESTree.Expression | null): boolean {
  if (!node) return true;
  switch (node.type) {
    case AST_NODE_TYPES.Literal:
      return node.value === null || node.value === '' || node.value === 0 || typeof node.value === 'boolean';
    case AST_NODE_TYPES.Identifier:
      return node.name === 'undefined';
    case AST_NODE_TYPES.ArrayExpression:
      return node.elements.length === 0;
    case AST_NODE_TYPES.ObjectExpression:
      return node.properties.length === 0;
    case AST_NODE_TYPES.CallExpression:
      // Promise.resolve() / Promise.resolve(null)
      return (
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.object.type === AST_NODE_TYPES.Identifier &&
        node.callee.object.name === 'Promise' &&
        node.callee.property.type === AST_NODE_TYPES.Identifier &&
        node.callee.property.name === 'resolve' &&
        node.arguments.length <= 1 &&
        (node.arguments.length === 0 || isTrivialValue(node.arguments[0] as TSESTree.Expression))
      );
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
      return isTrivialValue(node.expression);
    default:
      return false;
  }
}

function isConsoleCall(statement: TSESTree.Statement): boolean {
  return (
    statement.type === AST_NODE_TYPES.ExpressionStatement &&
    statement.expression.type === AST_NODE_TYPES.CallExpression &&
    statement.expression.callee.type === AST_NODE_TYPES.MemberExpression &&
    statement.expression.callee.object.type === AST_NODE_TYPES.Identifier &&
    statement.expression.callee.object.name === 'console'
  );
}

/** Describes a body that does nothing real, or returns null when it does something. */
function describeTrivialBody(body: TSESTree.BlockStatement): string | null {
  const statements = body.body;
  if (statements.length === 0) return 'is empty';
  if (statements.length > 2) return null;

  const nonLogging = statements.filter((s) => !isConsoleCall(s));
  if (nonLogging.length === 0) return 'only logs';
  if (nonLogging.length > 1) return null;

  const only = nonLogging[0];
  if (only.type === AST_NODE_TYPES.ReturnStatement && isTrivialValue(only.argument)) {
    return only.argument ? `only returns \`${describeValue(only.argument)}\`` : 'only returns';
  }
  return null;
}

function describeValue(node: TSESTree.Expression): string {
  if (node.type === AST_NODE_TYPES.Literal) return node.raw;
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (node.type === AST_NODE_TYPES.ArrayExpression) return '[]';
  if (node.type === AST_NODE_TYPES.ObjectExpression) return '{}';
  if (node.type === AST_NODE_TYPES.TSAsExpression || node.type === AST_NODE_TYPES.TSNonNullExpression) {
    return describeValue(node.expression);
  }
  return 'Promise.resolve()';
}

function getFunctionName(fn: FunctionNode): string {
  if (fn.type !== AST_NODE_TYPES.ArrowFunctionExpression && fn.id) return fn.id.name;
  const parent = fn.parent;
  if (parent?.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) {
    return parent.id.name;
  }
  if (
    (parent?.type === AST_NODE_TYPES.MethodDefinition || parent?.type === AST_NODE_TYPES.Property || parent?.type === AST_NODE_TYPES.PropertyDefinition) &&
    parent.key.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.key.name;
  }
  return 'anonymous function';
}

function getEnclosingClass(fn: FunctionNode): TSESTree.ClassDeclaration | TSESTree.ClassExpression | null {
  const parent = fn.parent;
  if (parent?.type !== AST_NODE_TYPES.MethodDefinition && parent?.type !== AST_NODE_TYPES.PropertyDefinition) {
    return null;
  }
  const classBody = parent.parent;
  const cls = classBody?.parent;
  if (cls?.type === AST_NODE_TYPES.ClassDeclaration || cls?.type === AST_NODE_TYPES.ClassExpression) return cls;
  return null;
}

/** Base classes legitimately throw "not implemented" to force an override. */
function isOverridableBaseMethod(fn: FunctionNode, sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  const cls = getEnclosingClass(fn);
  if (!cls) return false;
  if ('abstract' in cls && cls.abstract) return true;
  const name = cls.id?.name ?? '';
  if (/^(?:Abstract|Base)[A-Z_]|Base$/.test(name)) return true;

  // Plain JS has no `abstract`: base classes document it with JSDoc instead.
  const member = fn.parent as TSESTree.Node;
  const docs = [...sourceCode.getCommentsBefore(member), ...sourceCode.getCommentsBefore(cls)];
  if (docs.some((c) => /@(?:abstract|virtual)\b/.test(c.value))) return true;

  // A class extended in the same file is a base class.
  return name !== '' && someDescendant(sourceCode.ast, (n) =>
    (n.type === AST_NODE_TYPES.ClassDeclaration || n.type === AST_NODE_TYPES.ClassExpression) &&
    n.superClass?.type === AST_NODE_TYPES.Identifier &&
    n.superClass.name === name
  );
}

function getThrownMessage(statement: TSESTree.Statement): { message: string | null; errorName: string } | null {
  if (statement.type !== AST_NODE_TYPES.ThrowStatement) return null;
  const arg = statement.argument;
  if (
    (arg.type !== AST_NODE_TYPES.NewExpression && arg.type !== AST_NODE_TYPES.CallExpression) ||
    arg.callee.type !== AST_NODE_TYPES.Identifier
  ) {
    return null;
  }
  const first = arg.arguments[0];
  let message: string | null = null;
  if (first?.type === AST_NODE_TYPES.Literal && typeof first.value === 'string') message = first.value;
  else if (first?.type === AST_NODE_TYPES.TemplateLiteral) message = first.quasis.map((q) => q.value.cooked ?? '').join('${...}');
  return { message, errorName: arg.callee.name };
}

// ─── Mock data in production code ───────────────────────────────────────────

const MOCK_NAME = /^(?:mock|mocked|dummy|fake|stub|stubbed|hardcoded)(?:[A-Z0-9_]|$)|^(?:MOCK|DUMMY|FAKE|STUB|HARDCODED)_/;

const RESPONSE_METHODS = new Set(['json', 'send', 'jsonp']);

/** True when a reference to the mock variable is what the code hands back. */
function isServedReference(identifier: TSESTree.Node): boolean {
  let node: TSESTree.Node = identifier;
  // Allow simple wrappers: mockUsers.filter(...), [...mockUsers], { data: mockUsers }
  for (let depth = 0; depth < 4 && node.parent; depth++) {
    const parent: TSESTree.Node = node.parent;
    if (parent.type === AST_NODE_TYPES.ReturnStatement) return true;
    if (parent.type === AST_NODE_TYPES.ArrowFunctionExpression && parent.body === node) return true;
    if (parent.type === AST_NODE_TYPES.CallExpression && parent.arguments.includes(node as TSESTree.CallExpressionArgument)) {
      const callee = parent.callee;
      if (callee.type === AST_NODE_TYPES.MemberExpression && callee.property.type === AST_NODE_TYPES.Identifier) {
        if (RESPONSE_METHODS.has(callee.property.name)) return true;
        if (callee.property.name === 'resolve' && callee.object.type === AST_NODE_TYPES.Identifier && callee.object.name === 'Promise') {
          node = parent;
          continue;
        }
      }
      if (callee.type === AST_NODE_TYPES.Identifier && (callee.name === 'useState' || callee.name === 'json')) return true;
      return false;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression ||
      parent.type === AST_NODE_TYPES.SpreadElement ||
      parent.type === AST_NODE_TYPES.ArrayExpression ||
      parent.type === AST_NODE_TYPES.Property ||
      parent.type === AST_NODE_TYPES.ObjectExpression ||
      parent.type === AST_NODE_TYPES.AwaitExpression ||
      parent.type === AST_NODE_TYPES.TSAsExpression
    ) {
      node = parent;
      continue;
    }
    if (parent.type === AST_NODE_TYPES.CallExpression && parent.callee === node) {
      // mockUsers.filter(...) — keep walking from the call result
      node = parent;
      continue;
    }
    return false;
  }
  return false;
}

type MessageIds = 'elidedCode' | 'stubBody' | 'notImplemented' | 'mockData';

export const noPlaceholderImplementation = createRule<[], MessageIds>({
  name: 'no-placeholder-implementation',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow placeholder code left by AI agents: elision comments that replace deleted code ("// ... rest of the code"), stub functions that only hold a TODO, functions whose whole body throws "Not implemented", and hardcoded mock data served from production code. Agents leave these behind and report the task as finished.',
    },
    schema: [],
    messages: {
      elidedCode:
        'Elision comment "{{comment}}" stands in for code that is not there. AI tools write this when they rewrite a file without reproducing all of it, which silently deletes the original code. Restore the missing code from version control or write it out in full.',
      stubBody:
        '`{{name}}` is a placeholder: its body {{what}} next to a "{{comment}}" comment. AI agents leave stubs like this and report the task as done. Implement it, or throw an explicit error if it must not be called yet.',
      notImplemented:
        '`{{name}}` only throws `{{thrown}}`, so every call fails at runtime. This is a stub an AI agent or IDE quick fix generated. Implement it before shipping.',
      mockData:
        '`{{name}}` is hardcoded mock data served from production code. Agents substitute mock data when they cannot reach the real data source, so the feature looks finished while returning fake results. Load it from the real source, or move it into a test fixture.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.physicalFilename || context.filename;
    const nonProduction = isNonProductionFile(filename);
    const testFile = isTestFile(filename);
    const sourceCode = context.sourceCode;

    function checkFunction(fn: FunctionNode): void {
      if (fn.body.type !== AST_NODE_TYPES.BlockStatement) return;
      const body = fn.body;

      // throw new Error('Not implemented') as the entire body
      if (body.body.length === 1) {
        const thrown = getThrownMessage(body.body[0]);
        if (thrown) {
          const isNotImplementedError = /^NotImplemented(?:Error|Exception)?$/.test(thrown.errorName);
          const matches = isNotImplementedError || (thrown.message !== null && NOT_IMPLEMENTED_MESSAGE.test(thrown.message.trim()));
          if (matches && !OVERRIDE_CONTRACT.test(thrown.message ?? '') && !isOverridableBaseMethod(fn, sourceCode)) {
            context.report({
              node: body.body[0],
              messageId: 'notImplemented',
              data: {
                name: getFunctionName(fn),
                thrown: thrown.message ? `${thrown.errorName}('${truncate(thrown.message)}')` : `${thrown.errorName}()`,
              },
            });
          }
          return;
        }
      }

      const what = describeTrivialBody(body);
      if (!what) return;
      const comments = sourceCode.getCommentsInside(body);
      const stubComment = comments.find((c) => STUB_COMMENT_PATTERN.test(c.value) && !isElisionComment(c, sourceCode));
      if (!stubComment) return;

      context.report({
        loc: stubComment.loc,
        messageId: 'stubBody',
        data: { name: getFunctionName(fn), what, comment: truncate(stubComment.value.trim()) },
      });
    }

    const visitors: TSESLint.RuleListener = {
      Program(): void {
        // Examples, stories and demos elide code on purpose; tests do not.
        if (nonProduction && !testFile) return;
        for (const comment of sourceCode.getAllComments()) {
          if ((comment.type as string) === 'Shebang') continue;
          if (isElisionComment(comment, sourceCode) && !isInTypeOnlyContext(comment, sourceCode)) {
            context.report({
              loc: comment.loc,
              messageId: 'elidedCode',
              data: { comment: truncate(comment.value.trim()) },
            });
          }
        }
      },
    };

    if (nonProduction) return visitors;

    return {
      ...visitors,
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      VariableDeclarator(node): void {
        if (node.id.type !== AST_NODE_TYPES.Identifier || !MOCK_NAME.test(node.id.name)) return;
        const init = node.init;
        const isDataLiteral =
          (init?.type === AST_NODE_TYPES.ArrayExpression && init.elements.length > 0) ||
          (init?.type === AST_NODE_TYPES.ObjectExpression && init.properties.length > 0);
        if (!isDataLiteral) return;

        const variable = sourceCode.getDeclaredVariables(node)[0];
        if (!variable) return;
        const served = variable.references.some((ref) => !ref.init && isServedReference(ref.identifier));
        if (!served) return;

        context.report({ node: node.id, messageId: 'mockData', data: { name: node.id.name } });
      },
    };
  },
});

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

export default noPlaceholderImplementation;
