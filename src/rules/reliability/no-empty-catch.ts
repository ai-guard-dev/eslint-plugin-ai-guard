import { ESLintUtils, type TSESLint, type TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/ai-guard-dev/eslint-plugin-ai-guard/blob/main/docs/rules/${name}.md`
);

/** A comment that only marks missing work ("TODO: handle error") does not explain an empty catch. */
const PLACEHOLDER_COMMENT = /^\s*(?:TODO|FIXME|XXX)\b/i;

export const noEmptyCatch = createRule({
  name: 'no-empty-catch',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow empty catch blocks. AI tools frequently generate try/catch with empty catch bodies that silently swallow errors, hiding failures in production. A comment explaining why the block is empty is accepted; a TODO, FIXME or XXX comment is not. There is no automatic fix, so `--fix` cannot hide the problem; an editor suggestion rethrows the error.',
    },
    hasSuggestions: true,
    schema: [],
    messages: {
      emptyCatch:
        'Catch block is empty. AI tools frequently generate empty catch blocks that silently swallow errors. Handle the error (log, rethrow, or recover), or add a comment explaining why it is intentionally empty.',
      placeholderCatch:
        'Catch block only has a TODO comment, so the error is still swallowed. Handle the error (log, rethrow, or recover), or replace the TODO with a comment explaining why ignoring it is safe.',
      rethrow: 'Rethrow the error.',
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;

    function rethrowFix(node: TSESTree.CatchClause): TSESLint.ReportFixFunction | null {
      if (node.param === null) {
        // `catch {}` has no binding to rethrow; add one.
        return (fixer) => fixer.replaceText(node, 'catch (error) { throw error; }');
      }
      if (node.param.type === 'Identifier') {
        const name = node.param.name;
        return (fixer) => fixer.replaceText(node.body, `{ throw ${name}; }`);
      }
      // A destructured binding has no single value to rethrow.
      return null;
    }

    return {
      CatchClause(node) {
        if (node.body.body.length > 0) return;
        const comments = sourceCode.getCommentsInside(node.body);
        const placeholderOnly = comments.length > 0 && comments.every((c) => PLACEHOLDER_COMMENT.test(c.value));
        // A comment that explains why the block is empty is a deliberate choice.
        if (comments.length > 0 && !placeholderOnly) return;

        const fix = rethrowFix(node);
        context.report({
          node,
          messageId: placeholderOnly ? 'placeholderCatch' : 'emptyCatch',
          suggest: fix ? [{ messageId: 'rethrow', fix }] : [],
        });
      },
    };
  },
});

export default noEmptyCatch;
