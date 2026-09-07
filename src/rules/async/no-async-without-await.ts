import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import path from 'path';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// â”€â”€â”€ Framework file patterns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Files where async-without-await is a framework convention, not a mistake.
// Next.js App Router, middleware, and page conventions.

const FRAMEWORK_FILE_PATTERNS = [
  // Next.js App Router
  [/[/\\]route\.(ts|js|tsx|jsx)$/,
  /[/\\]middleware\.(ts|js)$/,
  /[/\\]layout\.(tsx|jsx|ts|js)$/,
  /[/\\]page\.(tsx|jsx|ts|js)$/,
  /[/\\]loading\.(tsx|jsx|ts|js)$/,
  /[/\\]error\.(tsx|jsx|ts|js)$/,
  /[/\\]not-found\.(tsx|jsx|ts|js)$/,
  /[/\\]template\.(tsx|jsx|ts|js)$/,
  // Next.js Pages Router conventions
  /[/\\]_app\.(tsx|jsx)$/,
  /[/\\]_document\.(tsx|jsx)$/,
];

// HTTP method export names â€” always valid async in route files
const HTTP_METHOD_EXPORTS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

// React UI file extensions â€” handle* functions are conventionally async
const REACT_FILE_EXTENSIONS = new Set(['.tsx', '.jsx']);

// Names that strongly suggest the function is an event handler by convention
const HANDLER_NAME_REGEX = /^(handle|on[A-Z])/;

// Names that suggest the function is middleware or a lifecycle hook
const MIDDLEWARE_NAME_REGEX = /^(use[A-Z]|middleware|interceptor|guard|beforeEach|afterEach)/;

// â”€â”€â”€ Heuristics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function containsAwaitExpression(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.AwaitExpression) {
    return true;
  }

  if (node.type === AST_NODE_TYPES.ForOfStatement && node.await) {
    return true;
  }

  // Do not count await expressions inside nested functions.
  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return false;
  }

  const entries = Object.entries(node) as Array<[string, unknown]>;
  for (const [key, value] of entries) {
    if (key === 'parent') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          if (containsAwaitExpression(child as TSESTree.Node)) {
            return true;
          }
        }
      }
      continue;
    }

    if (value && typeof value === 'object' && 'type' in value) {
      if (containsAwaitExpression(value as TSESTree.Node)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if the function body is a single return statement that directly
 * calls a function (pass-through wrapper pattern).
 * Example: async function wrap() { return someApi(); }
 * These are intentionally async for Promise propagation â€” low-confidence finding.
 */
function isPassThroughWrapper(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): boolean {
  if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
    // Arrow with expression body: async () => foo() â€” pass-through
    const body = node.body;
    if (
      body.type === AST_NODE_TYPES.CallExpression ||
      body.type === AST_NODE_TYPES.MemberExpression
    ) {
      return true;
    }
    return false;
  }

  if (node.body.body.length !== 1) return false;
  const only = node.body.body[0];
  if (only.type !== AST_NODE_TYPES.ReturnStatement) return false;
  if (!only.argument) return false;

  // Return of a call expression â€” likely pass-through
  return only.argument.type === AST_NODE_TYPES.CallExpression;
}

/**
 * Returns true if the function body contains a try/catch block with a return
 * statement inside the try. This is a legitimate use of async â€” the function
 * needs to be async so that promise rejections from the returned value are
 * caught by the catch block.
 *
 * Pattern:
 *   async function f() {
 *     try { return somePromise(); }
 *     catch (e) { handleError(e); }
 *   }
 *
 * Without async, `return somePromise()` would bypass the catch entirely.
 */
function hasTryCatchWithReturn(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): boolean {
  if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
    return false;
  }

  for (const stmt of node.body.body) {
    if (stmt.type !== AST_NODE_TYPES.TryStatement) {
      continue;
    }

    // Must have a catch or finally handler
    if (!stmt.handler && !stmt.finalizer) {
      continue;
    }

    // Check if the try block contains a return statement
    const tryBlock = stmt.block;
    for (const tryStmt of tryBlock.body) {
      if (tryStmt.type === AST_NODE_TYPES.ReturnStatement) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if this is a framework-required async export.
 * Next.js App Router requires GET/POST/etc handlers to be async even if they
 * use synchronous APIs internally.
 */
function isFunctionExportedWithHttpMethodName(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): boolean {
  // Named function declaration: export async function GET() {}
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
    return HTTP_METHOD_EXPORTS.has(node.id.name);
  }

  // Variable declaration: export const GET = async () => {}
  if (node.parent?.type === AST_NODE_TYPES.VariableDeclarator) {
    const declarator = node.parent;
    if (
      declarator.id.type === AST_NODE_TYPES.Identifier &&
      HTTP_METHOD_EXPORTS.has(declarator.id.name)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Get the function name for heuristic checks.
 */
function getFunctionName(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): string | null {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
    return node.id.name;
  }

  if (node.parent?.type === AST_NODE_TYPES.VariableDeclarator) {
    const declarator = node.parent;
    if (declarator.id.type === AST_NODE_TYPES.Identifier) {
      return declarator.id.name;
    }
  }

  if (
    node.parent?.type === AST_NODE_TYPES.Property ||
    node.parent?.type === AST_NODE_TYPES.MethodDefinition
  ) {
    const parent = node.parent;
    if (
      'key' in parent &&
      parent.key.type === AST_NODE_TYPES.Identifier
    ) {
      return parent.key.name;
    }
  }

  return null;
}

// â”€â”€â”€ Schema options â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface RuleOptions {
  allowedFunctionNames?: string[];
  ignorePassThroughWrappers?: boolean;
  ignoreHandlerFunctions?: boolean;
}

export const noAsyncWithoutAwait = createRule<[RuleOptions], 'asyncWithoutAwait' | 'asyncPassThrough' | 'addAwait'>({
  name: 'no-async-without-await',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow async functions that never use await. AI tools frequently add async by default, creating misleading signatures and unnecessary Promise wrappers. Framework-specific async conventions (Next.js route handlers, React event handlers) are excluded.',
    },
    fixable: undefined,
    hasSuggestions: true,
    schema: [
      {
        type: 'object',
        properties: {
          allowedFunctionNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional function names to skip (on top of HTTP methods)',
          },
          ignorePassThroughWrappers: {
            type: 'boolean',
            description: 'Downgrade (not suppress) pass-through wrappers. Default: true.',
          },
          ignoreHandlerFunctions: {
            type: 'boolean',
            description: 'Skip functions named handle* or on* in .tsx/.jsx files. Default: true.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      asyncWithoutAwait:
        'Async function does not contain `await`. AI tools frequently add `async` unnecessarily, which can mislead callers and mask intent. Remove `async` or add proper await logic.',
      asyncPassThrough:
        'Async pass-through wrapper â€” this may be intentional for Promise propagation. Consider whether `async` is needed here.',
      addAwait: 'Add `await` to the expression to make the async function meaningful.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const {
      allowedFunctionNames = [],
      ignorePassThroughWrappers = true,
      ignoreHandlerFunctions: true,
    } = options;

    // All HTTP methods + user-provided names are always skipped
    const skipNames = new Set([...HTTP_METHOD_EXPORTS, ...allowedFunctionNames]);

    // Check if we're in a framework file (suppress entirely)
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const fileExt = path.extname(filename).toLowerCase();

    const isFrameworkFile = FRAMEWORK_FILE_PATTERNS.some((pattern) => pattern.test(filename));
    const isReactFile = REACT_FILE_EXTENSIONS.has(fileExt);

    function buildSuggestion(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression,
    ): TSESLint.SuggestionReportDescriptor<'addAwait'>[] | undefined {
      const sourceCode = context.sourceCode;

      // Only suggest adding await for expressions that could reasonably be
      // promises (CallExpression or MemberExpression). For literals,
      // identifiers, and other non-promise expressions, adding await is
      // semantically nonsensical (e.g. `return await (1)`) so we don't
      // offer the suggestion.
      if (node.body.type !== AST_NDE_TYPES.BlockStatement) {
        const body = node.body;
        if (
          body.type === AST_NODE_TYPES.CallExpression ||
          body.type === AST_NODE_TYPES.MemberExpression
        ) {
          const exprText = sourceCode.getText(body);
          return [{
            messageId: 'addAwait',
            fix: (fixer: TSESLint.RuleFixer) => fixer.replaceText(body, `await (${exprText})`),
          }];
        }
        return undefined;
      }

      if (node.body.body.length !== Ä¤ì(€€€€€€€É•ÑÕÉ¸Õ¹‘•™¥¹•ì(€€€€€ô((€€€€€½¹ÍÐ½¹±åMÑ…Ñ•µ•¹Ð€ô¹½‘”¹‰½‘ä¹‰½‘ålÁtì((€€€€€¥˜€ (€€€€€€€½¹±åMÑ…Ñ•µ•¹Ð¹ÑåÁ”€ôôôMQ}9}QeAL¹I•ÑÕÉ¹MÑ…Ñ•µ•¹Ð€˜˜(€€€€€€€½¹±åMÑ…Ñ•µ•¹Ð¹…ÉÕµ•¹Ð€˜˜(€€€€€€€½¹±åMÑ…Ñ•µ•¹Ð¹…ÉÕµ•¹Ð¹ÑåÁ”€„ôôMQ}9=}QeAL¹Ý…¥ÑáÁÉ•ÍÍ¥½¸(€€€€€€¤ì(€€€€€€€½¹ÍÐ…Éœ€ô½¹±åMÑ…Ñ•µ•¹Ð¹…ÉÕµ•¹Ðì(€€€€€€€€¼¼=¹±äÍÕ•ÍÐ™½È…±°•áÁÉ•ÍÍ¥½¹Ì½Èµ•µ‰•È•áÁÉ•ÍÍ¥½¹Ì€¡Á½Ñ•¹Ñ¥…°ÁÉ½µ¥Í•Ì¤(€€€€€€€¥˜€ (€€€€€€€€€…Éœ¹ÑåÁ”€ôôôMQ}9=}QeAL¹…±±áÁÉ•ÍÍ¥½¸ñð(€€€€€€€€€€…Éœ¹ÑåÁ”€ôôôMQ}9=}QeAL¹5•µ‰•ÉáÁÉ•ÍÍ¥½¸(€€€€€€€€¤ì(€€€€€€€€€½¹ÍÐÉ•ÑÕÉ¹Y…±Õ•Q•áÐ€ôÍ½ÕÉ•½‘”¹•ÑQ•áÐ¡…Éœ¤ì(€€€€€€€€€É•ÑÕÉ¸mì(€€€€€€€€€€€µ•ÍÍ…•%è€…‘‘Ý…¥Ðœ°(€€€€€€€€€€€™¥àè€¡™¥á•ÈèQMM1¥¹Ð¹IÕ±•¥á•È¤€ôø™¥á•È¹É•Á±…•Q•áÐ¡…Éœ…ÌQMMQÉ•”¹9½‘”°…Ý…¥Ð€ ‘íÉ•ÑÕÉ¹Y…±Õ•Q•áÑô¥€¤°(€€€€€€€€€õtì(€€€€€€€ô(€€€€€€€É•ÑÕÉ¸Õ¹‘•™¥¹•ì(€€€€€ô((€€€€€¥˜€¡½¹±åMÑ…Ñ•µ•¹Ð¹ÑåÁ”€ôôôMQ}9=}QeAL¹áÁÉ•ÍÍ¥½¹MÑ…Ñ•µ•¹Ð¤ì(€€€€€€€½¹ÍÐ•áÁÈ€ô½¹±åMÑ…Ñ•µ•¹Ð¹•áÁÉ•ÍÍ¥½¸ì(€€€€€€€¥˜€ (€€€€€€€€€•áÁÈ¹ÑåÁ”€ôôôMQ}9=}QeAL¹…±±áÁÉ•ÍÍ¥½¸ñð(€€€€€€€€€•áÁÈ¹ÑåÁ”€ôôôMQ}9=}QeAL¹5•µ‰•ÉáÁÉ•ÍÍ¥½¸(€€€€€€€€¤ì(€€€€€€€€€½¹ÍÐ•áÁÉQ•áÐ€ôÍ½ÕÉ•½‘”¹•ÑQ•áÐ¡•áÁÈ¤ì(€€€€€€€€€É•ÑÕÉ¸mì(€€€€€€€€€€€µ•ÍÍ…•%è€…‘‘Ý…¥Ðœ°(€€€€€€€€€€€™¥àè€¡™¥á•ÈèQMM1¥¹Ð¹IÕ±•¥á•È¤€ôø™¥á•È¹É•Á±…•Q•áÐ¡•áÁÈ…ÌQMMQÉ•”¹9½‘”°…Ý…¥Ð€ ‘í•áÁÉQ•áÑô¥€¤°(€€€€€€€€€õtì(€€€€€€€ô(€€€€€ô((€€€€€É•ÑÕÉ¸Õ¹‘•™¥¹•ì(€€€ô((€€€™Õ¹Ñ¥½¸É•Á½ÉÑ%™9••‘• (€€€€€¹½‘”è(€€€€€€€ðQMMQÉ•”¹Õ¹Ñ¥½¹•±…É…Ñ¥½¸(€€€€€€€ðQMMQÉ•”¹Õ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸(€€€€€€€ðQMMQÉ•”¹ÉÉ½ÝÕ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸(€€€€¤èÙ½¥ì(€€€€€¥˜€ …¹½‘”¹…Íå¹Œ¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€Ä¸É…µ•Ý½É¬™¥±”ÍÕÁÁÉ•ÍÍ¥½¸ƒŠP•¹Ñ¥É•±äÍ­¥À(€€€€€¥˜€¡¥ÍÉ…µ•Ý½É­¥±”¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€È¸!QQ@µ•Ñ¡½•áÁ½ÉÐÍÕÁÁÉ•ÍÍ¥½¸ƒŠPP½A=MP½•ÑŒ…É”…±Ý…åÌ…Íå¹Œ‰ä½¹Ù•¹Ñ¥½¸(€€€€€¥˜€¡¥ÍÕ¹Ñ¥½¹áÁ½ÉÑ•‘]¥Ñ¡!ÑÑÁ5•Ñ¡½‘9…µ”¡¹½‘”¤¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€Ì¸Õ¹Ñ¥½¸¹…µ”ÍÕÁÁÉ•ÍÍ¥½¸(€€€€€½¹ÍÐ™Õ¹9…µ”€ô•ÑÕ¹Ñ¥½¹9…µ”¡¹½‘”¤ì(€€€€€¥˜€¡™Õ¹9…µ”€˜˜Í­¥Á9…µ•Ì¹¡…Ì¡™Õ¹9…µ”¤¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€Ð¸5¥‘‘±•Ý…É”½±¥™•å±”¹…µ•ÌƒŠP½™Ñ•¸…Íå¹Œ‰ä½¹Ù•¹Ñ¥½¸(€€€€€¥˜€¡™Õ¹9…µ”€˜˜5%1]I}95}I`¹Ñ•ÍÐ¡™Õ¹9…µ”¤¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€Ô¸I•…Ð¡…¹‘±•È™Õ¹Ñ¥½¹Ì¥¸€¹ÑÍà¼¹©ÍàƒŠP¡…¹‘±”¨…¹½¸¨…É”…Íå¹Œ‰ä½¹Ù•¹Ñ¥½¸(€€€€€¥˜€¡¥¹½É•!…¹‘±•ÉÕ¹Ñ¥½¹Ì€˜˜¥ÍI•…Ñ¥±”€˜˜™Õ¹9…µ”€˜˜!91I}95}I`¹Ñ•ÍÐ¡™Õ¹9…µ”¤¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼¡•¬™½È…Ý…¥Ð(€€€€€½¹ÍÐ‰½‘å!…ÍÝ…¥Ð€ô(€€€€€€€¹½‘”¹‰½‘ä¹ÑåÁ”€ôôôMQ}9=}QeAL¹	±½­MÑ…Ñ•µ•¹Ð(€€€€€€€€€€ü½¹Ñ…¥¹ÍÝ…¥ÑáÁÉ•ÍÍ¥½¸¡¹½‘”¹‰½‘ä¤(€€€€€€€€€€è¹½‘”¹‰½‘ä¹ÑåÁ”€ôôôMQ}9=}QeAL¹Ý…¥ÑáÁÉ•ÍÍ¥½¸ì((€€€€€¥˜€¡‰½‘å!…ÍÝ…¥Ð¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€Ø¸QÉä½…Ñ Ý¥Ñ É•ÑÕÉ¸ƒŠP…Íå¹Œ¥Ì¥¹Ñ•¹Ñ¥½¹…°™½ÈÁÉ½µ¥Í”É•©•Ñ¥½¸¡…¹‘±¥¹œ(€€€€€€¼¼A…ÑÑ•É¸è…Íå¹Œ™Õ¹Ñ¥½¸˜ ¤ìÑÉäìÉ•ÑÕÉ¸Í½µ•AÉ½µ¥Í” ¤ìô…Ñ ì€¸¸¸ôô(€€€€€€¼¼]¥Ñ¡½ÕÐ…Íå¹Œ°Ñ¡”É•ÑÕÉ¹•ÁÉ½µ¥Í”Ý½Õ±É•©•ÐÕ¹…Õ¡Ð¸(€€€€€¥˜€¡¹½‘”¹‰½‘ä¹ÑåÁ”€ôôôMQ}9=}QeAL¹	±½­MÑ…Ñ•µ•¹Ð€˜˜¡…ÍQÉå…Ñ¡]¥Ñ¡I•ÑÕÉ¸¡¹½‘”¤¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼€Ø¸A…ÍÌµÑ¡É½Õ ÝÉ…ÁÁ•ÈƒŠP‘½Ý¹É…‘”Í•Ù•É¥ÑäÑ¼¥¹™½Éµ…Ñ¥½¹…°°¹½Ð„™Õ±°•ÉÉ½È(€€€€€¥˜€¡¥¹½É•A…ÍÍQ¡É½Õ¡]É…ÁÁ•ÉÌ€˜˜¥ÍA…ÍÍQ¡É½Õ¡]É…ÁÁ•È¡¹½‘”¤¤ì(€€€€€€€½¹Ñ•áÐ¹É•Á½ÉÐ¡ì(€€€€€€€€€¹½‘”°(€€€€€€€€€µ•ÍÍ…•%è€…Íå¹A…ÍÍQ¡É½Õ œ°(€€€€€€€€€€¼¼9¼…ÕÑ½™¥à™½ÈÁ…ÍÌµÑ¡É½Õ ƒŠP¥ÐÌ¥¹Ñ•¹Ñ¥½¹…°(€€€€€€€ô¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼ÉÉ½ÜÝ¥Ñ ¹½¸µ‰±½¬‰½‘äÑ¡…Ð¥Ì¹½Ð…¸Ý…¥ÑáÁÉ•ÍÍ¥½¸(€€€€€¥˜€¡¹½‘”¹‰½‘ä¹ÑåÁ”€„ôôMQ}9=}QeAL¹	±½­MÑ…Ñ•µ•¹Ð¤ì(€€€€€€€¥˜€¡¹½‘”¹‰½‘ä¹ÑåÁ”€„ôôMQ}9=}QeAL¹Ý…¥ÑáÁÉ•ÍÍ¥½¸¤ì(€€€€€€€€€½¹ÍÐÍÕ•ÍÐ€ô‰Õ¥±‘MÕ•ÍÑ¥½¸¡¹½‘”¤ì(€€€€€€€€€½¹Ñ•áÐ¹É•Á½ÉÐ¡ì(€€€€€€€€€€€¹½‘”°(€€€€€€€€€€€µ•ÍÍ…•%è€…Íå¹]¥Ñ¡½ÕÑÝ…¥Ðœ°(€€€€€€€€€€€ÍÕ•ÍÐ°(€€€€€€€€€ô¤ì(€€€€€€€ô(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô((€€€€€€¼¼	±½¬‰½‘äÝ¥Ñ ¹¼…Ý…¥Ð(€€€€€½¹ÍÐÍÕ•ÍÐ€ô‰Õ¥±‘MÕ•ÍÑ¥½¸¡¹½‘”¤ì(€€€€€½¹Ñ•áÐ¹É•Á½ÉÐ¡ì(€€€€€€€¹½‘”°(€€€€€€€µ•ÍÍ…•%è€…Íå¹]¥Ñ¡½ÕÑÝ…¥Ðœ°(€€€€€€€ÍÕ•ÍÐ°(€€€€€ô¤ì(€€€ô((€€€É•ÑÕÉ¸ì(€€€€€Õ¹Ñ¥½¹•±…É…Ñ¥½¸èÉ•Á½ÉÑ%™9••‘•°(€€€€€Õ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸èÉ•Á½ÉÑ%™9••‘•°(€€€€€ÉÉ½ÝÕ¹Ñ¥½¹áÁÉ•ÍÍ¥½¸èÉ•Á½ÉÑ%™9••‘•°(€€€ôì(€ô°)ô¤ì()•áÁ½ÉÐ‘•™…Õ±Ð¹½Íå¹]¥Ñ¡½ÕÑÝ…¥Ðì