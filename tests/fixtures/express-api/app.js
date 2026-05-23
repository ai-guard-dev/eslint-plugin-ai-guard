const express = require('express');
const app = express();

// Auth middleware — should be detected
const authenticate = (req, res, next) => {
  if (!req.headers.authorization) return res.sendStatus(401);
  next();
};

// Protected route with auth — valid
app.get('/api/users', authenticate, async (req, res) => {
  const users = await getUsers();
  res.json(users);
});

// Public route — valid
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function getUsers() {
  return [];
}

module.exports = app;
