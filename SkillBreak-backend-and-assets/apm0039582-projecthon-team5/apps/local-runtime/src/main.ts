import 'reflect-metadata';
import { ConsoleLogger, INestApplication, Logger } from '@nestjs/common';
import type { MessageProducer } from '@team5/contracts/server';
import { createEngineApp } from '@team5/game-engine/bootstrap';
import { InMemoryTransport } from '@team5/messaging';
import { DataSource } from 'typeorm';
// Same relative seam as S9's executor (Q20 option (b)); option (a) would move it to an engine export.
import type { SandboxJobRequest } from '../../game-engine/dist/modules/sandbox/sandbox.contracts';
import { EngineService } from '../../game-engine/dist/modules/sessions/engine.service';
import { LocalContainerExecutor } from './local-container-executor';

// The gateway has no package export (B4): the root build compiles it into src/runtime.
interface GatewayConfig { host: string }
const { loadConfig } = require('../../../src/runtime/config/config') as { loadConfig(): GatewayConfig };
const { createGatewayApp } = require('../../../src/runtime/main') as {
  createGatewayApp(options: { config: GatewayConfig; producer: MessageProducer }): Promise<INestApplication>;
};

export async function bootstrap(): Promise<void> {
  const transport = new InMemoryTransport();
  const executor = process.env.SANDBOX_LOCAL_CONTAINER === 'true' ? new LocalContainerExecutor() : undefined;
  // Two configs: the engine runs its own loadEngineConfig, the gateway gets loadConfig. Ports are fixed here.
  const engine = await createEngineApp({ producer: transport, consumer: transport, executor });
  const apps = [engine];
  try {
    const config = loadConfig();
    const gateway = await createGatewayApp({ config, producer: transport });
    apps.push(gateway);
    // createEngineApp passes logger: false (bootstrap.ts L43), which silences every Nest Logger in the process (B3).
    const logger = new ConsoleLogger();
    for (const app of apps) { app.useLogger(logger); app.enableShutdownHooks(); }
    const trail = new Logger('GameEvents');
    await transport.subscribe('game-events', 'local-runtime', async event => {
      trail.log(`${event.type} sessionId=${event.sessionId} messageId=${event.messageId}`);
    });
    if (executor) {
      // An injected executor skips the kind worker (sandbox-engine.bridge.ts L19), so nothing answers the
      // provision and destroy requests. The local container is shared and always up: record each one as done.
      const database = engine.get(DataSource);
      const sessions = engine.get(EngineService);
      const recorded = new Set<string>();
      const timer = setInterval(() => void (async () => {
        if (!database.isInitialized) { clearInterval(timer); return; }
        const rows: { request: SandboxJobRequest }[] = await database.query(
          'SELECT request FROM engine_sandbox_requests ORDER BY created_at');
        for (const { request } of rows.filter(row => !recorded.has(row.request.jobId))) {
          const occurredAt = new Date().toISOString();
          await sessions.record(request.operation === 'provision' ? { ...request, kind: 'ready', occurredAt }
            : { ...request, kind: 'destroyed', occurredAt });
          recorded.add(request.jobId);
        }
      })().catch((error: unknown) => trail.error(`sandbox outcome failed: ${error instanceof Error ? error.name : 'unknown'}`)), 250);
      timer.unref();
    }
    await engine.listen(3001, config.host);
    await gateway.listen(3000, config.host);
    trail.log(`gateway :3000, engine :3001, SANDBOX_LOCAL_CONTAINER=${executor ? 'true' : 'false'}`);
  } catch (error) {
    await Promise.allSettled(apps.map(app => app.close()));
    throw error;
  }
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    process.stderr.write(`Local runtime startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
