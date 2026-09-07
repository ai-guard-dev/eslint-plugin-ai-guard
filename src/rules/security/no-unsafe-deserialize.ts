import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

// Files where JSON.parse on internal data is expected and safe
const INTERNAL_FILE_PATTERNS = [
  /[\\\/]debug[\\\/]i,
  /[\\\/]scripts[\\\/]i,
  /[\\\/]tools[\\\/]i,
  /[\\\/]migrations?[\\\/]i,
  /[\\\/]seeds?[\\\/]i,
  /[\\\/]fixtures[\\\/]i,
  /\bcheck[-_]server/i,
  /\bdebug[-_]server/i,
  /\bdiagnostics/i,
  /\bseed\./i,
  /\bmigrat(?:e|ion)\./i,
  /\bsetup\./i,
  /\bscaffold\./i,
  /\btest[-_].*\.js$/i,
];

function isInternalToolingFile(filePath: string): boolean {
  return INTERNAL_FILE_PATTERNS.some((p) => p.test(filePath));
}

const UNTRUSTED_IDENTIFIER_NAMES = [
  'input',
  'userInput',
  'rawBody',
  'payload',
  'body',
  'query',
  'param',
  'params',
  'data',
  'requestBody',
] as const;

function isJsonParseCall(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    node.callee.object.name === 'JSON' &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === 'parse'
  );
}

function isLikelyUntrustedSource(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return UNTRUSTED_IDENTIFIER_NAMES.includes(
      node.name as (typeof UNTRUSTED_IDENTIFIER_NAMES)[number]
    );
  }

  if (node.type === AST_NODE_TYPES.MemberExpression) {
    // req.body, req.query, req.params, request.body
    if (
      node.object.type === AST_NODE_TYPES.Identifier &&
      ['req', 'request'].includes(node.object.name) &&
      node.property.type === AST_NODE_TYPES.Identifier &&
      ['body', 'query', 'params'].includes(node.property.name)
    ) {
      return true;
    }

    // window.location.hash/search
    if (
      node.object.type === AST_NODE_TYPES.MemberExpression &&
      node.object.object.type === AST_NODE_TYPES.Identifier &&
      node.object.object.name === 'window' &&
      node.object.property.type === AST_NODE_TYPES.Identifier &&
      node.object.property.name === 'location' &&
      node.property.type === AST_NODE_TYPES.Identifier &&
      ['hash', 'search'].includes(node.property.name)
    ) {
      return true;
    }
  }

  return false;
}

export const noUnsafeDeserialize = createRule({
  name: 'no-unsafe-deserialize',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow JSON.parse() on likely untrusted input without visible validation. AI tools frequently parse request/user payloads directly, which can introduce unsafe deserialization and downstream injection risks.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      unsafeDeserialize:
        'JSON.parse() on likely untrusted input without visible schema validation. Validate or sanitize the input before parsing to prevent deserialization of unexpected data.',
    },
  },
  defaultOptions: [],
  create(context) {
    // Suppress in internal tooling files where JSON.parse on internal data is expected
    const filePath = context.filename ?? context.getFilename?.() ?? '';
    if (isInternalToolingFile(filePath)) return {};

    return {
      CallExpression(node) {
        if (!isJsonParseCall(node)) {
          return;
        }

        const inputArg = node.arguments[0];
        if (!inputArg) {
          return;
        }

        if (isLikelyUntrustedSource(inputArg)) {
          context.report({
            node,
            messageId: 'unsafeDeserialize',
          });
        }
      },
    };
  },
});

export default noUnsafeDeserialize;
