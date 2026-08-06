// Demo: AI-generated API routes missing security best practices
// This file intentionally contains patterns that AI tools produce when
// scaffolding Express routes without security context.

import express from 'express';

const router = express.Router();

// ❌ Hardcoded API key — AI used a placeholder that got committed
const apiKey = 'sk-prod-1234567890abcdef1234567890';

// ❌ No auth middleware on sensitive route
router.get('/admin/users', async (req, res) => {
  const users = await db.findAll('users');
  console.log('Fetching admin users'); // ❌ console.log in handler
  res.json(users);
});

// ❌ SQL injection — AI concatenated user input into query
router.get('/users/search', async (req, res) => {
  const name = req.query.name;
  const results = await db.query(
    'SELECT * FROM users WHERE name = \'' + name + '\''
  );
  res.json(results);
});

// ❌ No auth middleware on DELETE route
router.delete('/users/:id', async (req, res) => {
  await db.delete('users', req.params.id);
  res.sendStatus(204);
});

// Stubs
const db = {
  findAll: (table: string) => Promise.resolve([]),
  query: (sql: string) => Promise.resolve([]),
  delete: (table: string, id: string) => Promise.resolve(),
};

export default router;
