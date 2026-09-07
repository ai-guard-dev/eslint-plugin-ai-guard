import { ruleTester } from '../helpers/rule-tester';
import { noConsoleInHandler } from '../../src/rules/ai-patterns/no-console-in-handler';

ruleTester.run('no-console-in-handler', noConsoleInHandler, {
  valid: [
    // 1. Structured logger — always allowed
    {
      code: `
        app.get('/health', (req, res) => {
          logger.info('ok');
          res.send('ok');
        });
      `,
    },
    // 2. Audit logger — not console.*
    {
      code: `
        router.post('/users', validate, (req, res) => {
          audit.log('created');
          res.sendStatus(201);
        });
      `,
    },
    // 3. Middleware (app.use) — not a route handler
    {
      code: `
        app.use((req, res, next) => {
          console.log('middleware');
          next();
        });
      `,
    },
    // 4. Named handler reference — no inline function
    {
      code: `service.get('/value', handler);`,
    },
    // 5. Dynamic path — not detected as route registration
    {
      code: `
        app.get(pathValue, (req, res) => {
          console.log('dynamic path');
          res.send('ok');
        });
      `,
    },
    // 6. Nested function — console inside closure not in handler scope
    {
      code: `
        app.get('/x', (req, res) => {
          const fn = () => {
            console.log('nested');
          };
          fn();
          res.send('ok');
        });
      `,
    },
    // 7. No console in handler
    {
      code: `
        router.delete('/x', async (req, res) => {
          await service.remove();
          res.sendStatus(204);
        });
      `,
    },
    // 8. Clean handler — no console
    {
      code: `
        router.get('/ok', function(req, res) {
          return res.json({ ok: true });
        });
      `,
    },
    // 9. Non-routing .get() call
    {
      code: `list.get('/item');`,
    },
    // 10. Named middleware handlers — no inline function
    {
      code: `router.post('/x', auth, validate, handler);`,
    },
    // 11. console.warn allowed by default
    {
      code: `
        router.put('/users/:id', (req, res) => {
          console.warn('updating');
          res.sendStatus(204);
        });
      `,
    },
    // 12. console.error allowed by default
    {
      code: `
        router.post('/users', (req, res) => {
          console.error(req.body);
          res.sendStatus(201);
        });
      `,
    },
    // 13. Winston logger — allowed by default
    {
      code: `
        app.get('/api/data', (req, res) => {
          winston.info('fetching data');
          res.json(data);
        });
      `,
    },
    // 14. Pino logger — allowed by default
    {
      code: `
        app.post('/api/submit', (req, res) => {
          pino.info('submitted');
          res.sendStatus(200);
        });
      `,
    },
    // 15. Custom logger via allowedLoggers option
    {
      code: `
        app.get('/health', (req, res) => {
          myLogger.info('ok');
          res.send('ok');
        });
      `,
      options: [{ allowedLoggers: ['myLogger'] }],
    },
    // 16. console.info allowed when added to allowedConsoleMethods
    {
      code: `
        router.get('/data', (req, res) => {
          console.info('fetching');
          res.json({});
        });
      `,
      options: [{ allowedConsoleMethods: ['info'] }],
    },
    // 17. Multiple console.warn + console.error — both allowed
    {
      code: `
        router.get('/multi', (req, res) => {
          console.warn('a');
          console.error('b');
          res.send('ok');
        });
      `,
    },
  ],
  invalid: [
    // 1. console.log — always flagged (primary AI pattern)
    {
      code: `
        app.get('/health', (req, res) => {
          console.log('ok');
          res.send('ok');
        });
      `,
      errors: [
        {
          messageId: 'noConsoleInHandler',
          suggestions: [
            {
              messageId: 'removeConsoleCall',
              output: `
        app.get('/health', (req, res) => {
          
          res.send('ok');
        });
      `,
            },
          ],
        },
      ],
    },
    // 2. console.info — not in default allowed list
    {
      code: `
        router.patch('/users/:id', (req, res) => {
          console.info('patch');
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 3. console.debug — always flagged (AI debug leftover)
    {
      code: `
        router.delete('/users/:id', (req, res) => {
          console.debug('delete');
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 4. console.log in app.all
    {
      code: `
        app.all('/events', (req, res) => {
          console.log('all');
          res.send('ok');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 5. console.log in app.options
    {
      code: `
        app.options('/events', (req, res) => {
          console.log('options');
          res.send('ok');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 6. console.log after auth middleware
    {
      code: `
        app.get('/x', auth, (req, res) => {
          console.log('x');
          res.send('x');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 7. Mixed — console.log flagged, console.error allowed
    {
      code: `
        router.get('/multi', (req, res) => {
          console.log('a');
          console.error('b');
          res.send('ok');
        });
      `,
      errors: [
        { messageId: 'noConsoleInHandler', suggestions: 1 },
      ],
    },
    // 8. console.log with template literal route
    {
      code: `
        app.get('/users', (req, res) => {
          console.log('template');
          res.send('ok');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 9. console.log — not saved by adding custom logger
    {
      code: `
        app.get('/data', (req, res) => {
          console.log('debug');
          myLogger.info('ok');
          res.json({});
        });
      `,
      options: [{ allowedLoggers: ['myLogger'] }],
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // 10. console.trace — not in default allowed list
    {
      code: `
        router.post('/submit', (req, res) => {
          console.trace('submitted');
          res.sendStatus(200);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    // M6: Expression-body arrow function with console.log
    {
      code: `
        app.get('/test', (req, res) => console.log('test'));
      `,
      errors: [{ messageId: 'noConsoleInHandler' }],
    },
  ],
});
