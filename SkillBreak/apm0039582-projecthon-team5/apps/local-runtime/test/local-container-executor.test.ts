import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { SandboxExecutionError } from '../../game-engine/dist/modules/sandbox/sandbox-errors';
import { LocalContainerExecutor } from '../src/local-container-executor';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const commandId = '8c1f5a52-3d0b-4c7e-9f6a-2b4d1e0c9a71';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const request = { sessionId: 's', puzzleKey: 'idan-db', generation: 1, namespace: 'team5-sandboxes', podName: 'sbx',
  commandId, command: "SELECT password_hash FROM logs WHERE event='auth'" };
const helperResult = { version: 1, commandId, stdout: 'password_hash\nea7e95b6\n', stderr: '',
  exitCode: 0, timedOut: false, truncated: false };

interface FakeChild extends EventEmitter { stdin: PassThrough; stdout: PassThrough; kill: jest.Mock; input: Promise<string> }

function fakeExec(): FakeChild {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: jest.fn() });
  const chunks: Buffer[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  const input = new Promise<string>(resolve => child.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))));
  const fake = Object.assign(child, { input });
  jest.mocked(spawn).mockReturnValueOnce(fake as never);
  return fake;
}

function reply(child: FakeChild, output: string, code = 0): void {
  child.stdout.end(output);
  child.stdout.on('end', () => child.emit('close', code));
}

async function rejectionCode(work: Promise<unknown>): Promise<string> {
  const error = await work.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(SandboxExecutionError);
  return (error as SandboxExecutionError).code;
}

afterEach(() => { jest.useRealTimers(); jest.mocked(spawn).mockReset(); });

it('sends the query-mode helper JSON and returns the validated helper result', async () => {
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  reply(child, `${JSON.stringify(helperResult)}\n`);
  await expect(work).resolves.toEqual({ commandId, stdout: helperResult.stdout, stderr: '', exitCode: 0,
    timedOut: false, truncated: false });
  expect(spawn).toHaveBeenCalledWith('docker',
    ['exec', '-i', 'projecthon-team5-sql-sandbox-1', 'node', '/opt/sql/query-helper.mjs', 'query'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  const input = JSON.parse(await child.input);
  expect(Object.keys(input).sort()).toEqual(['command', 'commandId', 'executionToken', 'version']);
  expect(input).toMatchObject({ version: 1, commandId, command: request.command });
  expect(input.executionToken).toMatch(uuid);
});

it('passes a truncated helper result through unchanged', async () => {
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  const truncated = { ...helperResult, exitCode: null, truncated: true };
  reply(child, JSON.stringify(truncated));
  await expect(work).resolves.toEqual({ commandId, stdout: truncated.stdout, stderr: '', exitCode: null,
    timedOut: false, truncated: true });
});

it('uses a fresh UUID execution token for every query', async () => {
  const first = fakeExec();
  const second = fakeExec();
  const executor = new LocalContainerExecutor();
  const works = [executor.execute(request), executor.execute(request)];
  reply(first, JSON.stringify(helperResult));
  reply(second, JSON.stringify(helperResult));
  await Promise.all(works);
  const [a, b] = await Promise.all([first.input, second.input]).then(inputs => inputs.map(input => JSON.parse(input).executionToken));
  expect(a).toMatch(uuid);
  expect(b).toMatch(uuid);
  expect(a).not.toBe(b);
});

it('rejects malformed helper JSON with runtimeUnavailable', async () => {
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  reply(child, '{"version":1,');
  expect(await rejectionCode(work)).toBe('runtimeUnavailable');
});

it('rejects a non-zero helper exit with runtimeUnavailable', async () => {
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  reply(child, JSON.stringify(helperResult), 1);
  expect(await rejectionCode(work)).toBe('runtimeUnavailable');
});

it('rejects a missing docker binary with runtimeUnavailable', async () => {
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  child.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }));
  expect(await rejectionCode(work)).toBe('runtimeUnavailable');
});

it('rejects helper output over 64 KB with runtimeUnavailable', async () => {
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  reply(child, JSON.stringify({ ...helperResult, stdout: `password_hash\n${'a'.repeat(65536)}\n` }));
  expect(await rejectionCode(work)).toBe('runtimeUnavailable');
});

it('rejects a helper that runs longer than 5500 ms with runtimeUnavailable and stops it', async () => {
  jest.useFakeTimers();
  const child = fakeExec();
  const work = new LocalContainerExecutor().execute(request);
  jest.advanceTimersByTime(5499);
  expect(child.kill).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(await rejectionCode(work)).toBe('runtimeUnavailable');
  expect(child.kill).toHaveBeenCalled();
});
