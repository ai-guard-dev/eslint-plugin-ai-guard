// Plain JS file — no TypeScript
function processItems(items) {
  return items.map(item => item.value * 2);
}

// This should be flagged — unnecessary async
async function unnecessaryAsync() {
  return 'hello';
}

module.exports = { processItems, unnecessaryAsync };
