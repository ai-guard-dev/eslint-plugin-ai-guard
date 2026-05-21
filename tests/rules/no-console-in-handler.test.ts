import { ruleTester } from '../helpers/rule-tester';
import { noConsoleInHandler } from '../../src/rules/ai-patterns/no-console-in-handler';

ruleTester.run('no-console-in-handler', noConsoleInHandler, {
  valid: [
    {
      code: `
        app.get('/health', (req, res) => {
          logger.info('ok');
          res.send('ok');
        });
      `,
    },
    {
      code: `
        router.post('/users', validate, (req, res) => {
          audit.log('created');
          res.sendStatus(201);
        });
      `,
    },
    {
      code: `
        app.use((req, res, next) => {
          console.log('middleware');
          next();
        });
      `,
    },
    {
      code: `
        service.get('/value', handler);
      `,
    },
    {
      code: `
        app.get(pathValue, (req, res) => {
          console.log('dynamic path');
          res.send('ok');
        });
      `,
    },
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
    {
      code: `
        router.delete('/x', async (req, res) => {
          await service.remove();
          res.sendStatus(204);
        });
      `,
    },
    {
      code: `
        router.get('/ok', function(req, res) {
          return res.json({ ok: true });
        });
      `,
    },
    {
      code: `
        list.get('/item');
      `,
    },
    {
      code: `
        router.post('/x', auth, validate, handler);
      `,
    },
  ],
  invalid: [
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
    {
      code: `
        router.post('/users', (req, res) => {
          console.error(req.body);
          res.sendStatus(201);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    {
      code: `
        router.put('/users/:id', (req, res) => {
          console.warn('updating');
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    {
      code: `
        router.patch('/users/:id', (req, res) => {
          console.info('patch');
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    {
      code: `
        router.delete('/users/:id', (req, res) => {
          console.debug('delete');
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    {
      code: `
        app.all('/events', (req, res) => {
          console.log('all');
          res.send('ok');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    {
      code: `
        app.options('/events', (req, res) => {
          console.log('options');
          res.send('ok');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
    {
      code: `
        app.get('/x', auth, (req, res) => {
          console.log('x');
          res.send('x');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
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
        { messageId: 'noConsoleInHandler', suggestions: 1 },
      ],
    },
    {
      code: `
        app.get('/users', (req, res) => {
          console.log('template');
          res.send('ok');
        });
      `,
      errors: [{ messageId: 'noConsoleInHandler', suggestions: 1 }],
    },
  ],
});
