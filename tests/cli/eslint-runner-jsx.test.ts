import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { runEslint } from '../../cli/utils/eslint-runner';

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-jsx-'));
}

describe('cli eslint-runner jsx parsing', () => {
  it('does not report JSX parsing errors as unknown issues', async () => {
    const dir = createTempProject();

    try {
      const filePath = path.join(dir, 'App.js');
      fs.writeFileSync(
        filePath,
        `
function sendEvent(name) {
  console.log(name);
}

export default function App() {
  sendEvent('mounted');
  return <div>Hello</div>;
}
`,
        'utf8',
      );

      const result = await runEslint({
        preset: 'recommended',
        targetPath: dir,
      });

      const unknownParseIssues = result.files
        .flatMap((f) => f.issues)
        .filter((i) => i.ruleId === 'unknown' || i.message.startsWith('Parsing error'));

      expect(unknownParseIssues).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
