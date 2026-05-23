import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import parser from '@typescript-eslint/parser';
import aiGuard from '../../src/index';

describe('integration: next-like file sample', () => {
  it('runs plugin rules in a non-framework file', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.{ts,tsx,js,jsx}'],
          languageOptions: {
            parser,
            parserOptions: {
              ecmaFeatures: { jsx: true },
            },
          },
          plugins: {
            'ai-guard': aiGuard,
          },
          rules: {
            ...aiGuard.configs.recommended.rules,
          },
        },
      ],
      ignore: false,
    });

    // Use a non-framework file (util.ts) so no-async-without-await is not suppressed
    const code = `
      const db = {
        query(sql) {
          return sql;
        },
      };

      // Returns a literal \u2014 not a pass-through, should be flagged
      async function fetchData() {
        return 1;
      }

      // String concat SQL \u2014 should be flagged
      async function main() {
        await fetchData();
        const sql = 'SELECT * FROM users WHERE id = ' + userId;
        db.query(sql);
      }
    `;

    // Use util.ts (non-framework file) so framework suppressions don't apply
    const [result] = await eslint.lintText(code, { filePath: 'util.ts' });
    const ruleIds = result.messages.map((m) => m.ruleId);

    // These should always be detected in non-framework files
    expect(ruleIds).toContain('ai-guard/no-sql-string-concat');
    // fetchData returns a literal (not a call) \u2014 should fire asyncWithoutAwait
    expect(ruleIds).toContain('ai-guard/no-async-without-await');
  });

  it('suppresses no-async-without-await in Next.js framework files', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.{ts,tsx,js,jsx}'],
          languageOptions: {
            parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          plugins: { 'ai-guard': aiGuard },
          rules: { ...aiGuard.configs.recommended.rules },
        },
      ],
      ignore: false,
    });

    const routeCode = `
      // Next.js App Router route handler \u2014 async is required by framework convention
      export async function GET() {
        return Response.json({ status: 'ok' });
      }
      export async function POST(request) {
        return Response.json({ received: 'data' });
      }
    `;

    // Use route.ts filename \u2014 should suppress no-async-without-await entirely
    const [result] = await eslint.lintText(routeCode, { filePath: 'app/api/users/route.ts' });
    const asyncIssues = result.messages.filter(
      (m) => m.ruleId === 'ai-guard/no-async-without-await',
    );

    expect(asyncIssues).toHaveLength(0);
  });
});
