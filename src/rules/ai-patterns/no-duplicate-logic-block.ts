import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

function normalizeStatementText(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

function isLikelyMeaningfulStatement(node: TSESTree.Statement, sourceCodeText: string): boolean {
  if (
    node.type === AST_NODE_TYPES.EmptyStatement ||
    node.type === AST_NODE_TYPES.BreakStatement ||
    node.type === AST_NODE_TYPES.ContinueStatement
  ) {
    return false;
  }

  return sourceCodeText.length >= 30;
}

export const noDuplicateLogicBlock = createRule({
  name: 'no-duplicate-logic-block',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow consecutive duplicated logic statements. AI tools often copy-paste the same logic block with minimal or no changes, which should usually be extracted or consolidated.',
    },
    fixable: undefined,
    schema: [],
    messages: {
      duplicateLogic:
        'Duplicate consecutive logic block detected. AI-generated code often repeats the same block. Consider extracting shared logic into a function or removing duplication.',
    },
  },
  defaultOptions: [],
  create(context) {
    const checkStatementList = (statements: TSESTree.Statement[]): void => {
      if (statements.length < 2) {
        return;
      }

      for (let i = 0; i < statements.length - 1; i += 1) {
        const current = statements[i];
        const next = statements[i + 1];

        const currentTextRaw = context.sourceCode.getText(current);
        const nextTextRaw = context.sourceCode.getText(next);

        if (!isLikelyMeaningfulStatement(current, currentTextRaw)) {
          continue;
        }

        if (!isLikelyMeaningfulStatement(next, nextTextRaw)) {
          continue;
        }

        const currentText = normalizeStatementText(currentTextRaw);
        const nextText = normalizeStatementText(nextTextRaw);

        if (currentText === nextText) {
          context.report({
            node: next,
            messageId: 'duplicateLogic',
          });
        }
      }
    };

    return {
      Program(node) {
        checkStatementList(node.body);
      },

      BlockStatement(node) {
        checkStatementList(node.body);
      },
    };
  },
});

export default noDuplicateLogicBlock;
