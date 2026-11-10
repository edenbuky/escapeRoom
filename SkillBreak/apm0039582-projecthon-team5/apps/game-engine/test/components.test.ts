import { Worker } from 'node:worker_threads';
import { Logger } from '@nestjs/common';
import path from 'node:path';
import { ComponentFactory } from '../src/modules/components/components';
import { HashPool } from '../src/modules/components/hash-pool';
import { room1Script, room1Templates, ROOM1 } from '../src/modules/script-catalog/room1';
import { transition } from '../src/modules/sessions/core/transition';
import type { ComponentTemplateDto } from '../src/modules/script-catalog/catalog.types';

const content = { script: room1Script, templates: Object.fromEntries(room1Templates.map(template => [`${template.key}@${template.version}`, template])) };
const snapshot = transition(null, { type: 'StartSession', sessionId: 'session', messageId: 'command',
  payload: { userId: 'owner', scriptSlug: 'escape-room' } }, content, new Date()).next!;
const [sql, hash, answer] = room1Templates;
const execute = jest.fn();
const compare = jest.fn();
const factory = new ComponentFactory({ execute }, { compare });
const evaluate = (template: ComponentTemplateDto, input: unknown) => factory.evaluate(template, snapshot, snapshot.puzzles[0], 'command', input);
beforeEach(() => { execute.mockReset(); compare.mockReset(); });

test.each([
  [sql, null], [sql, []], [sql, { kind: 'command', command: 'SELECT 1', extra: true }],
  [sql, { kind: 'command', command: '' }], [sql, { kind: 'command', command: 'x'.repeat(4097) }],
  [sql, { kind: 'command', command: 123 }], [hash, { kind: 'answer', answer: 'ab' }],
  [hash, { kind: 'answer', answer: ' '.repeat(65) + ROOM1.danaPasswordSha256 }],
  [answer, { kind: 'credentials', username: ROOM1.danaUsername }],
  [answer, { kind: 'credentials', username: ROOM1.danaUsername, password: null }],
  [answer, { kind: 'credentials', username: ROOM1.danaUsername, password: 'x'.repeat(257) }],
] as [ComponentTemplateDto, unknown][])('rejects malformed input before execution (%#)', async (template, input) => {
  expect(await evaluate(template, input)).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
  expect(execute).not.toHaveBeenCalled();
  expect(compare).not.toHaveBeenCalled();
});

test('blocks multiple SQL statements, permits literal semicolons and propagates stable execution identity', async () => {
  expect(await evaluate(sql, { kind: 'command', command: 'SELECT 1; SELECT 2' })).toMatchObject({ reason: 'policyBlocked' });
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValue({ commandId: 'command', stdout: ROOM1.danaPasswordSha256, stderr: '', exitCode: 0, timedOut: false, truncated: false });
  expect(await evaluate(sql, { kind: 'command', command: "SELECT ';'; -- comment" })).toMatchObject({ verdict: 'solved' });
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'command', generation: 1, sessionId: snapshot.id }));
});

test('SQL exact-cell goal does not accept substrings, errors, timeouts or truncation', async () => {
  const response = { commandId: 'command', stdout: ROOM1.danaPasswordSha256, stderr: '', exitCode: 0, timedOut: false, truncated: false };
  for (const override of [{ stdout: `prefix-${ROOM1.danaPasswordSha256}` }, { exitCode: 1 }, { truncated: true }, { timedOut: true }, { commandId: 'wrong' }]) {
    execute.mockResolvedValue({ ...response, ...override });
    expect((await evaluate(sql, { kind: 'command', command: 'SELECT 1' })).verdict).not.toBe('solved');
  }
  execute.mockRejectedValue(new Error('private executor details'));
  expect(await evaluate(sql, { kind: 'command', command: 'SELECT 1' })).toEqual({ verdict: 'rejected', reason: 'sandboxRestarting', output: '' });
});

test('normalizes hash input and only reveals the password after successful evaluation', async () => {
  compare.mockResolvedValue(true);
  expect(await evaluate(hash, { kind: 'answer', answer: ` ${ROOM1.danaPasswordSha256.toUpperCase()} ` }))
    .toEqual({ verdict: 'solved', reason: null, output: ROOM1.danaPassword });
  compare.mockResolvedValue(false);
  expect(await evaluate(hash, { kind: 'answer', answer: '0'.repeat(64) })).toMatchObject({ reason: 'wrongAnswer', output: '' });
});

test('credential comparison ignores username case but not password case', async () => {
  expect(await evaluate(answer, { kind: 'credentials', username: ' DANAZ22 ', password: ROOM1.danaPassword })).toMatchObject({ verdict: 'solved' });
  expect(await evaluate(answer, { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword.toUpperCase() }))
    .toMatchObject({ verdict: 'rejected', reason: 'wrongAnswer' });
});

test('evaluation failures are logged by error name and code, never the answer, SQL or message', async () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  try {
    execute.mockRejectedValue(Object.assign(new Error(`private ${ROOM1.danaPassword}`), { code: 'ECONNREFUSED' }));
    expect(await evaluate(sql, { kind: 'command', command: "SELECT password FROM users WHERE name = 'danaz22'" }))
      .toEqual({ verdict: 'rejected', reason: 'sandboxRestarting', output: '' });
    expect(error.mock.calls).toEqual([['SQL executor unavailable: Error code=ECONNREFUSED']]);
    compare.mockRejectedValue(new Error(`timeout ${ROOM1.danaPasswordSha256}`));
    expect(await evaluate(hash, { kind: 'answer', answer: ROOM1.danaPasswordSha256 }))
      .toEqual({ verdict: 'rejected', reason: 'sandboxRestarting', output: '' });
    expect(warn.mock.calls).toEqual([['Hash comparison failed: Error']]);
    const logged = JSON.stringify([error.mock.calls, warn.mock.calls]);
    for (const secret of [ROOM1.danaPassword, ROOM1.danaPasswordSha256, 'SELECT', 'private', 'timeout']) expect(logged).not.toContain(secret);
  } finally { error.mockRestore(); warn.mockRestore(); }
});

test('hash worker recovers after timeout and closes all workers', async () => {
  let first = true;
  const pool = new HashPool(5000, 1, () => {
    if (first) { first = false; return new Worker('setInterval(() => {}, 1000)', { eval: true }); }
    return new Worker(path.resolve(__dirname, '../src/modules/components/hash.worker.ts'), { execArgv: ['-r', 'ts-node/register/transpile-only'] });
  });
  try {
    await expect(pool.compare('00', '00')).rejects.toThrow('timeout');
    await expect(pool.compare(ROOM1.danaPasswordSha256, ROOM1.danaPasswordSha256)).resolves.toBe(true);
    await expect(pool.compare('00', 'ff')).resolves.toBe(false);
  } finally { await pool.close(); }
  await expect(pool.compare('00', '00')).rejects.toThrow('unavailable');
}, 15_000);