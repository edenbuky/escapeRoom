import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { EngineRuntime } from '../src/modules/sessions/engine-runtime';
import type { EngineService } from '../src/modules/sessions/engine.service';

test('outbox delivery failures are logged by name and code, never the message', async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const runtime = new EngineRuntime({} as DataSource, {} as EngineService, { producer: { publish: jest.fn() } });
  jest.spyOn(runtime, 'flush').mockRejectedValue(Object.assign(new Error('private payload'), { code: '40P01' }));
  try {
    runtime.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(100);
    expect(warn).toHaveBeenCalledWith('Engine outbox delivery failed; pending events retained: Error code=40P01');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  } finally {
    await runtime.onModuleDestroy();
    warn.mockRestore();
    jest.useRealTimers();
  }
});

test('the relay logs how many game events it delivered, and nothing when there were none', async () => {
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const transaction = jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
  const runtime = new EngineRuntime({ transaction } as unknown as DataSource, {} as EngineService, { producer: { publish: jest.fn() } });
  try {
    expect(await runtime.flush()).toBe(3);
    expect(await runtime.flush()).toBe(0);
    expect(log.mock.calls).toEqual([['Relayed 3 game events']]);
  } finally { log.mockRestore(); }
});
