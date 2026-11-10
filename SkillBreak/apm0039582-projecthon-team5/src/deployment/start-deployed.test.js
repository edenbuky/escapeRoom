jest.mock('../../apps/game-engine/dist/bootstrap', () => ({ createEngineApp: jest.fn() }), { virtual: true });
jest.mock('../../apps/game-engine/dist/config/config', () => ({ loadConfig: jest.fn() }), { virtual: true });
jest.mock('../../apps/game-engine/dist/terminal-logger', () => ({ TerminalLogger: jest.fn() }), { virtual: true });
jest.mock('../runtime/main', () => ({ createGatewayApp: jest.fn() }), { virtual: true });
jest.mock('../runtime/config/config', () => ({ loadConfig: jest.fn() }), { virtual: true });

const { createEngineApp } = require('../../apps/game-engine/dist/bootstrap');
const { createGatewayApp } = require('../runtime/main');
const { loadConfig } = require('../runtime/config/config');
const { loadConfig: loadEngineConfig } = require('../../apps/game-engine/dist/config/config');
const { start } = require('../../scripts/start-deployed');
const originalEnv = process.env;
let engine, gateway, order;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv, DB_NAME: 'tdp-2026-db', DB_SSL: 'true' };
  order = [];
  const app = name => ({ useLogger: jest.fn(), listen: jest.fn(async () => { order.push(`listen:${name}`); }),
    close: jest.fn(async () => { order.push(`close:${name}`); }) });
  engine = app('engine'); gateway = app('gateway');
  createEngineApp.mockResolvedValue(engine);
  createGatewayApp.mockResolvedValue(gateway);
  loadConfig.mockReturnValue({ port: 3000, internalApiToken: 'configured', database: { host: 'db.example' } });
  loadEngineConfig.mockReturnValue({ databaseUrl: 'postgresql://user:password@db.example/tdp-2026-db', databaseSsl: true });
});
afterEach(() => { process.env = originalEnv; });

test('starts gateway and Engine with the same transport, then drains gateway before Engine', async () => {
  const stop = await start();
  expect(createEngineApp.mock.calls[0][0].producer).toBe(createGatewayApp.mock.calls[0][0].producer);
  expect(createEngineApp.mock.calls[0][0].consumer).toBe(createGatewayApp.mock.calls[0][0].producer);
  expect(order).toEqual(['listen:engine', 'listen:gateway']);
  await stop(); await stop();
  expect(order).toEqual(['listen:engine', 'listen:gateway', 'close:gateway', 'close:engine']);
});
test('fails closed for a local database or missing internal token', async () => {
  process.env.DB_NAME = 'local';
  await expect(start()).rejects.toThrow('shared database');
  process.env.DB_NAME = 'tdp-2026-db';
  loadConfig.mockReturnValue({ port: 3000, internalApiToken: '' });
  await expect(start()).rejects.toThrow('INTERNAL_API_TOKEN');
  expect(createEngineApp).not.toHaveBeenCalled();
});
test('gateway startup failure closes the already initialized Engine', async () => {
  createGatewayApp.mockRejectedValue(new Error('gateway failed'));
  await expect(start()).rejects.toThrow('gateway failed');
  expect(engine.close).toHaveBeenCalledTimes(1);
});
test('stale engine URL cannot redirect the deployed Engine to a local database', async () => {
  loadEngineConfig.mockReturnValue({ databaseUrl: 'postgresql://user:password@localhost/local', databaseSsl: false });
  await expect(start()).rejects.toThrow('shared PostgreSQL');
  expect(createEngineApp).not.toHaveBeenCalled();
});
test('listener failure cleans up both applications', async () => {
  gateway.listen.mockRejectedValue(new Error('bind failed'));
  await expect(start()).rejects.toThrow('bind failed');
  expect(order.slice(-2)).toEqual(['close:gateway', 'close:engine']);
});
