import { ESLintUtils, AST_NODE_TYPES, ASTUtils } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import { isTestFile } from '../../utils/file-context';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

type Verdict =
  | { safe: true }
  | { safe: false; source?: string; markdown?: boolean; json?: boolean };

const SAFE: Verdict = { safe: true };
const UNSAFE: Verdict = { safe: false };

const MAX_DEPTH = 6;

/** Function names that sanitize or escape HTML. */
const SANITIZER_NAME =
  /^(?:sanitize\w*|purify|xss|filterXSS|insane|escape\w*|htmlEscape|encode\w*|createHTML|stripTags|strip_tags|toSafeHtml|safeHtml)$/i;
const SANITIZER_OBJECT = /^(?:DOMPurify|purify|sanitizer|xss|he|validator)$/i;

/** Variable names that state the value was already made safe. */
const SAFE_VARIABLE_NAME = /(?:sanitiz|purif|escaped|^safe|Safe[A-Z]|^clean|Clean[A-Z]|^trusted|Trusted[A-Z])/;

/** Calls that always produce numbers, booleans or date text, never markup. */
const NON_MARKUP_METHODS = new Set([
  'toFixed', 'toPrecision', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
  'toISOString', 'toDateString', 'toTimeString', 'toUTCString', 'getTime', 'indexOf', 'includes',
]);
const NON_MARKUP_FUNCTIONS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean', 'isNaN']);

/** Methods that keep the markup of their receiver. */
const PASSTHROUGH_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'concat', 'slice', 'substring', 'padStart', 'padEnd']);

/** Translation helpers return authored strings. */
const TRANSLATION_FUNCTIONS = new Set(['t', '$t', 'translate', 'formatMessage', 'i18n']);

/**
 * Renderers that escape their input: react-dom/server, KaTeX, Vue's server renderer.
 * Raw HTML inside a React tree is reported separately at its dangerouslySetInnerHTML.
 */
const ESCAPING_RENDERERS = new Set(['renderToString', 'renderToStaticMarkup']);

const MARKDOWN_FUNCTIONS = new Set(['marked', 'micromark', 'snarkdown', 'markdownToHtml', 'mdToHtml']);
const MARKDOWN_RENDERER_OBJECT = /^(?:md|markdown|markdownIt|mdit|mdParser|parser|renderer|converter|marked)$/i;

const UNTRUSTED_MEMBER_SOURCES: Array<[RegExp, string]> = [
  [/^(?:window\.)?(?:document\.)?location(?:\.|$)/, 'the page URL'],
  [/^document\.(?:URL|documentURI|referrer|baseURI)$/, 'the page URL'],
  [/^document\.cookie$/, 'cookie data'],
  [/^window\.name$/, 'window.name'],
  [/^(?:req|request|ctx|ctx\.request|event)\.(?:query|body|params|headers|cookies)(?:\.|$)/, 'request input'],
  [/^(?:event|e|evt|ev)\.data$/, 'postMessage data'],
];

function memberChain(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (node.type === AST_NODE_TYPES.ThisExpression) return 'this';
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    const object = memberChain(node.object);
    if (object === null) return null;
    if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) return `${object}.${node.property.name}`;
    if (node.property.type === AST_NODE_TYPES.Literal) return `${object}[]`;
    return `${object}[]`;
  }
  if (node.type === AST_NODE_TYPES.TSNonNullExpression) return memberChain(node.expression);
  return null;
}

function getRootIdentifier(node: TSESTree.Node): TSESTree.Identifier | null {
  let current: TSESTree.Node = node;
  while (current.type === AST_NODE_TYPES.MemberExpression || current.type === AST_NODE_TYPES.TSNonNullExpression) {
    current = current.type === AST_NODE_TYPES.MemberExpression ? current.object : current.expression;
  }
  return current.type === AST_NODE_TYPES.Identifier ? current : null;
}

/** OpenAI `choices[0].message.content` / `choices[0].delta.content`, Anthropic `content[0].text`. */
function isLlmResponseChain(chain: string): boolean {
  return /\.choices\[\]\.(?:message|delta)\.content$/.test(chain) || /\.content\[\]\.text$/.test(chain) || /^choices\[\]\.(?:message|delta)\.content$/.test(chain);
}

/** Vercel AI SDK entry points. Generic names like `chat()` are left out on purpose. */
const LLM_CALLS = new Set(['generateText', 'streamText', 'generateObject']);

