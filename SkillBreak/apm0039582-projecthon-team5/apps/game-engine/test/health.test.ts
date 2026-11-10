import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthController } from '../src/health/health.controller';
import { loadConfig } from '../src/config/config';
import { SandboxWorker } from '../src/modules/sandbox/sandbox-worker';
import { SandboxRepository } from '../src/modules/sandbox/sandbox.repository';
import { KubernetesDriver } from '../src/modules/sandbox/kubernetes-driver';
import { ProjectionDatabase } from '../src/modules/projection/projection-database';
import { ProjectionListener } from '../src/modules/projection/projection.listener';

const config = loadConfig({ DATABASE_URL: 'postgres://test:test@localhost/engine_db' });
let db: DataSource;
let controller: HealthController;
beforeEach(() => {
  db = new DataSource({ type: 'postgres', url: config.databaseUrl });
  jest.spyOn(db, 'query').mockResolvedValue([{ catalog: true, projection: true }]);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  controller = new HealthController(db);
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('reports foundation readiness', async () => {
  expect(await controller.check()).toEqual({
    status: 'ok', scope: 'foundation', db: 'up',
    schemas: { catalog: 'present', projection: 'present', sandbox: 'not_required' },
    modules: { sessions: 'implemented', components: 'implemented', projection: 'implemented', scriptCatalog: 'implemented', sandbox: 'implemented' },
    messaging: 'not_connected', sandboxWorker: 'disabled', sandboxRuntime: { developmentOnly: true, errorCode: null },
    projection: { tables: 'not_configured', listener: 'not_configured', consumer: 'not_connected', auth: 'not_configured', live: false },
  });
});

test.each(['starting', 'ready', 'unavailable'] as const)('reports sandbox %s independently of foundation readiness', async state => {
  const driver = new KubernetesDriver({ runtimeClass: 'runc', imageAllowlist: [] });
  const worker = new SandboxWorker(db, new SandboxRepository(db), driver, 2);
  worker.status = state;
  jest.spyOn(worker, 'checkRuntime').mockResolvedValue(state === 'ready');
  jest.spyOn(db, 'query').mockResolvedValue([{ catalog: true, projection: true, sandbox: true }]);
  controller = new HealthController(db, undefined, worker, config);
  if (state === 'ready') expect(await controller.check()).toMatchObject({ status: 'ok', sandboxWorker: 'ready',
    scope: 'engine-with-sql-sandbox', sandboxRuntime: { developmentOnly: true } });
  else await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
});

test('missing sandbox tables fail health despite a registered ready provider', async () => {
  const worker = new SandboxWorker(db, new SandboxRepository(db),
    new KubernetesDriver({ runtimeClass: 'runc', imageAllowlist: [] }), 2);
  worker.status = 'ready';
  jest.spyOn(worker, 'checkRuntime').mockResolvedValue(true);
  controller = new HealthController(db, undefined, worker, config);
  await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
});

test.each(['database', 'schema'])('reports %s failure independently and recovers', async dependency => {
  if (dependency === 'database') jest.spyOn(db, 'query').mockRejectedValue(new Error('database unavailable'));
  if (dependency === 'schema') jest.spyOn(db, 'query').mockResolvedValue([{ catalog: false, projection: true }]);
  let response: unknown;
  try { await controller.check(); } catch (error) {
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (error instanceof ServiceUnavailableException) { expect(error.getStatus()).toBe(503); response = error.getResponse(); }
  }
  expect(response).toMatchObject({ status: 'unavailable', db: dependency === 'database' ? 'down' : 'up' });
  expect(Logger.prototype.warn).toHaveBeenCalled();
  jest.spyOn(db, 'query').mockResolvedValue([{ catalog: true, projection: true }]);
  expect((await controller.check()).status).toBe('ok');
});

test('hung probes return 503 within two seconds rather than hang or claim readiness', async () => {
  jest.useFakeTimers();
  jest.spyOn(db, 'query').mockImplementation(() => new Promise(() => undefined));
  const result = expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  await jest.advanceTimersByTimeAsync(2000);
  await result;
  expect(jest.getTimerCount()).toBe(0);
});

test('projection readiness distinguishes missing tables, listener loss, transport and auth', async () => {
  const projection = new ProjectionDatabase(config);
  const listener = new ProjectionListener(config);
  const tables = jest.spyOn(projection, 'tablesReady').mockResolvedValue(true);
  listener.ready = true;
  controller = new HealthController(db, undefined, undefined, config, projection, listener);
  expect(await controller.check()).toMatchObject({ status: 'ok', projection: {
    tables: 'ready', listener: 'ready', consumer: 'not_connected', auth: 'not_configured', live: false,
  } });
  listener.ready = false;
  await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  listener.ready = true;
  tables.mockResolvedValue(false);
  await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  tables.mockRejectedValue(new Error('private database URL'));
  await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls)).not.toContain('private database URL');
});

test('projection listener failures are logged by name and code, never the message', async () => {
  const warn = Logger.prototype.warn as jest.Mock;
  const listener = new ProjectionListener(config) as unknown as {
    client?: unknown; stopped: boolean; failed(client: unknown): void; schedule(): void; connect(): Promise<void>; onModuleDestroy(): Promise<void>;
  };
  const client = { end: jest.fn().mockRejectedValue(Object.assign(new Error('private socket'), { code: 'EPIPE' })) };
  listener.client = client;
  listener.stopped = true;
  listener.failed(client);
  await new Promise(resolve => setImmediate(resolve));
  expect(warn).toHaveBeenCalledWith('Projection listener cleanup failed: Error code=EPIPE');

  jest.useFakeTimers();
  listener.stopped = false;
  jest.spyOn(listener, 'connect').mockRejectedValueOnce(Object.assign(new Error('private database URL'), { code: '28P01' }))
    .mockResolvedValue(undefined);
  listener.schedule();
  await jest.advanceTimersByTimeAsync(100);
  expect(warn).toHaveBeenCalledWith('Projection listener reconnect failed: Error code=28P01');
  listener.stopped = true;
  await jest.advanceTimersByTimeAsync(5000);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
});
