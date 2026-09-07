import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/**
 * SQL statement signatures. We intentionally require query-like combinations
 * to avoid false positives for normal app strings (e.g., "create", "from").
 */
const SQL_STATEMENT_PATTERN =
  /\b(select\s+[\s\S]*\s+from|insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s+table|create\s+(table|database)|alter\s+table|truncate\s+table|exec(?:ute)?\s+\S+|union\s+select)\b/i;

const SQL_SINK_METHODS = new Set([
  'query',
  'execute',
  'queryraw',
  'queryrawunsafe',
  'executeraw',
  'executerawunsafe',
  'raw',
  'run',
  'all',
  'get',
  'prepare',
]);

const SQL_SINK_FUNCTIONS = new Set(['query', 'execute']);

const KNOWN_QUERY_BUILDERS = new Set([
  'knex',
  'drizzle',
  'prisma',
  'kysely',
  'sequelize',
  'typeorm',
  'mikroorm',
]);

const QUERY_BUILDER_METHOD_HINTS = new Set([
  'raw',
  'query',
  'execute',
  'from',
  'where',
  'whereraw',
  'queryraw',
  'queryrawunsafe',
  'executeraw',
  'executerawunsafe',
  'select',
  'selectfrom',
  'insert',
  'update',
  'delete',
  'join',
  'orderby',
  'groupby',
  'having',
]);

function getIdentifierName(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }
  return null;
}

function isSqlSinkCall(node: TSESTree.CallExpression): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return SQL_SINK_FUNCTIONS.has(node.callee.name.toLowerCase());
  }

  if (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    const methodName = node.callee.property.name.toLowerCase().replace(/^\$/, '');
    return SQL_SINK_METHODS.has(methodName);
  }

  return false;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getMemberPropertyName(
  property: TSESTree.Expression | TSESTree.PrivateIdentifier,
  computed: boolean,
): string | null {
  if (!computed && property.type === AST_NODE_TYPES.Identifier) {
    return property.name;
  }

  if (computed && property.type === AST_NODE_TYPES.Literal && typeof property.value === 'string') {
    return property.value;
  }

  return null;
}

function getExpressionPathParts(node: TSESTree.Node): string[] {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return [node.name];
  }

  if (node.type === AST_NODE_TYPES.ThisExpression) {
    return ['this'];
  }

  if (node.type === AST_NODE_TYPES.CallExpression) {
    return getExpressionPathParts(node.callee);
  }

  if (node.type === AST_NODE_TYPES.MemberExpression) {
    const objectParts = getExpressionPathParts(node.object);
    const propertyName = getMemberPropertyName(node.property, node.computed);
    return propertyName ? [...objectParts, propertyName] : objectParts;
  }

  if (
    node.type === AST_NODE_TYPES.NewExpression &&
    (node.callee.type === AST_NODE_TYPES.Identifier ||
      node.callee.type === AST_NODE_TYPES.MemberExpression)
  ) {
    return getExpressionPathParts(node.callee);
  }

  return [];
}

function isKnownBuilderName(name: string): boolean {
  return KNOWN_QUERY_BUILDERS.has(normalizeToken(name));
}

function isBuilderMethodHint(name: string): boolean {
  return QUERY_BUILDER_METHOD_HINTS.has(normalizeToken(name));
}

function isKnownBuilderBinding(name: string, builderBindings: Set<string>): boolean {
  if (builderBindings.has(name)) {
    return true;
  }

  return builderBindings.has(normalizeToken(name));
}

function isKnownBuilderExpression(
  node: TSESTree.Expression,
  builderBindings: Set<string>,
): boolean {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return isKnownBuilderName(node.name) || isKnownBuilderBinding(node.name, builderBindings);
  }

  if (node.type === AST_NODE_TYPES.CallExpression || node.type === AST_NODE_TYPES.NewExpression) {
    const pathParts = getExpressionPathParts(node.callee);

    return pathParts.some(
      (part) => isKnownBuilderName(part) || isKnownBuilderBinding(part, builderBindings),
    );
  }

  if (node.type === AST_NODE_TYPES.MemberExpression) {
    const pathParts = getExpressionPathParts(node);
    return pathParts.some(
      (part) => isKnownBuilderName(part) || isKnownBuilderBinding(part, builderBindings),
    );
  }

  return false;
}

function isKnownQueryBuilderContext(
  node: TSESTree.CallExpression,
  builderBindings: Set<string>,
): boolean {
  const pathParts = getExpressionPathParts(node.callee);
  if (pathParts.length === 0) {
    return false;
  }

  const hasBuilderIdentity = pathParts.some(
    (part) => isKnownBuilderName(part) || isKnownBuilderBinding(part, builderBindings),
  );

  if (!hasBuilderIdentity) {
    const rootPart = pathParts[0];
    if (!rootPart || !isKnownBuilderBinding(rootPart, builderBindings)) {
      return false;
    }
  }

  return pathParts.some((part) => isBuilderMethodHint(part));
}