function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  if (callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed && callee.property.type === AST_NODE_TYPES.Identifier) {
    return callee.property.name;
  }
  return null;
}

function calleeObjectName(callee: TSESTree.Node): string | null {
  if (callee.type !== AST_NODE_TYPES.MemberExpression) return null;
  const chain = memberChain(callee.object);
  if (!chain) return null;
  const parts = chain.split('.');
  return parts[parts.length - 1] ?? null;
}

function isLlmCall(node: TSESTree.Node): boolean {
  let current = node;
  if (current.type === AST_NODE_TYPES.AwaitExpression) current = current.argument;
  if (current.type !== AST_NODE_TYPES.CallExpression) return false;
  const chain = memberChain(current.callee) ?? '';
  return (
    (current.callee.type === AST_NODE_TYPES.Identifier && LLM_CALLS.has(current.callee.name)) ||
    /\.(?:chat\.)?completions\.create$/.test(chain) ||
    /\.messages\.create$/.test(chain) ||
    /\.responses\.create$/.test(chain)
  );
}

class HtmlEvaluator {
  private readonly visiting = new Set<TSESTree.Node>();

  constructor(private readonly sourceCode: Readonly<TSESLint.SourceCode>) {}

  evaluate(node: TSESTree.Node | null | undefined, depth = 0): Verdict {
    if (!node) return SAFE;
    if (depth > MAX_DEPTH || this.visiting.has(node)) return UNSAFE;
    this.visiting.add(node);
    try {
      return this.evaluateNode(node, depth);
    } finally {
      this.visiting.delete(node);
    }
  }

  private all(nodes: Array<TSESTree.Node | null>, depth: number): Verdict {
    for (const n of nodes) {
      const verdict = this.evaluate(n, depth);
      if (!verdict.safe) return verdict;
    }
    return SAFE;
  }

  private evaluateNode(node: TSESTree.Node, depth: number): Verdict {
    switch (node.type) {
      case AST_NODE_TYPES.Literal:
        return SAFE;
      case AST_NODE_TYPES.TemplateLiteral:
        return this.all(node.expressions, depth + 1);
      case AST_NODE_TYPES.TaggedTemplateExpression: {
        const tag = calleeName(node.tag) ?? '';
        if (SANITIZER_NAME.test(tag) || /safe|sanitiz|escape/i.test(tag)) return SAFE;
        return this.all(node.quasi.expressions, depth + 1);
      }
      case AST_NODE_TYPES.BinaryExpression:
        if (node.operator !== '+') return SAFE; // arithmetic and comparisons yield numbers/booleans
        return this.all([node.left, node.right], depth + 1);
      case AST_NODE_TYPES.LogicalExpression:
        return this.all([node.left, node.right], depth + 1);
      case AST_NODE_TYPES.ConditionalExpression:
        return this.all([node.consequent, node.alternate], depth + 1);
      case AST_NODE_TYPES.UnaryExpression:
      case AST_NODE_TYPES.UpdateExpression:
        return SAFE;
      case AST_NODE_TYPES.ArrayExpression:
        return this.all(node.elements.map((e) => (e && e.type === AST_NODE_TYPES.SpreadElement ? e.argument : e)), depth + 1);
      case AST_NODE_TYPES.AwaitExpression:
        return this.evaluate(node.argument, depth + 1);
      case AST_NODE_TYPES.TSAsExpression:
      case AST_NODE_TYPES.TSNonNullExpression:
      case AST_NODE_TYPES.TSSatisfiesExpression:
        return this.evaluate(node.expression, depth);
      case AST_NODE_TYPES.Identifier:
        return this.evaluateIdentifier(node, depth);
      case AST_NODE_TYPES.MemberExpression:
        return this.evaluateMember(node, depth);
      case AST_NODE_TYPES.CallExpression:
        return this.evaluateCall(node, depth);
      default:
        return UNSAFE;
    }
  }

