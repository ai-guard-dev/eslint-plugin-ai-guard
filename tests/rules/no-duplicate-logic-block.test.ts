import { ruleTester } from '../helpers/rule-tester';
import { noDuplicateLogicBlock } from '../../src/rules/ai-patterns/no-duplicate-logic-block';

ruleTester.run('no-duplicate-logic-block', noDuplicateLogicBlock, {
  valid: [
    {
      code: `
        function run() {
          doA();
          doB();
        }
      `,
    },
    {
      code: `
        if (a) {
          process(a);
        }
        if (b) {
          process(b);
        }
      `,
    },
    {
      code: `
        const x = 1;
        const y = 1;
      `,
    },
    {
      code: `
        for (const id of ids) {
          handle(id);
        }
        for (const id of ids2) {
          handle(id);
        }
      `,
    },
    {
      code: `
        try {
          doWork();
        } catch (e) {
          handle(e);
        }

        try {
          doWork2();
        } catch (e) {
          handle(e);
        }
      `,
    },
    {
      code: `
        function one() { return longCall(a, b, c); }
        function two() { return longCall(a, b, c); }
      `,
    },
    {
      code: `
        {
          taskA();
          taskB();
        }
      `,
    },
    {
      code: `
        if (condition) {
          const value = compute(a);
          use(value);
        }
        doOther();
      `,
    },
    {
      code: `
        const item = list[0];
        const second = list[1];
      `,
    },
    {
      code: `
        while (cond) {
          step();
          break;
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        if (user) {
          const value = compute(user.id);
          save(value);
        }
        if (user) {
          const value = compute(user.id);
          save(value);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        {
          doLongTask(alpha, beta, gamma);
        }
        {
          doLongTask(alpha, beta, gamma);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        try {
          operation();
          track();
        } catch (e) {
          report(e);
        }
        try {
          operation();
          track();
        } catch (e) {
          report(e);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        switch (kind) {
          case 'a':
            doX();
            doY();
            break;
        }
        switch (kind) {
          case 'a':
            doX();
            doY();
            break;
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        if (a && b && c) {
          const result = perform(a, b, c);
          commit(result);
        }
        if (a && b && c) {
          const result = perform(a, b, c);
          commit(result);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        {
          const payload = buildPayload(input);
          send(payload);
        }
        {
          const payload = buildPayload(input);
          send(payload);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        for (const user of users) {
          sync(user);
          updateStats(user);
        }
        for (const user of users) {
          sync(user);
          updateStats(user);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        if (ready) {
          start(a, b, c, d);
          finalize(a, b, c, d);
        }
        if (ready) {
          start(a, b, c, d);
          finalize(a, b, c, d);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        while (ok) {
          rotate();
          write();
          break;
        }
        while (ok) {
          rotate();
          write();
          break;
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
    {
      code: `
        {
          const token = makeToken(user.id);
          cache.set(user.id, token);
        }
        {
          const token = makeToken(user.id);
          cache.set(user.id, token);
        }
      `,
      errors: [{ messageId: 'duplicateLogic' }],
    },
  ],
});
