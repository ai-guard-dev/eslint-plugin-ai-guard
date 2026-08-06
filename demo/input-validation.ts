// Demo: AI-generated data processing with unsafe deserialization
// AI tools frequently generate JSON.parse on user input without validation.

import express from 'express';

const app = express();

/**
 * Webhook receiver — AI generated this without input validation.
 */
app.post('/webhook/stripe', (req, res) => {
  // ❌ Unsafe deserialization — parsing raw user input without schema validation
  const event = JSON.parse(req.body);

  if (event.type === 'payment_intent.succeeded') {
    handlePaymentSuccess(event.data);
  }

  res.sendStatus(200);
});

/**
 * Config import endpoint.
 * AI used eval() to parse a dynamic config string.
 */
app.post('/api/import-config', (req, res) => {
  const configString = req.body.config;
  // ❌ eval() with user input — arbitrary code execution
  const config = eval('(' + configString + ')');
  applyConfig(config);
  res.json({ applied: true });
});

// Stubs
function handlePaymentSuccess(data: unknown) {}
function applyConfig(config: unknown) {}

export default app;