  private evaluateIdentifier(node: TSESTree.Identifier, depth: number): Verdict {
    if (node.name === 'undefined') return SAFE;
    if (SAFE_VARIABLE_NAME.test(node.name)) return SAFE;
    if (/^[A-Z][A-Z0-9_]*$/.test(node.name) && node.name.length > 1) return SAFE; // module constant convention

    const variable = ASTUtils.findVariable(this.sourceCode.getScope(node), node);
    const def = variable?.defs[0];
    if (!variable || !def) return UNSAFE;

    if (def.type === 'ImportBinding') return SAFE; // bundled module code, not runtime input
    if (def.type === 'FunctionName' || def.type === 'ClassName') return SAFE;
    if (def.type !== 'Variable') return UNSAFE; // parameters and catch bindings are external input

    const declarator = def.node as TSESTree.VariableDeclarator;
    if (declarator.id.type !== AST_NODE_TYPES.Identifier) {
      // const { text } = await generateText(...)
      if (declarator.init && isLlmCall(declarator.init)) return { safe: false, source: 'an LLM response' };
      return this.evaluateDestructured(declarator, depth);
    }

    // Every value ever written to the variable: the initialiser plus later
    // assignments such as `html += '<li>' + item + '</li>'`.
    const writes: TSESTree.Node[] = [];
    for (const ref of variable.references) {
      if (!ref.isWrite() || !ref.writeExpr) continue;
      writes.push(ref.writeExpr as TSESTree.Node);
    }
    if (writes.length === 0) return declarator.init ? this.evaluate(declarator.init, depth + 1) : SAFE;
    return this.all(writes, depth + 1);
  }

  /** `const { html } = props` is external; `const { a } = CONSTANTS` follows the source. */
  private evaluateDestructured(declarator: TSESTree.VariableDeclarator, depth: number): Verdict {
    if (!declarator.init) return UNSAFE;
    const root = getRootIdentifier(declarator.init);
    if (root && (/^[A-Z][A-Z0-9_]*$/.test(root.name))) return SAFE;
    if (declarator.init.type === AST_NODE_TYPES.ObjectExpression) return this.evaluateObject(declarator.init, depth);
    return this.evaluateSourceOnly(declarator.init);
  }

  private evaluateObject(object: TSESTree.ObjectExpression, depth: number): Verdict {
    for (const property of object.properties) {
      if (property.type !== AST_NODE_TYPES.Property) return UNSAFE;
      const verdict = this.evaluate(property.value, depth + 1);
      if (!verdict.safe) return verdict;
    }
    return SAFE;
  }

  /** For values we cannot follow, still name a known untrusted origin when there is one. */
  private evaluateSourceOnly(node: TSESTree.Node): Verdict {
    const chain = memberChain(node);
    if (chain) {
      for (const [pattern, source] of UNTRUSTED_MEMBER_SOURCES) {
        if (pattern.test(chain)) return { safe: false, source };
      }
    }
    return UNSAFE;
  }

  private evaluateMember(node: TSESTree.MemberExpression, depth: number): Verdict {
    const chain = memberChain(node);
    if (chain) {
      if (isLlmResponseChain(chain)) return { safe: false, source: 'an LLM response' };
      for (const [pattern, source] of UNTRUSTED_MEMBER_SOURCES) {
        if (pattern.test(chain)) return { safe: false, source };
      }
    }

    const property = !node.computed && node.property.type === AST_NODE_TYPES.Identifier ? node.property.name : null;
    if (property === 'innerHTML' || property === 'outerHTML') return SAFE; // already-parsed DOM markup
    if (property === 'length' || property === 'size') return SAFE;

    const root = getRootIdentifier(node);
    if (!root) return UNSAFE;
    if (/^[A-Z][A-Z0-9_]*$/.test(root.name) && root.name.length > 1) return SAFE;

    const variable = ASTUtils.findVariable(this.sourceCode.getScope(root), root);
    const def = variable?.defs[0];
    if (def?.type === 'ImportBinding') return SAFE; // e.g. icons.check from a bundled module
    if (def?.type === 'Variable') {
      const declarator = def.node as TSESTree.VariableDeclarator;
      const isConst = (declarator.parent as TSESTree.VariableDeclaration).kind === 'const';
      const init = declarator.init;
      if (isConst && declarator.id.type === AST_NODE_TYPES.Identifier && init) {
        // A const lookup table of static markup: const ICONS = { ok: '<svg>' }
        if (init.type === AST_NODE_TYPES.ObjectExpression) return this.evaluateObject(init, depth);
        if (init.type === AST_NODE_TYPES.ArrayExpression) return this.evaluate(init, depth + 1);
      }
    }
    return UNSAFE;
  }

