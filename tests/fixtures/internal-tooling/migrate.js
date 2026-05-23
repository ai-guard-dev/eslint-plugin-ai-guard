/**
 * Database migration script.
 * JSON.parse usage here is expected and internal — should NOT be flagged.
 */
const fs = require('fs');

async function runMigration(configPath) {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw); // Internal config, not user input

  for (const step of config.steps) {
    const stepData = JSON.parse(JSON.stringify(step)); // Deep clone
    console.log(`Running step: ${stepData.name}`);
    // Execute migration...
  }
}

module.exports = { runMigration };
