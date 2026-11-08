import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import {
  getEnvAccess,
  isImportMetaEnv,
  isProcessEnv,
  splitEnvName,
  hasNonSecretTrailingSegment,
  hasPublicCredentialMarker,
  isGenericSecretEnvName,
} from '../../utils/env-access';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/**
 * Prefixes that bundlers inline into client-side JavaScript.
 * Longest first so `NUXT_PUBLIC_` wins over `PUBLIC_`.
 */
const PUBLIC_PREFIXES = [
  'NEXT_PUBLIC_',
  'NUXT_PUBLIC_',
  'EXPO_PUBLIC_',
  'REACT_APP_',
  'VUE_APP_',
  'GATSBY_',
  'VITE_',
  'PUBLIC_',
] as const;

/** Model and email providers whose API keys are always server-side credentials. */
const SERVER_ONLY_PROVIDERS =
  'OPENAI|ANTHROPIC|CLAUDE|GROQ|MISTRAL|COHERE|REPLICATE|HUGGINGFACE|HF|ELEVENLABS|PERPLEXITY|DEEPSEEK|TOGETHER|FIREWORKS|XAI|GROK|GEMINI|OPENROUTER|PINECONE|RESEND|SENDGRID|MAILGUN|POSTMARK';

const DATABASE_URL_PATTERN =
  /_(DATABASE|DB|POSTGRES|POSTGRESQL|PG|MYSQL|MONGO|MONGODB|REDIS)_(URL|URI|CONNECTION_STRING|CONNECTION)_/;

/**
 * Credential names that must never reach a browser. Deliberately narrower than
 * a generic secret check: Firebase, Google Maps and Mapbox keys/tokens are
 * designed to be public, so generic `*_API_KEY` / `*_ACCESS_TOKEN` are not flagged.
 */
export function isBrowserForbiddenName(nameWithoutPrefix: string): boolean {
  const segments = splitEnvName(nameWithoutPrefix);
  if (segments.length === 0) return false;
  const joined = `_${segments.join('_')}_`;

  // Connection strings carry passwords; check before the URL/URI suffix exemption.
  if (DATABASE_URL_PATTERN.test(joined)) return true;
  if (hasNonSecretTrailingSegment(segments)) return false;
  if (hasPublicCredentialMarker(segments)) return false;

  return (
    /_(SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)_/.test(joined) ||
    /_SERVICE_ROLE_/.test(joined) ||
    /_SERVICE_(ACCOUNT_)?KEY_/.test(joined) ||
    /_(PRIVATE|SIGNING|ENCRYPTION|MASTER|ADMIN)_KEY_/.test(joined) ||
    /_(AUTH|ADMIN|BOT|REFRESH|SERVICE)_TOKEN_/.test(joined) ||
    /_PERSONAL_ACCESS_TOKEN_/.test(joined) ||
    /_(GITHUB|GH|GITLAB|NPM|SLACK|DISCORD|TELEGRAM|VERCEL|NETLIFY|HF|HUGGINGFACE)_TOKEN_/.test(joined) ||
    new RegExp(`_(${SERVER_ONLY_PROVIDERS})_(API_)?KEY_`).test(joined) ||
    new RegExp(`_(${SERVER_ONLY_PROVIDERS})_APIKEY_`).test(joined)
  );
}

function getPublicPrefix(name: string): string | null {
  return PUBLIC_PREFIXES.find((prefix) => name.startsWith(prefix)) ?? null;
}

function hasUseClientDirective(program: TSESTree.Program): boolean {
  for (const statement of program.body) {
    if (statement.type !== AST_NODE_TYPES.ExpressionStatement || !statement.directive) break;
    if (statement.directive === 'use client') return true;
  }
  return false;
}

function getPropertyKeyName(property: TSESTree.Property): string | null {
  if (!property.computed && property.key.type === AST_NODE_TYPES.Identifier) return property.key.name;
  if (property.key.type === AST_NODE_TYPES.Literal && typeof property.key.value === 'string') {
    return property.key.value;
  }
  return null;
}

function findProperty(object: TSESTree.ObjectExpression, name: string): TSESTree.Property | null {
  for (const property of object.properties) {
    if (property.type === AST_NODE_TYPES.Property && getPropertyKeyName(property) === name) {
      return property;
    }
  }
  return null;
}