  private evaluateCall(node: TSESTree.CallExpression, depth: number): Verdict {
    const callee = node.callee;
    const name = calleeName(callee);
    const objectName = calleeObjectName(callee);
    const chain = memberChain(callee) ?? '';

    if (name && (SANITIZER_NAME.test(name) || (objectName && SANITIZER_OBJECT.test(objectName)))) return SAFE;
    if (name && TRANSLATION_FUNCTIONS.has(name)) return SAFE;
    if (name && ESCAPING_RENDERERS.has(name)) return SAFE;
    // JSON.stringify leaves `<` alone, so `</script>` in the data closes the tag
    if (chain === 'JSON.stringify') return { safe: false, json: true };
    if (name && NON_MARKUP_METHODS.has(name) && callee.type === AST_NODE_TYPES.MemberExpression) return SAFE;
    if (callee.type === AST_NODE_TYPES.Identifier && NON_MARKUP_FUNCTIONS.has(callee.name)) return SAFE;
    if (objectName === 'Math') return SAFE;

    // Markdown renderers emit raw HTML from their input
    if (
      (callee.type === AST_NODE_TYPES.Identifier && MARKDOWN_FUNCTIONS.has(callee.name)) ||
      name === 'makeHtml' ||
      ((name === 'render' || name === 'parse' || name === 'renderInline') && objectName !== null && MARKDOWN_RENDERER_OBJECT.test(objectName))
    ) {
      return { safe: false, markdown: true };
    }

    // Untrusted origins returned by calls
    if (name === 'get' && callee.type === AST_NODE_TYPES.MemberExpression) {
      const receiver = callee.object;
      const isNewSearchParams =
        receiver.type === AST_NODE_TYPES.NewExpression &&
        receiver.callee.type === AST_NODE_TYPES.Identifier &&
        receiver.callee.name === 'URLSearchParams';
      if (isNewSearchParams || (objectName !== null && /searchparams|params|query/i.test(objectName))) {
        return { safe: false, source: 'a URL query parameter' };
      }
    }
    if (name === 'getItem' && /(?:local|session)Storage$/.test(objectName ?? '')) return { safe: false, source: 'browser storage' };
    if (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'prompt') return { safe: false, source: 'user input' };

    if (callee.type === AST_NODE_TYPES.MemberExpression) {
      // String(x), x.trim(), x.toUpperCase(): same markup as the receiver
      if (name && PASSTHROUGH_METHODS.has(name)) {
        return this.all([callee.object, ...node.arguments], depth + 1);
      }
      // Manual escaping: s.replace(/</g, '&lt;')
      if ((name === 'replace' || name === 'replaceAll') && isEscapingReplace(node)) return SAFE;
      if (name === 'replace' || name === 'replaceAll') return this.evaluate(callee.object, depth + 1);

      // items.map(i => `<li>${i}</li>`).join('')
      if (name === 'join') return this.evaluateJoin(callee.object, depth);
    }

    if (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'String') {
      return this.all(node.arguments, depth + 1);
    }
    if (/\.(?:chat\.)?completions\.create$|\.messages\.create$/.test(chain)) return { safe: false, source: 'an LLM response' };

    // Local helper functions: follow what they return
    if (callee.type === AST_NODE_TYPES.Identifier) {
      const fn = this.resolveLocalFunction(callee);
      if (fn) return this.evaluateFunctionReturns(fn, depth);
    }
    return UNSAFE;
  }

  private evaluateJoin(receiver: TSESTree.Node, depth: number): Verdict {
    if (receiver.type === AST_NODE_TYPES.CallExpression && calleeName(receiver.callee) === 'map') {
      const cb = receiver.arguments[0];
      if (cb && (cb.type === AST_NODE_TYPES.ArrowFunctionExpression || cb.type === AST_NODE_TYPES.FunctionExpression)) {
        return this.evaluateFunctionReturns(cb, depth);
      }
      if (cb && cb.type === AST_NODE_TYPES.Identifier) {
        const fn = this.resolveLocalFunction(cb);
        if (fn) return this.evaluateFunctionReturns(fn, depth);
      }
      return UNSAFE;
    }
    return this.evaluate(receiver, depth + 1);
  }

  private resolveLocalFunction(id: TSESTree.Identifier): TSESTree.FunctionLike | null {
    const variable = ASTUtils.findVariable(this.sourceCode.getScope(id), id);
    const def = variable?.defs[0];
    if (!def) return null;
    if (def.type === 'FunctionName' && def.node.type === AST_NODE_TYPES.FunctionDeclaration) return def.node;
    if (def.type === 'Variable') {
      const init = (def.node as TSESTree.VariableDeclarator).init;
      if (init && (init.type === AST_NODE_TYPES.ArrowFunctionExpression || init.type === AST_NODE_TYPES.FunctionExpression)) {
        return init;
      }
    }
    return null;
  }

