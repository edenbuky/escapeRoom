require('reflect-metadata');
// Preserve the existing telemetry setup without starting its standalone gateway.
require('../src/index');
const { InMemoryTransport, describeFailure } = require('@team5/messaging');
const { createEngineApp } = require('../apps/game-engine/dist/bootstrap');
const { loadConfig: loadEngineConfig } = require('../apps/game-engine/dist/config/config');
const { TerminalLogger } = require('../apps/game-engine/dist/terminal-logger');
const { createGatewayApp } = require('../src/runtime/main');
const { loadConfig: loadGatewayConfig } = require('../src/runtime/config/config');

async function start() {
  if (process.env.DB_NAME !== 'tdp-2026-db' || process.env.DB_SSL !== 'true') {
    throw new Error('Deployed startup requires the shared database and verified TLS');
  }
  const gatewayConfig = loadGatewayConfig();
  if (!gatewayConfig.internalApiToken) throw new Error('INTERNAL_API_TOKEN is required for deployed gameplay');
  const engineConfig = loadEngineConfig({ ...process.env, PORT: '3001', HOST: '0.0.0.0' });
  const engineUrl = new URL(engineConfig.databaseUrl);
  if (gatewayConfig.port !== 3000 || decodeURIComponent(engineUrl.pathname) !== '/tdp-2026-db'
    || engineUrl.hostname !== gatewayConfig.database.host || engineConfig.databaseSsl !== true) {
    throw new Error('Deployed gateway/Engine must use port 3000 and the same shared PostgreSQL host with verified TLS');
  }
  const transport = new InMemoryTransport();
  const apps = [];
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    const failures = [];
    for (const app of [...apps].reverse()) {
      try { await app.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Backend shutdown failed');
  }
  try {
    const engine = await createEngineApp({ config: engineConfig, producer: transport, consumer: transport });
    apps.push(engine);
    const gateway = await createGatewayApp({ config: gatewayConfig, producer: transport });
    apps.push(gateway);
    for (const app of apps) app.useLogger(new TerminalLogger());
    await engine.listen(3001, '0.0.0.0');
    await gateway.listen(gatewayConfig.port, '0.0.0.0');
    return stop;
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Backend startup and cleanup failed'); }
    throw error;
  }
}

if (require.main === module) {
  start().then(stop => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        stop().catch(error => {
          console.error(`Backend shutdown failed: ${describeFailure(error)}`);
          process.exitCode = 1;
        });
      });
    }
  }).catch(error => {
    console.error(`Deployed backend startup failed: ${describeFailure(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { start };
