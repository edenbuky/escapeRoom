import 'reflect-metadata';
import { describeFailure } from '@team5/messaging';
import { createEngineApp } from './bootstrap';
import { ENGINE_CONFIG, EngineConfig } from './config/config';
import { TerminalLogger } from './terminal-logger';

export async function bootstrap(): Promise<void> {
  const app = await createEngineApp();
  app.useLogger(new TerminalLogger());
  const config = app.get<EngineConfig>(ENGINE_CONFIG);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}
if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    process.stderr.write(`Game-engine startup failed; check configuration and dependency availability. ${describeFailure(error)}\n`);
    process.exitCode = 1;
  });
}
