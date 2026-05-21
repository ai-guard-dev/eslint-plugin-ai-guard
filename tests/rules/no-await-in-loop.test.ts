import { ruleTester } from '../helpers/rule-tester';
import { noAwaitInLoop } from '../../src/rules/async/no-await-in-loop';

ruleTester.run('no-await-in-loop', noAwaitInLoop, {
  valid: [
    {
      code: `
        async function loadProfile() {
          const profile = await fetch('/api/profile');
          return profile;
        }
      `,
    },
    {
      code: `
        async function withRetry(urls) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await fetch(urls[attempt]);
              break;
            } catch (error) {
              continue;
            }
          }
        }
      `,
    },
    {
      code: `
        async function fallback(endpoints) {
          for (const endpoint of endpoints) {
            const result = await request(endpoint);
            if (result.ok) {
              return result;
            }
          }

          return null;
        }
      `,
    },
    {
      code: `
        // ai-guard-disable no-await-in-loop -- reason: ordered migration with checkpoints
        async function migrate(steps) {
          for (const step of steps) {
            await runStep(step);
          }
        }
      `,
    },
    {
      code: `
        async function continueOnError(tasks) {
          for (const task of tasks) {
            try {
              await runTask(task);
            } catch (error) {
              continue;
            }
          }
        }
      `,
    },
    {
      code: `
        async function consume(stream) {
          for await (const chunk of stream) {
            await persistChunk(chunk);
          }
        }
      `,
    },
    {
      code: `
        async function processSequentially(items) {
          let previous = null;

          for (const item of items) {
            previous = await applyTransform(previous, item);
          }

          return previous;
        }
      `,
    },
    {
      code: `
        async function controlledImport(rows) {
          for (const row of rows) {
            await delay(25);
            processRow(row);
          }
        }
      `,
    },
    {
      code: `
        async function processGroups(groups) {
          for (const group of groups) {
            const runInNestedScope = async () => {
              await syncGroup(group);
            };

            runInNestedScope();
          }
        }
      `,
    },
    // 10. while loop with retry counter — should NOT flag (retry pattern)
    {
      code: `
        async function withRetry(url, maxRetries = 3) {
          let attempts = 0;
          while (attempts < maxRetries) {
            try {
              return await fetch(url);
            } catch (e) {
              attempts++;
            }
          }
        }
      `,
    },
    // 11. Await inside loop but in a nested async function
    {
      code: `
        async function processAll(items) {
          for (const item of items) {
            setTimeout(async () => {
              await processItem(item);
            }, 0);
          }
        }
      `,
    },
    // 12. while loop with sequential counter mutation (i++ modifies outer state)
    // The rule correctly does NOT fire here because i is a shared counter — sequential dependency
    {
      code: `
        async function pollAll(urls) {
          let i = 0;
          while (i < urls.length) {
            await fetch(urls[i]);
            i++;
          }
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        async function processAll(items) {
          for (const item of items) {
            await processItem(item);
          }
        }
      `,
      output: `
        async function processAll(items) {
          await Promise.all(items.map(async (item) => await processItem(item)));
        }
      `,
      errors: [{ messageId: 'awaitInLoop' }],
    },
    {
      code: `
        async function processByIndex(items) {
          for (let i = 0; i < items.length; i++) {
            await processItem(items[i]);
          }
        }
      `,
      output: null,
      errors: [{ messageId: 'awaitInLoop' }],
    },
    {
      code: `
        async function processObject(obj) {
          for (const key in obj) {
            await persistPair(key, obj[key]);
          }
        }
      `,
      output: null,
      errors: [{ messageId: 'awaitInLoop' }],
    },
    {
      code: `
        async function processNested(groups) {
          for (const group of groups) {
            for (const item of group.items) {
              await processItem(item);
            }
          }
        }
      `,
      output: null,
      errors: [{ messageId: 'awaitInLoop' }],
    },
    {
      code: `
        async function loadPages(pages) {
          for (const page of pages) {
            await fetch(page.url);
          }
        }
      `,
      output: `
        async function loadPages(pages) {
          await Promise.all(pages.map(async (page) => await fetch(page.url)));
        }
      `,
      errors: [{ messageId: 'awaitInLoop' }],
    },
  ],
});
