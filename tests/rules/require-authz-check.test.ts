import { ruleTester } from '../helpers/rule-tester';
import { requireAuthzCheck } from '../../src/rules/security/require-authz-check';

ruleTester.run('require-authz-check', requireAuthzCheck, {
  valid: [
    {
      code: `
        router.get('/users/:id', authenticate, (req, res) => {
          if (req.user.id !== req.params.id) return res.sendStatus(403);
          return res.json({ ok: true });
        });
      `,
    },
    {
      code: `
        router.patch('/users/:id', authenticate, (req, res) => {
          authorize(req.user, req.params.id);
          update(req.params.id, req.body);
          res.sendStatus(204);
        });
      `,
    },
    {
      code: `
        router.delete('/posts/:id', protect, (req, res) => {
          if (req.params.id === req.user.postId) {
            removePost(req.params.id);
          }
          res.sendStatus(204);
        });
      `,
    },
    {
      code: `
        router.get('/health', (req, res) => {
          res.send('ok');
        });
      `,
    },
    {
      code: `
        router.post('/users', (req, res) => {
          createUser(req.body);
          res.sendStatus(201);
        });
      `,
    },
    {
      code: `
        router.put('/accounts/:accountId', authenticate, (req, res) => {
          checkOwnership(req.user.id, req.params.accountId);
          save(req.params.accountId);
          res.sendStatus(200);
        });
      `,
    },
    {
      code: `
        app.get('/items/:id', (req, res) => {
          if (req.user && req.user.id == req.params.id) {
            return res.json(get(req.params.id));
          }
          return res.sendStatus(403);
        });
      `,
    },
    {
      code: `
        app.patch('/orgs/:id', (req, res) => {
          ensureOwner(req.user, req.params.id);
          res.sendStatus(204);
        });
      `,
    },
    {
      code: `
        app.get('/projects/:id', (req, res) => {
          canAccess(req.user, req.params.id);
          res.json({ id: req.params.id });
        });
      `,
    },
    {
      code: `
        app.get('/projects', (req, res) => {
          const id = req.params.id;
          res.json({ id });
        });
      `,
    },
  ],
  invalid: [
    {
      code: `
        router.get('/users/:id', authenticate, (req, res) => {
          const user = loadUser(req.params.id);
          res.json(user);
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        router.patch('/users/:id', authenticate, (req, res) => {
          updateUser(req.params.id, req.body);
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        router.delete('/posts/:id', protect, (req, res) => {
          remove(req.params.id);
          res.sendStatus(204);
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.get('/orders/:id', (req, res) => {
          res.json(readOrder(req.params.id));
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.put('/accounts/:accountId', (req, res) => {
          save(req.params.accountId, req.body);
          res.sendStatus(200);
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.patch('/profile/:id', (req, res) => {
          const id = req.params.id;
          update(id);
          res.sendStatus(200);
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.get('/profile/:id', (req, res) => {
          const isSelf = req.user;
          return res.json(load(req.params.id));
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.get('/files/:id', authenticate, (req, res) => {
          if (req.user) {
            return res.json(readFile(req.params.id));
          }
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.get('/items/:id', (req, res) => {
          const data = getById(req.query.id);
          res.json(data);
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
    {
      code: `
        app.get('/devices/:id', (req, res) => {
          const id = req.body.deviceId;
          res.json(loadDevice(id));
        });
      `,
      errors: [{ messageId: 'missingAuthz' }],
    },
  ],
});
