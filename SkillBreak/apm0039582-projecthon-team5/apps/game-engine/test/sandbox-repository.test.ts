import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { SandboxRepository, validateSandboxIdentity, inputFingerprint } from '../src/modules/sandbox/sandbox.repository';
import { databaseOptions, loadConfig } from '../src/config/config';

const identity = sandboxIdentity(randomUUID(), 'idan-db', 1);
function setup() {
  const database = new DataSource(databaseOptions(loadConfig({
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
  })));
  const real = database.createQueryRunner();
  const runner = Object.assign(real, {
    connect: jest.spyOn(real, 'connect').mockResolvedValue(undefined),
    release: jest.spyOn(real, 'release').mockResolvedValue(undefined),
    query: jest.spyOn(real, 'query').mockResolvedValue([{ acquired: true, unlocked: true,
      pid: 123, backend_start: '2026-11-02 10:00:00+00' }]),
  });
  jest.spyOn(database, 'createQueryRunner').mockReturnValue(runner);
  jest.spyOn(database, 'query').mockResolvedValue([]);
  const repository = new SandboxRepository(database);
  return { runner, database, repository };
}
afterEach(() => jest.restoreAllMocks());

test('validates canonical namespace/pod/generation and hashes exact UTF-8 bytes', () => {
  expect(validateSandboxIdentity(identity)).toBe(identity.podName);
  for (const invalid of [{ ...identity, namespace: 'default' }, { ...identity, generation: 0 },
    { ...identity, podName: 'sbx-unowned' }, { ...identity, sessionId: 'not-uuid' }]) {
    expect(() => validateSandboxIdentity(invalid)).toThrow(SandboxExecutionError);
  }
  expect(inputFingerprint('SELECT 1')).not.toBe(inputFingerprint('SELECT 1 '));
  expect(inputFingerprint('é')).not.toBe(inputFingerprint('e\u0301'));
  expect(inputFingerprint('SELECT 1')).toMatch(/^[a-f0-9]{64}$/);
});

test('uses a nonblocking dedicated session lock and explicitly unlocks before returning the connection', async () => {
  const { runner, repository } = setup();
  const work = jest.fn().mockResolvedValue('done');
  await expect(repository.withLock(identity, work)).resolves.toEqual({ acquired: true, value: 'done' });
  expect(runner.query).toHaveBeenNthCalledWith(1,
    expect.stringContaining('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired'),
    [`team5:sandbox:${identity.podName}`]);
  expect(runner.query).toHaveBeenNthCalledWith(2,
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [`team5:sandbox:${identity.podName}`]);
  expect(runner.query.mock.invocationCallOrder[1]).toBeLessThan(runner.release.mock.invocationCallOrder[0]);
  expect(work).toHaveBeenCalledWith(runner);
});

test('busy does not invoke work or wait on another sandbox', async () => {
  const { runner, repository } = setup();
  runner.query.mockResolvedValue([{ acquired: false, unlocked: false }]);
  const work = jest.fn();
  await expect(repository.withLock(identity, work)).resolves.toEqual({ acquired: false });
  expect(work).not.toHaveBeenCalled();
  expect(runner.release).toHaveBeenCalledTimes(1);
});

test('callback failure still unlocks and surfaces only a sanitized persistence category', async () => {
  const { runner, repository } = setup();
  const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  await expect(repository.withLock(identity, async () => { throw new Error('SELECT secret'); }))
    .rejects.toMatchObject({ code: 'persistenceFailure' });
  expect(runner.release).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
});

test('unlock failure quarantines rather than returns a potentially locked connection', async () => {
  const { runner, repository } = setup();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  runner.query.mockResolvedValueOnce([{ acquired: true, unlocked: true, pid: 123, backend_start: '2026-11-02 10:00:00+00' }])
    .mockRejectedValueOnce(new Error('network'));
  await expect(repository.withLock(identity, async () => 1)).rejects.toMatchObject({ code: 'lockCleanupFailed' });
  expect(runner.release).not.toHaveBeenCalled();
  await expect(repository.withLock(identity, async () => 2)).rejects.toMatchObject({ code: 'lockCleanupFailed' });
  runner.query.mockResolvedValue([{ acquired: true, unlocked: true }]);
  await repository.close();
  expect(runner.release).toHaveBeenCalledTimes(1);
});

test('typed admission failures keep their category after lock cleanup', async () => {
  const { repository } = setup();
  await expect(repository.withLock(identity, async () => { throw new SandboxExecutionError('expired'); }))
    .rejects.toMatchObject({ code: 'expired' });
});

test('connection limit reserves pool capacity without constructing extra runners', async () => {
  const { database, repository } = setup();
  const pending: (() => void)[] = [];
  const work = () => new Promise<void>(resolve => pending.push(resolve));
  const first = repository.withLock(identity, work);
  const second = repository.withLock(sandboxIdentity(randomUUID(), 'idan-db', 1), work);
  await new Promise(resolve => setImmediate(resolve));
  await expect(repository.withLock(sandboxIdentity(randomUUID(), 'idan-db', 1), work))
    .rejects.toMatchObject({ code: 'capacityExceeded' });
  expect(database.createQueryRunner).toHaveBeenCalledTimes(2);
  pending.forEach(resolve => resolve());
  await Promise.all([first, second]);
});