type Options = [{ allow?: string[] }];
type MessageIds = 'publicPrefixSecret' | 'serverSecretInClient' | 'browserLlmClient';

export const noClientExposedSecret = createRule<Options, MessageIds>({
  name: 'no-client-exposed-secret',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow server secrets that reach the browser: secret env vars with public bundler prefixes (NEXT_PUBLIC_, VITE_, EXPO_PUBLIC_, REACT_APP_), server secrets read in "use client" files, and LLM SDK clients created with dangerouslyAllowBrowser and an app-owned key. AI app builders add these prefixes to make a secret "work" in client code.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Env var names that are known to be safe to expose.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      publicPrefixSecret:
        '`{{name}}` uses the `{{prefix}}` prefix, so its value is inlined into client JavaScript that anyone can read. Remove the prefix, read the secret only in server code (API route, server action, edge function), and rotate it if it was ever deployed.',
      serverSecretInClient:
        '`process.env.{{name}}` is read in a "use client" file. Server env vars are not sent to the browser, so this is undefined at runtime, and adding NEXT_PUBLIC_ to fix that would leak the secret. Use it in a server action or API route and call that from the client.',
      browserLlmClient:
        '`dangerouslyAllowBrowser: true` with an app-owned API key ships that key to every visitor. Call the model from a server route and stream the result to the client. This is only safe when each user supplies their own key.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const allowed = new Set(options.allow ?? []);
    const isClientFile = hasUseClientDirective(context.sourceCode.ast);
    function isPublicPrefixSecret(name: string): boolean {
      if (allowed.has(name)) return false;
      const prefix = getPublicPrefix(name);
      return prefix !== null && isBrowserForbiddenName(name.slice(prefix.length));
    }

    function checkEnvName(name: string, node: TSESTree.Node, viaProcessEnv: boolean): void {
      if (allowed.has(name)) return;

      const prefix = getPublicPrefix(name);
      if (prefix) {
        if (isPublicPrefixSecret(name)) {
          context.report({ node, messageId: 'publicPrefixSecret', data: { name, prefix } });
        }
        return;
      }

      if (
        isClientFile &&
        viaProcessEnv &&
        (isBrowserForbiddenName(name) || isGenericSecretEnvName(name))
      ) {
        context.report({ node, messageId: 'serverSecretInClient', data: { name } });
      }
    }

    return {
      MemberExpression(node): void {
        const access = getEnvAccess(node);
        if (!access) return;
        checkEnvName(access.name, node, access.source === 'process.env');
      },

      // const { NEXT_PUBLIC_OPENAI_API_KEY } = process.env;
      VariableDeclarator(node): void {
        if (!node.init || node.id.type !== AST_NODE_TYPES.ObjectPattern) return;
        const viaProcessEnv = isProcessEnv(node.init);
        if (!viaProcessEnv && !isImportMetaEnv(node.init)) return;

        for (const property of node.id.properties) {
          if (property.type !== AST_NODE_TYPES.Property) continue;
          const name = getPropertyKeyName(property);
          if (name) checkEnvName(name, property.key, viaProcessEnv);
        }
      },

      'Property[key.name="dangerouslyAllowBrowser"]'(node: TSESTree.Property): void {
        if (node.value.type !== AST_NODE_TYPES.Literal || node.value.value !== true) return;
        const options = node.parent;
        if (options.type !== AST_NODE_TYPES.ObjectExpression) return;
        const call = options.parent;
        if (
          call.type !== AST_NODE_TYPES.NewExpression &&
          call.type !== AST_NODE_TYPES.CallExpression
        ) {
          return;
        }

        const apiKey = findProperty(options, 'apiKey');
        if (apiKey) {
          const value = apiKey.value;
          const access = getEnvAccess(value);
          const isAppOwnedKey =
            access !== null ||
            (value.type === AST_NODE_TYPES.Literal && typeof value.value === 'string') ||
            (value.type === AST_NODE_TYPES.TemplateLiteral && value.expressions.length === 0);
          // Anything else (a variable, function call, user input) is treated as a
          // user-supplied key, which is the one legitimate use of this option.
          if (!isAppOwnedKey) return;
          // The key itself is reported as a public-prefix leak; one report is enough.
          if (access && isPublicPrefixSecret(access.name)) return;
        }

        context.report({ node, messageId: 'browserLlmClient' });
      },
    };
  },
});

export default noClientExposedSecret;
