import { ESLintUtils } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/YashJadhav21/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

export const noEmptyCatch = createRule({
  name: 'no-empty-catch',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow empty catch blocks. AI tools frequently generate try/catch with empty catch bodies that silently swallow errors, hiding failures in production. Includes a safe autofix that inserts an explicit placeholder comment.',
    },
    fixable: 'code',
    hasSuggestions: true,
    schema: [],
    messages: {
      emptyCatch:
        'Catch block is empty. AI tools frequently generate empty catch blocks that silently swallow errors. Handle the error (log, rethrow, or recover), or add a comment explaining why it is intentionally empty.',
      addTodoHandler:
        'Add a minimal placeholder so this catch block is not silently swallowing errors.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node) {
        // Flag catch clauses where the body block has zero statements
        if (node.body.body.length === 0) {
          // Check if there is a comment inside the catch block — if so, the developer
          // intentionally left it empty with a reason, so we don't flag it.
          const sourceCode = context.sourceCode;
          const comments = sourceCode.getCommentsInside(node.body);
          if (comments.length > 0) {
            return;
          }

          context.report({
            node,
            messageId: 'emptyCatch',
            fix: (fixer) => fixer.replaceText(node.body, '{ /* TODO: handle error */ }'),
            suggest: [
              {
                messageId: 'addTodoHandler',
                fix: (fixer) => fixer.replaceText(node.body, '{ /* TODO: handle error */ }'),
              },
            ],
          });
        }
      },
    };
  },
});

export default noEmptyCatch;