function resolveExpression(
  node: TSESTree.Expression,
  variableMap: Map<string, TSESTree.Expression>,
): TSESTree.Expression {
  const identifier = getIdentifierName(node);
  if (identifier && variableMap.has(identifier)) {
    return variableMap.get(identifier)!;
  }
  return node;
}

function isDynamicSqlExpression(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.TemplateLiteral) {
    if (node.expressions.length === 0) {
      return false;
    }
    const staticText = node.quasis.map((q) => q.value.raw).join(' ');
    return SQL_STATEMENT_PATTERN.test(staticText);
  }

  if (node.type === AST_NODE_TYPES.BinaryExpression && node.operator === '+') {
    const staticText = collectStaticText(node);
    if (!SQL_STATEMENT_PATTERN.test(staticText)) {
      return false;
    }
    return hasDynamicParts(node);
  }

  return false;
}

export const noSqlStringConcat = createRule({
  name: 'no-sql-string-concat',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow string concatenation or interpolation with variables in SQL query contexts. AI tools frequently generate SQL queries using template literals or string concatenation with user input, creating SQL injection vulnerabilities.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      sqlStringConcat:
        'Potential SQL injection: string concatenation or interpolation detected in a SQL query. AI tools frequently generate this pattern. Use parameterized queries (e.g., `db.query("SELECT * FROM users WHERE id = $1", [id])`) instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const variableMap = new Map<string, TSESTree.Expression>();
    const builderBindings = new Set<string>();

    return {
      VariableDeclarator(node) {
        if (node.id.type !== AST_NODE_TYPES.Identifier || !node.init) {
          return;
        }

        if (node.init.type === AST_NODE_TYPES.AwaitExpression) {
          builderBindings.delete(node.id.name);
          builderBindings.delete(normalizeToken(node.id.name));
          return;
        }

        variableMap.set(node.id.name, node.init);

        if (isKnownBuilderExpression(node.init, builderBindings)) {
          builderBindings.add(node.id.name);
          builderBindings.add(normalizeToken(node.id.name));
          return;
        }

        builderBindings.delete(node.id.name);
        builderBindings.delete(normalizeToken(node.id.name));
      },

      AssignmentExpression(node) {
        if (node.left.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (node.right.type === AST_NODE_TYPES.AwaitExpression) {
          builderBindings.delete(node.left.name);
          builderBindings.delete(normalizeToken(node.left.name));
          return;
        }

        variableMap.set(node.left.name, node.right);

        if (isKnownBuilderExpression(node.right, builderBindings)) {
          builderBindings.add(node.left.name);
          builderBindings.add(normalizeToken(node.left.name));
          return;
        }

        builderBindings.delete(node.left.name);
        builderBindings.delete(normalizeToken(node.left.name));
      },

      CallExpression(node) {
        if (!isSqlSinkCall(node)) {
          return;
        }

        // Avoid false positives for known query-builder chains.
        if (isKnownQueryBuilderContext(node, builderBindings)) {
          return;
        }

        const firstArg = node.arguments[0];
        if (!firstArg || firstArg.type === AST_NODE_TYPES.SpreadElement) {
          return;
        }

        const resolved = resolveExpression(firstArg, variableMap);
        if (!isDynamicSqlExpression(resolved)) {
          return;
        }

        context.report({
          node: firstArg,
          messageId: 'sqlStringConcat',
        });
      },
    };
  },
});

function collectStaticText(node: TSESTree.Expression | TSESTree.PrivateIdentifier): string {
  if (node.type === AST_NODE_TYPES.BinaryExpression && node.operator === '+') {
    return `${collectStaticText(node.left)} ${collectStaticText(node.right)}`;
  }

  const literalValue = getStringLiteralValue(node);
  return literalValue ?? '';
}

function hasDynamicParts(node: TSESTree.Expression | TSESTree.PrivateIdentifier): boolean {
  if (node.type === AST_NODE_TYPES.BinaryExpression && node.operator === '+') {
    return hasDynamicParts(node.left) || hasDynamicParts(node.right);
  }

  return !isStaticString(node);
}

function getStringLiteralValue(node: TSESTree.Expression | TSESTree.PrivateIdentifier): string | null {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') {
    return node.value;
  }
  return null;
}

function isStaticString(node: TSESTree.Expression | TSESTree.PrivateIdentifier): boolean {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') {
    return true;
  }
  if (
    node.type === AST_NODE_TYPES.TemplateLiteral &&
    node.expressions.length === 0
  ) {
    return true;
  }
  return false;
}

export default noSqlStringConcat;
