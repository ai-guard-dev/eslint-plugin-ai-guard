import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree, TSESLint } from '@typescript-eslint/utils';
import {
  findRuns,
  describeChars,
  decodeTags,
  decodeVariationSelectors,
  hasInvisibleCandidates,
} from '../../utils/invisible-unicode';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

type Location = 'comment' | 'string' | 'template' | 'regex' | 'jsx' | 'code' | 'whitespace';

const LOCATION_TEXT: Record<Location, string> = {
  comment: 'a comment',
  string: 'a string literal',
  template: 'a template literal',
  regex: 'a regular expression',
  jsx: 'JSX text',
  code: 'code (an identifier or keyword)',
  whitespace: 'whitespace between tokens',
};

interface Span {
  start: number;
  end: number;
  type: string;
}

function buildSpans(sourceCode: Readonly<TSESLint.SourceCode>): Span[] {
  const tokens = sourceCode.ast.tokens ?? [];
  const comments = sourceCode.ast.comments ?? [];
  const spans: Span[] = [];
  for (const t of tokens) spans.push({ start: t.range[0], end: t.range[1], type: t.type });
  for (const c of comments) spans.push({ start: c.range[0], end: c.range[1], type: 'Comment' });
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function findSpan(spans: Span[], index: number): Span | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (index < span.start) hi = mid - 1;
    else if (index >= span.end) lo = mid + 1;
    else return span;
  }
  return null;
}

function locate(
  sourceCode: Readonly<TSESLint.SourceCode>,
  spans: Span[],
  index: number,
): { location: Location; node: TSESTree.Node | null } {
  const span = findSpan(spans, index);
  const node = sourceCode.getNodeByRangeIndex(index) as TSESTree.Node | null;
  if (!span) return { location: 'whitespace', node };
  if (span.type === 'Comment') return { location: 'comment', node };
  if (span.type === 'JSXText') return { location: 'jsx', node };
  if (node?.type === AST_NODE_TYPES.Literal && node.parent?.type === AST_NODE_TYPES.JSXAttribute) {
    return { location: 'jsx', node };
  }
  if (span.type === 'String') return { location: 'string', node };
  if (span.type === 'Template') return { location: 'template', node };
  if (span.type === 'RegularExpression') return { location: 'regex', node };
  return { location: 'code', node };
}

function escapeForString(cp: number): string {
  return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function escapeForRegex(cp: number): string {
  if (cp <= 0xffff) return escapeForString(cp);
  const s = String.fromCodePoint(cp);
  return [...Array(s.length).keys()]
    .map((k) => `\\u${s.charCodeAt(k).toString(16).toUpperCase()}`)
    .join('');
}

function isInTaggedTemplate(node: TSESTree.Node | null): boolean {
  let current = node;
  while (current) {
    if (current.type === AST_NODE_TYPES.TemplateLiteral) {
      return current.parent?.type === AST_NODE_TYPES.TaggedTemplateExpression;
    }
    current = current.parent ?? null;
  }
  return false;
}

type MessageIds = 'bidiControl' | 'invisibleCharacter' | 'hiddenText';

export const noInvisibleUnicode = createRule<[], MessageIds>({
  name: 'no-invisible-unicode',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow invisible and bidirectional Unicode characters in source code: Trojan Source bidi overrides, zero-width characters, Hangul-filler identifiers, and Unicode tag characters that hide text. Pasted AI output and poisoned agent rule files carry these characters, which change what code does or what an AI reads without being visible in review.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      bidiControl:
        'Bidirectional control character {{chars}} in {{location}}. It reorders how code is displayed, so reviewers can see different logic from what runs (Trojan Source, CVE-2021-42574). Remove it, or write it as an escape sequence if the text needs it.',
      invisibleCharacter:
        'Invisible character {{chars}} in {{location}}. Zero-width and filler characters make different identifiers or strings look identical. Remove it, or write it as an escape sequence if it is intentional.',
      hiddenText:
        'Invisible Unicode characters in {{location}} encode hidden text: "{{decoded}}". This technique smuggles instructions into code and agent rule files that AI tools read but humans cannot see. Remove them.',
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    const text = sourceCode.text;
    if (!hasInvisibleCandidates(text)) return {};

    return {
      Program(): void {
        const runs = findRuns(text);
        if (runs.length === 0) return;
        const spans = buildSpans(sourceCode);

        for (const run of runs) {
          const { location, node } = locate(sourceCode, spans, run.start);
          const loc = {
            start: sourceCode.getLocFromIndex(run.start),
            end: sourceCode.getLocFromIndex(run.end),
          };

          let fix: TSESLint.ReportFixFunction | undefined;
          if (location === 'comment') {
            fix = (fixer) => fixer.removeRange([run.start, run.end]);
          } else if (location === 'string' || (location === 'template' && !isInTaggedTemplate(node))) {
            fix = (fixer) => fixer.replaceTextRange([run.start, run.end], run.codePoints.map(escapeForString).join(''));
          } else if (location === 'regex') {
            fix = (fixer) => fixer.replaceTextRange([run.start, run.end], run.codePoints.map(escapeForRegex).join(''));
          }

          const locationText = LOCATION_TEXT[location];

          if (run.kind === 'tag' || (run.kind === 'variation' && run.codePoints.length > 1)) {
            const decoded = run.kind === 'tag' ? decodeTags(run.codePoints) : decodeVariationSelectors(run.codePoints);
            context.report({
              loc,
              messageId: 'hiddenText',
              data: { location: locationText, decoded: decoded || describeChars(run.codePoints) },
              fix,
            });
            continue;
          }

          context.report({
            loc,
            messageId: run.kind === 'bidi' ? 'bidiControl' : 'invisibleCharacter',
            data: { chars: describeChars(run.codePoints), location: locationText },
            fix,
          });
        }
      },
    };
  },
});

export default noInvisibleUnicode;
