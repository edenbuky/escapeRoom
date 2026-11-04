import { ConsoleLogger, Logger, LoggerService } from '@nestjs/common';
import type { GameEvent } from '@team5/contracts';
import type { MessageProducer } from '@team5/contracts/server';
import { createEngineApp } from '@team5/game-engine/bootstrap';
import { DataSource } from 'typeorm';
import { EngineService } from '../../game-engine/dist/modules/sessions/engine.service';
import { LocalContainerExecutor } from '../src/local-container-executor';
import { bootstrap } from '../src/main';

jest.mock('@team5/game-engine/bootstrap', () => ({ createEngineApp: jest.fn() }));
jest.mock('../src/local-container-executor', () => ({ LocalContainerExecutor: jest.fn() }));
const createGatewayApp = jest.fn();
jest.mock('../../../src/runtime/main', () => ({ createGatewayApp: (...args: unknown[]) => createGatewayApp(...args) }));
jest.mock('../../../src/runtime/config/config', () => ({ loadConfig: () => ({ host: '127.0.0.1' }) }));

const provision = { jobId: 'job-1', operation: 'provision', sessionId: 's', puzzleKey: 'idan-db', generation: 1,
  namespace: 'team5-sandboxes', podName: 'sbx-1', imageDigest: 'local/room1-sql:dev', seedRef: 'room1-sql-v1' };
let database: { isInitialized: boolean; query: jest.Mock };
let sessions: { record: jest.Mock };

// Same behaviour as Nest's app.useLogger: it overrides the process-wide Logger.
function fakeApp() {
  return { get: jest.fn((token: unknown) => (token === DataSource ? database : token === EngineService ? sessions : undefined)), useLogger: jest.fn((logger: LoggerService) => Logger.overrideLogger(logger)), enableShutdownHooks: jest.fn(),
    listen: jest.fn(async () => undefined), close: jest.fn(async () => undefined) };
}

describe('local runtime', () => {
  let engine: ReturnType<typeof fakeApp>;
  let gateway: ReturnType<typeof fakeApp>;
  let output: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SANDBOX_LOCAL_CONTAINER;
    database = { isInitialized: true, query: jest.fn(async () => [{ request: provision }]) };
    sessions = { record: jest.fn(async () => undefined) };
    engine = fakeApp();
    gateway = fakeApp();
    // What createEngineApp's logger: false does to the whole process (B3).
    jest.mocked(createEngineApp).mockImplementation(async () => { Logger.overrideLogger(false); return engine as never; });
    createGatewayApp.mockResolvedValue(gateway);
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  });
  afterEach(() => { database.isInitialized = false; jest.restoreAllMocks(); });

  it('shares one in-memory transport and listens on 3000 and 3001', async () => {
    await bootstrap();
    const options = jest.mocked(createEngineApp).mock.calls[0][0]!;
    expect(options.consumer).toBe(options.producer);
    expect(createGatewayApp).toHaveBeenCalledWith({ config: { host: '127.0.0.1' }, producer: options.producer });
    expect(engine.listen).toHaveBeenCalledWith(3001, '127.0.0.1');
    expect(gateway.listen).toHaveBeenCalledWith(3000, '127.0.0.1');
    expect(engine.useLogger.mock.calls[0][0]).toBeInstanceOf(ConsoleLogger);
    expect(gateway.useLogger.mock.calls[0][0]).toBe(engine.useLogger.mock.calls[0][0]);
  });

  it('logs each game event by type, sessionId and messageId, never the payload', async () => {
    await bootstrap();
    const producer = jest.mocked(createEngineApp).mock.calls[0][0]!.producer as MessageProducer;
    const event = { type: 'RoomEntered', sessionId: 'session-1', messageId: 'message-1',
      payload: { room: { username: 'danaZ22' } } } as unknown as GameEvent;
    await producer.publish('game-events', event);
    await new Promise(resolve => setImmediate(resolve));
    const trail = output.filter(line => line.includes('GameEvents')).join('');
    expect(trail).toContain('RoomEntered sessionId=session-1 messageId=message-1');
    expect(output.join('')).not.toContain('danaZ22');
  });

  it('uses the kind path unless SANDBOX_LOCAL_CONTAINER=true', async () => {
    await bootstrap();
    expect(jest.mocked(createEngineApp).mock.calls[0][0]!.executor).toBeUndefined();
    process.env.SANDBOX_LOCAL_CONTAINER = 'true';
    await bootstrap();
    expect(jest.mocked(createEngineApp).mock.calls[1][0]!.executor).toBe(jest.mocked(LocalContainerExecutor).mock.instances[0]);
  });

  it('records each local-container sandbox request once, since no kind worker answers it', async () => {
    process.env.SANDBOX_LOCAL_CONTAINER = 'true';
    await bootstrap();
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(sessions.record).toHaveBeenCalledTimes(1);
    expect(sessions.record).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', kind: 'ready' }));
  });

  it('closes the engine when the gateway fails to start', async () => {
    createGatewayApp.mockRejectedValue(new Error('gateway down'));
    await expect(bootstrap()).rejects.toThrow('gateway down');
    expect(engine.close).toHaveBeenCalled();
  });
});
