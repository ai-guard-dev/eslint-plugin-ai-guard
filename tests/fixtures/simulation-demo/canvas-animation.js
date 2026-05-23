// Canvas animation loop — sequential await is intentional (frame-by-frame)
async function runAnimation(frames) {
  for (const frame of frames) {
    await renderFrame(frame);
    await sleep(16); // ~60fps
  }
}

// Blockchain transaction demo — sequential is required
async function processTransactions(txList) {
  for (const tx of txList) {
    await submitTransaction(tx);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function renderFrame(frame) {
  // render frame
}

async function submitTransaction(tx) {
  // submit
}
