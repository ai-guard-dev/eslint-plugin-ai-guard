import { ruleTester } from '../helpers/rule-tester';
import { noAsyncArrayCallback } from '../../src/rules/async/no-async-array-callback';

ruleTester.run('no-async-array-callback', noAsyncArrayCallback, {
  valid: [
    // 1. Non-async map callback
    {
      code: `const doubled = arr.map(x => x * 2);`,
    },
    // 2. Non-async filter callback
    {
      code: `const evens = arr.filter(x => x % 2 === 0);`,
    },
    // 3. Non-async forEach
    {
      code: `arr.forEach(x => console.log(x));`,
    },
    // 4. Non-async reduce
    {
      code: `const sum = arr.reduce((acc, x) => acc + x, 0);`,
    },
    // 5. Promise.all wrapping async map (correct pattern)
    {
      code: `const results = await Promise.all(arr.map(async x => await fetch(x)));`,
    },
    // 6. Regular function expression callback (not async)
    {
      code: `arr.map(function(x) { return x + 1; });`,
    },
    // 7. Method call that is not an array method
    {
      code: `obj.customMethod(async () => await doThing());`,
    },
    // 8. Arrow function with no async
    {
      code: `items.flatMap(item => item.children);`,
    },
    // 9. find with sync callback
    {
      code: `const found = arr.find(x => x.id === targetId);`,
    },
    // 10. some with sync callback
    {
      code: `const hasNegative = arr.some(x => x < 0);`,
    },
    // 11. Class method that happens to be named map but not Array.map
    {
      code: `myMap.set('key', async () => await doWork());`,
    },
    // 12. Chained non-async callbacks
    {
      code: `arr.filter(x => x > 0).map(x => x * 2);`,
    },
    // 13. async map assigned, then consumed by Promise.all
    {
      code: `
        const tasks = arr.map(async (item) => transform(item));
        await Promise.all(tasks);
      `,
    },
    // 14. async flatMap consumed by Promise.allSettled
    {
      code: `
        const tasks = arr.flatMap(async (item) => expand(item));
        await Promise.allSettled(tasks);
      `,
    },
    // 15. async map consumed by Promise.race
    {
      code: `
        const requests = urls.map(async (url) => fetch(url));
        await Promise.race(requests);
      `,
    },
  ],
  invalid: [
    // 1. async arrow in map
    {
      code: `const results = arr.map(async (item) => await fetchData(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'map' } }],
    },
    // 2. async arrow in filter
    {
      code: `const filtered = arr.filter(async (item) => await isValid(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'filter' } }],
    },
    // 3. async arrow in forEach
    {
      code: `arr.forEach(async (item) => { await process(item); });`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'forEach' } }],
    },
    // 4. async arrow in reduce
    {
      code: `const result = arr.reduce(async (acc, item) => { const val = await compute(item); return acc + val; }, 0);`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'reduce' } }],
    },
    // 5. async function expression in map
    {
      code: `arr.map(async function(item) { return await fetch(item); });`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'map' } }],
    },
    // 6. async in flatMap
    {
      code: `arr.flatMap(async (item) => await getChildren(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'flatMap' } }],
    },
    // 7. async in find
    {
      code: `const result = arr.find(async (item) => await checkExistence(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'find' } }],
    },
    // 8. async in findIndex
    {
      code: `const idx = arr.findIndex(async (item) => await validate(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'findIndex' } }],
    },
    // 9. async in some
    {
      code: `const any = arr.some(async (item) => await isReady(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'some' } }],
    },
    // 10. async in every
    {
      code: `const all = arr.every(async (item) => await isComplete(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'every' } }],
    },
    // 11. Chained call with async callback
    {
      code: `items.filter(x => x.active).map(async (item) => await transform(item));`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'map' } }],
    },
    // 12. async callback on a method call result
    {
      code: `getItems().forEach(async (item) => { await save(item); });`,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'forEach' } }],
    },
    // 13. async map assigned but never consumed by Promise combinator
    {
      code: `
        const tasks = arr.map(async (item) => transform(item));
        console.log(tasks.length);
      `,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'map' } }],
    },
    // 14. async map result directly returned without Promise combinator
    {
      code: `
        function buildCards(items) {
          return items.map(async (item) => renderCard(item));
        }
      `,
      errors: [{ messageId: 'asyncArrayCallback', data: { method: 'map' } }],
    },
  ],
});