  private evaluateFunctionReturns(fn: TSESTree.FunctionLike, depth: number): Verdict {
    if (fn.type === AST_NODE_TYPES.ArrowFunctionExpression && fn.body.type !== AST_NODE_TYPES.BlockStatement) {
      return this.evaluate(fn.body, depth + 1);
    }
    if (!('body' in fn) || !fn.body || fn.body.type !== AST_NODE_TYPES.BlockStatement) return UNSAFE;
    const returns: TSESTree.Node[] = [];
    collectReturns(fn.body, returns);
    return this.all(returns, depth + 1);
  }
}

function collectReturns(node: TSESTree.Node, out: TSESTree.Node[]): void {
  if (node.type === AST_NODE_TYPES.ReturnStatement) {
    if (node.argument) out.push(node.argument);
    return;
  }
  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object' && 'type' in item) collectReturns(item as TSESTree.Node, out);
    } else if (value && typeof value === 'object' && 'type' in value) {
      collectReturns(value as TSESTree.Node, out);
    }
  }
}

/** `s.replace(/</g, '&lt;')` and friends: the author escaped by hand. */
function isEscapingReplace(call: TSESTree.CallExpression): boolean {
  const [pattern, replacement] = call.arguments;
  if (!pattern || !replacement) return false;
  const patternText =
    pattern.type === AST_NODE_TYPES.Literal && 'regex' in pattern && pattern.regex
      ? pattern.regex.pattern
      : pattern.type === AST_NODE_TYPES.Literal && typeof pattern.value === 'string'
        ? pattern.value
        : '';
  if (!/[<&]/.test(patternText)) return false;
  if (replacement.type === AST_NODE_TYPES.Literal && typeof replacement.value === 'string') {
    // '&lt;' entities, or the '\\u003c' escape Next.js recommends for JSON-LD
    return !replacement.value.includes('<');
  }
  // .replace(/[&<>"']/g, (c) => map[c])
  return replacement.type === AST_NODE_TYPES.ArrowFunctionExpression || replacement.type === AST_NODE_TYPES.FunctionExpression;
}

function getHtmlProperty(object: TSESTree.ObjectExpression): TSESTree.Node | null {
  for (const property of object.properties) {
    if (
      property.type === AST_NODE_TYPES.Property &&
      ((property.key.type === AST_NODE_TYPES.Identifier && property.key.name === '__html') ||
        (property.key.type === AST_NODE_TYPES.Literal && property.key.value === '__html'))
    ) {
      return property.value;
    }
  }
  return null;
}

type MessageIds = 'unsanitizedHtml' | 'untrustedHtml' | 'markdownHtml' | 'jsonHtml';

