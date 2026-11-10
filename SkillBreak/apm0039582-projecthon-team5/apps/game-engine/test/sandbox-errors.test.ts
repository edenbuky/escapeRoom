import { Logger } from '@nestjs/common';
import { ComponentFactory } from '../src/modules/components/components';
import { room1Script, room1Templates, ROOM1 } from '../src/modules/script-catalog/room1';
import { transition } from '../src/modules/sessions/core/transition';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';

const templates = Object.fromEntries(room1Templates.map(template => [`${template.key}@${template.version}`, template]));
const snapshot = transition(null, { type: 'StartSession', messageId: 'message', sessionId: 'session',
  payload: { userId: 'owner', scriptSlug: 'escape-room' } }, { script: room1Script, templates }, new Date()).next!;
const execute = jest.fn();
const factory = new ComponentFactory({ execute }, { compare: jest.fn() });
const template = room1Templates[0];
const evaluate = (command = 'SELECT 1') => factory.evaluate(template, snapshot, snapshot.puzzles[0], 'command',
  { kind: 'command', command });
beforeEach(() => execute.mockReset());
afterEach(() => jest.restoreAllMocks());

test('syntax and statement policy remain distinguishable without starting SQL', async () => {
  expect(await evaluate('SELECT FROM')).toMatchObject({ verdict: 'progress', output: expect.stringContaining('syntax') });
  expect(await evaluate('SELECT 1; SELECT 2')).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
  expect(execute).not.toHaveBeenCalled();
});
test.each(['busy', 'inProgress'] as const)('%s escapes before engine inbox accounting', async code => {
  execute.mockRejectedValue(new SandboxExecutionError(code));
  await expect(evaluate()).rejects.toMatchObject({ code });
});
test.each(['interrupted', 'expired', 'staleGeneration', 'runtimeUnavailable'] as const)('%s maps to a safe, explicit existing rejection', async code => {
  execute.mockRejectedValue(new SandboxExecutionError(code));
  expect(await evaluate()).toEqual({ verdict: 'rejected', reason: 'sandboxRestarting', output: new SandboxExecutionError(code).message });
});
test('timeout, truncation and database failures cannot solve even when output contains the goal', async () => {
  const result = { commandId: 'command', stdout: `v\n${ROOM1.danaPasswordSha256}\n`, stderr: '',
    exitCode: 0, timedOut: false, truncated: false };
  for (const override of [{ timedOut: true, exitCode: null }, { truncated: true }, { exitCode: 1, stderr: 'SQL operation is not permitted.\n' }]) {
    execute.mockResolvedValue({ ...result, ...override });
    const outcome = await evaluate();
    expect(outcome.verdict).not.toBe('solved');
    expect(outcome.output).not.toBe('');
    expect(Buffer.byteLength(outcome.output)).toBeLessThanOrEqual(65536);
  }
});
test('unexpected infrastructure failures are logged without raw input or private details', async () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  execute.mockRejectedValue(new Error('private credential; SELECT password FROM employees'));
  expect(await evaluate()).toMatchObject({ verdict: 'rejected', reason: 'sandboxRestarting' });
  expect(error).toHaveBeenCalled();
  expect(JSON.stringify(error.mock.calls)).not.toMatch(/credential|password|employees/);
});
