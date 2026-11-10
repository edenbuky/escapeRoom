import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { EngineRuntime } from '../src/modules/sessions/engine-runtime';
import type { EngineService } from '../src/modules/sessions/engine.service';
import { TerminalLogger } from '../src/terminal-logger';

test('terminal logs honor forced color and explicit NO_COLOR', () => {
  const previousForce = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;
  const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    process.env.FORCE_COLOR = '1'; delete process.env.NO_COLOR;
    const logger = new TerminalLogger('Gameplay');
    logger.warn('safe verdict');
    expect(write.mock.calls.map(call => String(call[0])).join('')).toMatch(/\u001b\[/);
    write.mockClear(); process.env.NO_COLOR = '1';
    logger.warn('safe verdict');
    expect(write.mock.calls.map(call => String(call[0])).join('')).not.toMatch(/\u001b\[/);
  } finally {
    if (previousForce === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previousForce;
    if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor;
    write.mockRestore();
  }
});

test('outbox delivery failures are logged by name and code, never the message', async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const runtime = new EngineRuntime({} as DataSource, { expireDue: jest.fn().mockResolvedValue(undefined) } as unknown as EngineService, { producer: { publish: jest.fn() } });
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

test('expires offline sessions at startup and periodically, then stops on shutdown', async () => {
  jest.useFakeTimers();
  const expireDue = jest.fn().mockResolvedValue(undefined);
  const runtime = new EngineRuntime({} as DataSource, { expireDue } as unknown as EngineService);
  try {
    runtime.onApplicationBootstrap();
    expect(expireDue).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(expireDue).toHaveBeenCalledTimes(3);
    await runtime.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3000);
    expect(expireDue).toHaveBeenCalledTimes(3);
  } finally { await runtime.onModuleDestroy(); jest.useRealTimers(); }
});
