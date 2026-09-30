const express = require('express');
const { Pool } = require('pg');
const pool = new Pool();

const app = express();
app.use(express.json());

// 1. A hardcoded API key (should trigger no-hardcoded-secret)
const API_SECRET_KEY = "custom_auth_token_secret_xyz123456789";

// 2. An eval() with dynamic input (should trigger no-eval-dynamic)
app.post('/calculate', (req, res) => {
    const { formula } = req.body;
    // Dangerous eval
    const result = eval(formula);
    res.json({ result });
});

// 3. An empty catch block (should trigger no-empty-catch)
app.get('/metrics', async (req, res) => {
    try {
        await pool.query('SELECT * FROM metrics');
    } catch (error) {
    }
    res.send('Metrics updated');
});

// 4. SQL string concatenation (should trigger no-sql-string-concat)
app.get('/users/:username', async (req, res) => {
    const { username } = req.params;
    // Unsafe SQL concatenation
    const query = "SELECT * FROM users WHERE username = '" + username + "'";
    const result = await pool.query(query);
    res.json(result.rows);
});

// 5. A floating promise from a local async function (should trigger no-floating-promise)
app.post('/users', (req, res) => {
    const user = req.body;
    // Forgetting to await or catch the promise
    fetch('https://example.com/notify');
    res.status(201).send('User created');
});

// --- CLEAN CODE SECTION ---
// The following code should NOT trigger any rules

app.get('/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT 1 as healthy');
        if (result.rows[0].healthy === 1) {
            res.status(200).json({ status: 'ok' });
        } else {
            res.status(500).json({ status: 'error' });
        }
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/safe-users', async (req, res) => {
    const { username, email } = req.body;
    try {
        const query = 'INSERT INTO users(username, email) VALUES($1, $2) RETURNING id';
        const values = [username, email];
        const result = await pool.query(query, values);
        
        await fetch('https://example.com/notify');
        
        res.status(201).json({ id: result.rows[0].id });
    } catch (error) {
        console.error('Failed to create user:', error);
        res.status(500).json({ error: 'Creation failed' });
    }
});
