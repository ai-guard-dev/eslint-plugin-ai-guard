/**
 * Electron main process server example.
 * This file intentionally has Express routes without auth middleware —
 * these are localhost-only IPC helpers and should NOT be flagged.
 */
const express = require('express');
const { ipcMain } = require('electron');

const app = express();

// Local diagnostic API — no auth needed, localhost only
app.get('/api/diagnostics', (req, res) => {
  res.json({ status: 'ok', version: process.version });
});

app.get('/api/system-info', (req, res) => {
  res.json({ platform: process.platform, arch: process.arch });
});

app.post('/api/ipc-relay', (req, res) => {
  const data = req.body;
  ipcMain.emit('relay', data);
  res.json({ ok: true });
});

app.listen(9876, '127.0.0.1', () => {
  console.log('Electron local backend ready on port 9876');
});
