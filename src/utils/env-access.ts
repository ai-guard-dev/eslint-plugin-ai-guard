/**
 * Helpers for recognising environment-variable reads in source code.
 *
 * Shared by rules that reason about configuration secrets
 * (no-client-exposed-secret, no-silent-fallback).
 */
import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

export type EnvSource = 'process.env' | 'import.meta.env';

export interface EnvAccess {
  name: string;
  source: EnvSource;
}

/** True for `process.env` itself. */
export function isProcessEnv(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    node.object.type === AST_NODE_TYPES.Identifier &&
    node.object.name === 'process' &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === 'env'
  );
}

/** True for `import.meta.env` itself. */
export function isImportMetaEnv(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    node.object.type === AST_NODE_TYPES.MetaProperty &&
    node.object.meta.name === 'import' &&
    node.object.property.name === 'meta' &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === 'env'
  );
}

/** Name of a member property when it is statically known (`a.b` or `a['b']`). */
export function getStaticPropertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.TemplateLiteral &&
    node.property.expressions.length === 0
  ) {
    return node.property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * Returns the env var read by `node`, for `process.env.X`, `process.env['X']`
 * and `import.meta.env.X`. TS non-null assertions (`process.env.X!`) are unwrapped.
 */
export function getEnvAccess(node: TSESTree.Node): EnvAccess | null {
  let current: TSESTree.Node = node;
  while (current.type === AST_NODE_TYPES.TSNonNullExpression) {
    current = current.expression;
  }
  if (current.type !== AST_NODE_TYPES.MemberExpression) return null;

  const name = getStaticPropertyName(current);
  if (!name) return null;

  if (isProcessEnv(current.object)) return { name, source: 'process.env' };
  if (isImportMetaEnv(current.object)) return { name, source: 'import.meta.env' };
  return null;
}

/**
 * Env-var name segments that describe a property *of* a secret rather than the
 * secret itself: `JWT_SECRET_EXPIRES_IN`, `API_KEY_HEADER`, `SECRET_FILE`.
 */
const NON_SECRET_TRAILING_SEGMENTS = new Set([
  'EXPIRY', 'EXPIRES', 'EXPIRE', 'EXPIRATION', 'IN', 'TTL', 'TIMEOUT', 'LIFETIME',
  'DURATION', 'AGE', 'LENGTH', 'LEN', 'SIZE', 'ALGORITHM', 'ALGO', 'ALG', 'ISSUER',
  'AUDIENCE', 'HEADER', 'NAME', 'URL', 'URI', 'ENDPOINT', 'HOST', 'PORT', 'PATH',
  'FILE', 'DIR', 'ROUNDS', 'PREFIX', 'TYPE', 'ID', 'REGION', 'VERSION', 'ENABLED',
  'MODE', 'FIELD', 'PARAM', 'COOKIE', 'COUNT', 'LIMIT', 'STRATEGY', 'PROVIDER',
]);

/**
 * Words that mark a credential as intentionally public. A Stripe *publishable*
 * key, a Supabase *anon* key or a reCAPTCHA *site* key is meant for the browser.
 */
const PUBLIC_CREDENTIAL_SEGMENTS = new Set(['PUBLISHABLE', 'PUBLIC', 'ANON']);

export function splitEnvName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** True when the last segment of the name describes metadata, not a secret value. */
export function hasNonSecretTrailingSegment(segments: string[]): boolean {
  const last = segments[segments.length - 1];
  return last !== undefined && NON_SECRET_TRAILING_SEGMENTS.has(last);
}

export function hasPublicCredentialMarker(segments: string[]): boolean {
  const joined = segments.join('_');
  return segments.some((s) => PUBLIC_CREDENTIAL_SEGMENTS.has(s)) || joined.includes('SITE_KEY');
}

/**
 * Generic "this holds a secret" test for env names, used where any credential
 * is in scope (e.g. hardcoded fallbacks). Not for browser-exposure checks, where
 * many `*_API_KEY` / `*_TOKEN` values are legitimately public.
 */
export function isGenericSecretEnvName(name: string): boolean {
  const segments = splitEnvName(name);
  if (segments.length === 0) return false;
  if (hasNonSecretTrailingSegment(segments)) return false;
  if (hasPublicCredentialMarker(segments)) return false;
  const joined = `_${segments.join('_')}_`;
  return (
    /_(SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|PWD|CREDENTIALS?|SALT|PEPPER)_/.test(joined) ||
    /_(PRIVATE|SIGNING|ENCRYPTION|SESSION|MASTER|ADMIN|SERVICE|API|ACCESS|SECRET)_KEY_/.test(joined) ||
    /_APIKEY_/.test(joined) ||
    /_(AUTH|ACCESS|REFRESH|BEARER|BOT|ADMIN|API|SERVICE|PERSONAL)_TOKEN_/.test(joined) ||
    /^_(TOKEN|SECRET|PASSWORD|APIKEY)_$/.test(joined) ||
    /_(GITHUB|GH|GITLAB|NPM|SLACK|DISCORD|TELEGRAM|SENTRY|VERCEL|NETLIFY|CLOUDFLARE|HF|HUGGINGFACE)_TOKEN_/.test(joined)
  );
}
