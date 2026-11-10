async function check() {
  const responses = await Promise.all([3000, 3001].map(port =>
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })));
  if (responses.some(response => !response.ok)) throw new Error('Backend health is unavailable');
  const engine = await responses[1].json();
  if (engine.messaging !== 'connected' || !engine.projection?.live) {
    throw new Error('Engine messaging or authenticated projection is unavailable');
  }
}

if (require.main === module) {
  check().catch(error => {
    console.error(`Readiness failed: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { check };