export const noUnsanitizedHtml = createRule<[], MessageIds>({
  name: 'no-unsanitized-html',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow dynamic, unsanitized values in HTML sinks: innerHTML, outerHTML, insertAdjacentHTML, document.write and React dangerouslySetInnerHTML. XSS is the vulnerability class AI models get wrong most often. Literals, local constants, sanitizer output (DOMPurify.sanitize) and numeric values are allowed, so the rule stays quiet on safe code.',
    },
    schema: [],
    messages: {
      unsanitizedHtml:
        '`{{sink}}` receives a dynamic value that is not sanitized. If any part comes from users, URLs, an API or a model response, this is an XSS hole. Sanitize it with `DOMPurify.sanitize()`, or use `textContent` / JSX text so the browser never parses it as HTML.',
      untrustedHtml:
        '`{{sink}}` receives {{source}}, which an attacker can control. This is a direct XSS vector. Use `textContent` or JSX text, or sanitize with `DOMPurify.sanitize()` first.',
      jsonHtml:
        "`{{sink}}` receives `JSON.stringify()` output, which does not escape `<`. A value containing `</script><script>...` closes the tag and runs as script (common with JSON-LD). Escape it: `JSON.stringify(data).replace(/</g, '\\\\u003c')`.",
      markdownHtml:
        '`{{sink}}` receives markdown rendered to HTML without sanitizing. Markdown renderers pass raw HTML through, so `<img src=x onerror=...>` in the content runs as script. Sanitize the rendered HTML with `DOMPurify.sanitize()`.',
    },
  },
  defaultOptions: [],
  create(context) {
    if (isTestFile(context.physicalFilename || context.filename)) return {};
    const evaluator = new HtmlEvaluator(context.sourceCode);

    function check(sink: string, value: TSESTree.Node, reportNode: TSESTree.Node): void {
      const verdict = evaluator.evaluate(value);
      if (verdict.safe) return;
      if (verdict.json) {
        context.report({ node: reportNode, messageId: 'jsonHtml', data: { sink } });
      } else if (verdict.markdown) {
        context.report({ node: reportNode, messageId: 'markdownHtml', data: { sink } });
      } else if (verdict.source) {
        context.report({ node: reportNode, messageId: 'untrustedHtml', data: { sink, source: verdict.source } });
      } else {
        context.report({ node: reportNode, messageId: 'unsanitizedHtml', data: { sink } });
      }
    }

    function checkHtmlObject(value: TSESTree.Node, reportNode: TSESTree.Node): void {
      let object: TSESTree.Node = value;
      if (object.type === AST_NODE_TYPES.Identifier) {
        const variable = ASTUtils.findVariable(context.sourceCode.getScope(object), object);
        const init = variable?.defs[0]?.type === 'Variable' ? (variable.defs[0].node as TSESTree.VariableDeclarator).init : null;
        if (init) object = init;
      }
      if (object.type === AST_NODE_TYPES.ObjectExpression) {
        const html = getHtmlProperty(object);
        if (html) check('dangerouslySetInnerHTML', html, reportNode);
        return;
      }
      // { __html } built by a helper such as createMarkup(): follow it.
      check('dangerouslySetInnerHTML', object, reportNode);
    }

    return {
      AssignmentExpression(node): void {
        if (node.operator !== '=' && node.operator !== '+=') return;
        if (node.left.type !== AST_NODE_TYPES.MemberExpression) return;
        const property = !node.left.computed && node.left.property.type === AST_NODE_TYPES.Identifier ? node.left.property.name : null;
        if (property !== 'innerHTML' && property !== 'outerHTML') return;
        check(property, node.right, node);
      },

      CallExpression(node): void {
        const name = calleeName(node.callee);
        if (name === 'insertAdjacentHTML' && node.callee.type === AST_NODE_TYPES.MemberExpression && node.arguments[1]) {
          check('insertAdjacentHTML', node.arguments[1], node);
          return;
        }
        if ((name === 'write' || name === 'writeln') && node.callee.type === AST_NODE_TYPES.MemberExpression) {
          const objectChain = memberChain(node.callee.object);
          if (objectChain === 'document' || objectChain === 'window.document') {
            for (const arg of node.arguments) check(`document.${name}`, arg, node);
          }
        }
      },

      JSXAttribute(node): void {
        if (node.name.type !== AST_NODE_TYPES.JSXIdentifier || node.name.name !== 'dangerouslySetInnerHTML') return;
        if (!node.value || node.value.type !== AST_NODE_TYPES.JSXExpressionContainer) return;
        if (node.value.expression.type === AST_NODE_TYPES.JSXEmptyExpression) return;
        const expression = node.value.expression;
        if (expression.type === AST_NODE_TYPES.CallExpression) {
          // dangerouslySetInnerHTML={createMarkup()} — the React docs pattern
          const fnName = expression.callee.type === AST_NODE_TYPES.Identifier ? expression.callee : null;
          if (fnName) {
            const variable = ASTUtils.findVariable(context.sourceCode.getScope(fnName), fnName);
            const def = variable?.defs[0];
            const fn = def?.type === 'FunctionName' ? def.node : def?.type === 'Variable' ? (def.node as TSESTree.VariableDeclarator).init : null;
            if (fn && (fn.type === AST_NODE_TYPES.FunctionDeclaration || fn.type === AST_NODE_TYPES.ArrowFunctionExpression || fn.type === AST_NODE_TYPES.FunctionExpression)) {
              const returns: TSESTree.Node[] = [];
              if (fn.body.type === AST_NODE_TYPES.BlockStatement) collectReturns(fn.body, returns);
              else returns.push(fn.body);
              for (const returned of returns) checkHtmlObject(returned, node);
              return;
            }
          }
        }
        checkHtmlObject(expression, node);
      },

      // React.createElement('div', { dangerouslySetInnerHTML: { __html: x } })
      'CallExpression > ObjectExpression > Property[key.name="dangerouslySetInnerHTML"]'(node: TSESTree.Property): void {
        checkHtmlObject(node.value, node);
      },
    };
  },
});

export default noUnsanitizedHtml;
