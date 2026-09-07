import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);



/**
 * Variable name patterns that suggest secrets.
 */
const SECRET_NAME_PATTERN = /(?:secret|password|passwd|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret|jwt[_-]?secret|encryption[_-]?key|signing[_-]?key)/i;

/**
 * Patterns that are definitely NOT secrets — common false positives.
 * Stored lowercase; comparison is case-insensitive (see isFalsePositiveValue).
 */
const FALSE_POSITIVE_VALUES = new Set([
  'password',
  'secret',
  'token',
  'key',
  'api_key',
  'apikey',
  '',
  'undefined',
  'null',
  'test',
  'example',
  'placeholder',
  'changeme',
  'your-api-key',
  'your-secret',
  'xxx',
  'todo',
]);

/**
 * Variable-name suffixes that indicate the value is a hash, digest, or
 * encrypted/encoded representation rather than a plaintext secret.
 * These are excluded to reduce false positives (H5).
 */
const NON_SECRET_NAME_SUFFIXES =
  /(?:hash|hashed|digest|checksum|encrypted|encoded|hmac|bcrypt|argon|salted)$/i;

export const noHardcodedSecret = createRule({
  name: 'no-hardcoded-secret',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded secrets, API keys, passwords, and tokens in source code. AI tools frequently generate placeholder credentials that get committed to version control, creating security vulnerabilities. Includes a safe autofix that replaces literals with process.env lookups.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      hardcodedSecret:
        'Possible hardcoded secret in variable `{{name}}`. AI tools frequently generate placeholder credentials that get committed to version control. Use environment variables (e.g., `process.env.{{envName}}`) instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      VariableDeclarator(node) {
        // Only check: const SECRET = 'literal_value'
        if (!node.init) return;
        if (!node.id || node.id.type !== AST_NODE_TYPES.Identifier) return;

        const initNode = node.init;

        const varName = node.id.name;

        // Check if variable name suggests a secret
        if (!SECRET_NAME_PATTERN.test(varName)) return;

        // Only flag string literals and template literals with no expressions
        const value = getStringValue(initNode);
        if (value === null) return;

        // Skip obviously fake/placeholder values
        if (isFalsePositiveValue(value)) return;
        if (value.length < 8) return;

        // Skip variable names that clearly refer to hashes/digests/encrypted values
        if (NON_SECRET_NAME_SUFFIXES.test(varName)) return;

        context.report({
          node: initNode,
          messageId: 'hardcodedSecret',
          data: {
            name: varName,
            envName: toEnvVarName(varName),
          },
          fix: (fixer) =>
            fixer.replaceText(
              initNode,
              getProcessEnvAccessText(toEnvVarName(varName))
            ),
        });
      },

      // Also check: obj.secret = 'literal_value'
      AssignmentExpression(node) {
        if (node.left.type !== AST_NODE_TYPES.MemberExpression) return;
        if (node.left.property.type !== AST_NODE_TYPES.Identifier) return;

        const propName = node.left.property.name;
        if (!SECRET_NAME_PATTERN.test(propName)) return;

        const value = getStringValue(node.right);
        if (value === null) return;
        if (isFalsePositiveValue(value)) return;
        if (value.length < 8) return;
        if (NON_SECRET_NAME_SUFFIXES.test(propName)) return;

        context.report({
          node: node.right,
          messageId: 'hardcodedSecret',
          data: {
            name: propName,
            envName: toEnvVarName(propName),
          },
          fix: (fixer) =>
            fixer.replaceText(
              node.right,
              getProcessEnvAccessText(toEnvVarName(propName))
            ),
        });
      },

      // Check property assignments in object literals: { secret: 'value' }
      Property(node) {
        if (node.key.type !== AST_NODE_TYPES.Identifier) return;
        if (isRuleMetaMessagesProperty(node)) return;

        const propName = node.key.name;
        if (!SECRET_NAME_PATTERN.test(propName)) return;

        const valueNode = node.value as TSESTree.Expression;
        const value = getStringValue(valueNode);
        if (value === null) return;
        if (isFalsePositiveValue(value)) return;
        if (value.length < 8) return;
        if (NON_SECRET_NAME_SUFFIXES.test(propName)) return;

        context.report({
          node: valueNode,
          messageId: 'hardcodedSecret',
          data: {
            name: propName,
            envName: toEnvVarName(propName),
          },
          fix: (fixer) =>
            fixer.replaceText(
              valueNode,
              getProcessEnvAccessText(toEnvVarName(propName))
            ),
        });
      },
    };
  },
});

function getStringValue(node: TSESTree.Expression): string | null {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') {
    return node.value;
  }
  if (
    node.type === AST_NODE_TYPES.TemplateLiteral &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

function isRuleMetaMessagesProperty(node: TSESTree.Property): boolean {
  if (!node.parent || node.parent.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }

  const parentProperty = node.parent.parent;
  if (!parentProperty || parentProperty.type !== AST_NODE_TYPES.Property) {
    return false;
  }

  return (
    parentProperty.key.type === AST_NODE_TYPES.Identifier &&
    parentProperty.key.name === 'messages'
  );
}

/**
 * Case-insensitive check against the false-positive value set (M8).
 * Also normalizes underscores to hyphens so that 'YOUR_API_KEY' matches
 * 'your-api-key'.
 */
function isFalsePositiveValue(value: string): boolean {
  const normalized = value.toLowerCase().replace(/_/g, '-');
  return FALSE_POSITIVE_VALUES.has(normalized);
}

function toEnvVarName(name: string): string {
  // Convert camelCase/PascalCase to UPPER_SNAKE_CASE
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]/g, '_')
    .toUpperCase();
}

function getProcessEnvAccessText(envName: string): string {
  if (/^[A-Z_$][A-Z0-9_$]*$/.test(envName)) {
    return `process.env.${envName}`;
  }

  return `process.env['${envName.replace(/'/g, "\\'")}']`;
}

export default noHardcodedSecret;
