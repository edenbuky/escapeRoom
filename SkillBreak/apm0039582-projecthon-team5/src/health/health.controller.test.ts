import { DataSource } from 'typeorm';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

test('gateway health response and DB failure behavior remain unchanged', async () => {
  const db = new DataSource({ type: 'postgres', database: 'unused' });
  const query = jest.spyOn(db, 'query').mockResolvedValue([{ result: 1 }]);
  const controller = new HealthController(db);
  await expect(controller.check()).resolves.toEqual({ status: 'ok', db: 'up' });
  query.mockRejectedValue(new Error('database unavailable'));
  await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  query.mockResolvedValue([{ result: 1 }]);
  await expect(controller.check()).resolves.toEqual({ status: 'ok', db: 'up' });
});

test('gateway health returns 503 within two seconds for a stalled database probe', async () => {
  jest.useFakeTimers();
  const db = new DataSource({ type: 'postgres', database: 'unused' });
  jest.spyOn(db, 'query').mockImplementation(() => new Promise(() => undefined));
  const result = expect(new HealthController(db).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  await jest.advanceTimersByTimeAsync(2000);
  await result;
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('gateway health logs the failure name and code, never the message', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const db = new DataSource({ type: 'postgres', database: 'unused' });
  jest.spyOn(db, 'query').mockRejectedValue(Object.assign(new Error('password=secret'), { code: 'ECONNREFUSED' }));
  await expect(new HealthController(db).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(warn).toHaveBeenCalledWith('Gateway database health check failed: Error code=ECONNREFUSED');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  warn.mockRestore();
});
