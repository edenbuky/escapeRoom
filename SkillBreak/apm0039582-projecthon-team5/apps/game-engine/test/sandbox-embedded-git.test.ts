import { randomUUID } from 'node:crypto';
import { ComponentFactory } from '../src/modules/components/components';
import { EmbeddedDriver, embeddedImageDigest } from '../src/modules/sandbox/embedded-driver';
import { EmbeddedGit } from '../src/modules/sandbox/embedded-git';
import { room2GitPolicy } from '../src/modules/sandbox/git-command';
import { KubernetesDriver } from '../src/modules/sandbox/kubernetes-driver';
import type { ExecResult, ProvisionJob } from '../src/modules/sandbox/sandbox.contracts';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { isAllowedSeed } from '../src/modules/sandbox/sandbox-seeds';
import { validateHelperResult } from '../src/modules/sandbox/sql-result';
import type { ComponentTemplateDto, ScriptVersionDto } from '../src/modules/script-catalog/catalog.types';
import { room1Templates } from '../src/modules/script-catalog/room1';
import { room2GitImageDigest, room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import { room1GameplayScript } from '../src/modules/script-catalog/room1';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { transition } from '../src/modules/sessions/core/transition';
import { commandRejection } from '../src/modules/sessions/core/eligibility';

jest.setTimeout(60000);

const job = (): ProvisionJob => ({ ...sandboxIdentity(randomUUID(), 'nethanel-git', 1), jobId: randomUUID(),
  operation: 'provision', imageDigest: room2GitImageDigest(), seedRef: 'room2-git-v1', policyRef: 'nethanel-git@1' });

describe('embedded driver, git sandbox', () => {
  const driver = new EmbeddedDriver(undefined, 1500);
  const key = room2Scenario.privateKeyPem.trimEnd();
  afterAll(() => driver.onModuleDestroy());
  const query = async (sandbox: ProvisionJob, uid: string, command: string) => {
    const commandId = randomUUID();
    return validateHelperResult(await driver.helper(sandbox, uid, 'query', { executionToken: randomUUID(), commandId, command }), commandId, 'text');
  };

  test('accepts the pinned identity of the git fixture next to the SQL one, and nothing else', () => {
    expect(room2GitImageDigest()).toMatch(/^embedded\/room2-git@sha256:f6bcf0f1e6e78af8b0261ce9b27fc558ecb15b7e392ef25f012127e289200663$/);
    expect(() => driver.validateImage(room2GitImageDigest())).not.toThrow();
    expect(() => driver.validateImage(embeddedImageDigest())).not.toThrow();
    expect(() => driver.validateImage(`embedded/room2-git@sha256:${'a'.repeat(64)}`)).toThrow(SandboxExecutionError);
  });

  test('allowlists seed and template together', () => {
    expect(isAllowedSeed('room2-git-v1', 'nethanel-git@1')).toBe(true);
    expect(isAllowedSeed('room1-sql-v1', 'idan-db-sql@2')).toBe(true);
    expect(isAllowedSeed('room2-git-v1', 'idan-db-sql@2')).toBe(false);
    expect(isAllowedSeed('room1-sql-v1', 'nethanel-git@1')).toBe(false);
    expect(isAllowedSeed('constructor', 'nethanel-git@1')).toBe(false);
    expect(isAllowedSeed(null, 'nethanel-git@1')).toBe(false);
  });

  test('provisions, reports ready, solves with the key, restarts nothing between commands, and is destroyed', async () => {
    const sandbox = job();
    await expect(driver.ensure({ ...sandbox, policyRef: 'idan-db-sql@2' })).rejects.toMatchObject({ code: 'templateMismatch' });
    await expect(driver.ensure({ ...sandbox, imageDigest: `embedded/room2-git@sha256:${'b'.repeat(64)}` })).rejects.toMatchObject({ code: 'imageNotPinned' });
    const uid = (await driver.ensure(sandbox)).metadata!.uid!;
    expect(await driver.ensure(sandbox)).toEqual({ metadata: { uid }, status: { phase: 'Running' } });
    expect(await driver.helper(sandbox, uid, 'status', { probeSeed: true })).toEqual({ version: 1, seeded: true, seedRef: 'room2-git-v1' });
    expect(await driver.helper(sandbox, uid, 'ready')).toEqual({ version: 1, ready: true, seedRef: 'room2-git-v1' });

    const log = await query(sandbox, uid, 'git log --oneline');
    expect(log).toMatchObject({ exitCode: 0, stderr: '', timedOut: false, truncated: false });
    const shown = await query(sandbox, uid, 'git show HEAD~1:server.key');
    expect(shown.stdout).toContain(key);
    expect((await query(sandbox, uid, 'vim')).exitCode).toBe(126);

    await query(sandbox, uid, 'git commit --allow-empty -m "Ruin"');
    expect(await driver.helper(sandbox, uid, 'inspect')).toMatchObject({ version: 1, branch: 'main', headMessage: 'Ruin' });

    await driver.remove(sandbox, uid);
    expect(await driver.confirmAbsent(sandbox)).toBe(true);
    await expect(driver.helper(sandbox, uid, 'ready')).rejects.toMatchObject({ code: 'notReady' });
  });

  test('preflight verifies the git image through a throwaway sandbox', async () => {
    expect(await driver.preflight(room2GitImageDigest())).toMatchObject({ verified: true, embedded: true });
  });

  test('one execution token runs one command and is then quiesced', async () => {
    const sandbox = job();
    const uid = (await driver.ensure(sandbox)).metadata!.uid!;
    const executionToken = randomUUID();
    const input = { executionToken, commandId: randomUUID(), command: 'git log' };
    await driver.helper(sandbox, uid, 'query', input);
    await expect(driver.helper(sandbox, uid, 'query', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'runtimeUnavailable' });
    expect(await driver.helper(sandbox, uid, 'status', { executionToken })).toMatchObject({ quiesced: true });
    await driver.remove(sandbox, uid);
  });

  test('an overrunning command reports a timeout and the sandbox starts over', async () => {
    const slow = new EmbeddedGit(room2GitPolicy);
    const sandbox = job();
    const quick = new EmbeddedDriver(undefined, 1500, undefined, undefined, () => slow);
    const uid = (await quick.ensure(sandbox)).metadata!.uid!;
    jest.spyOn(slow, 'run').mockResolvedValueOnce('timeout');
    const commandId = randomUUID();
    const result = validateHelperResult(await quick.helper(sandbox, uid, 'query',
      { executionToken: randomUUID(), commandId, command: 'git log -p' }), commandId, 'text');
    expect(result).toMatchObject({ timedOut: true, exitCode: null, stderr: 'Command timed out.\n' });
    await quick.onModuleDestroy();
  });

  test('the Kubernetes driver leaves git unsupported, with a clear error', async () => {
    const kubernetes = new KubernetesDriver({ runtimeClass: 'runc', imageAllowlist: ['localhost:5001/room1-sql'] });
    expect(() => kubernetes.validateImage(room2GitImageDigest())).toThrow(/Kubernetes runtime does not support it/);
    await expect(kubernetes.ensure(job())).rejects.toMatchObject({ code: 'unsupportedSandbox' });
  });
});

describe('git terminal component and engine path', () => {
  const sqlV2: ComponentTemplateDto = { ...structuredClone(room1Templates[0]), version: 2 };
  const all = [...room1Templates, sqlV2, ...room2Templates()];
  const gameplay: ScriptVersionDto = structuredClone(room1GameplayScript);
  gameplay.states[0].puzzles[0].templateRef = 'idan-db-sql@2';
  gameplay.version = 4;
  const content = { script: room2Script(gameplay), templates: Object.fromEntries(all.map(template => [`${template.key}@${template.version}`, template])) };
  const git = room2Templates()[0];
  const now = new Date('2026-11-10T10:00:00Z');
  const sessionId = randomUUID();
  const userId = randomUUID();
  const key = room2Scenario.privateKeyPem.trimEnd();
  const message = (type: string, payload: object) => ({ type, messageId: randomUUID(), sessionId, payload: { userId, ...payload } }) as never;

  function room2() {
    let snapshot = transition(null, message('StartSession', { scriptSlug: 'escape-room' }), content, now).next!;
    snapshot = transition(snapshot, message('SubmitInput', { puzzleKey: 'dana-login', input: { kind: 'answer', answer: 'x' } }), content, now,
      { verdict: 'solved', reason: null, output: '' }).next!;
    snapshot = transition(snapshot, message('OpenDoor', { roomKey: 'room-1' }), content, now).next!;
    return transition(snapshot, message('EnterRoom', { roomKey: 'room-1' }), content, now);
  }

  test('entering Room 2 provisions the git sandbox from its own seed; commands wait for ready', () => {
    const entered = room2();
    const provision = entered.sandboxJobs.find(candidate => candidate.puzzleKey === 'nethanel-git');
    expect(provision).toMatchObject({ operation: 'provision', generation: 1, seedRef: 'room2-git-v1',
      policyRef: 'nethanel-git@1', imageDigest: room2GitImageDigest() });
    const puzzle = entered.next!.puzzles.find(candidate => candidate.key === 'nethanel-git')!;
    expect(puzzle.sandbox).toEqual({ status: 'provisioning', generation: 1 });
    expect(commandRejection(entered.next!, 'nethanel-git', now)).toBe('sandboxRestarting');
    const ready = transition(entered.next!, { type: 'SandboxOutcome', messageId: randomUUID(), sessionId,
      payload: { ...provision!, kind: 'ready', occurredAt: now.toISOString() } } as never, content, now);
    expect(ready.next!.puzzles.find(candidate => candidate.key === 'nethanel-git')!.sandbox.status).toBe('ready');
    expect(commandRejection(ready.next!, 'nethanel-git', now)).toBeUndefined();
  });

  test('ending the session destroys the git sandbox', () => {
    const entered = room2();
    const provision = entered.sandboxJobs.find(candidate => candidate.puzzleKey === 'nethanel-git')!;
    const ready = transition(entered.next!, { type: 'SandboxOutcome', messageId: randomUUID(), sessionId,
      payload: { ...provision, kind: 'ready', occurredAt: now.toISOString() } } as never, content, now).next!;
    const abandoned = transition(ready, message('AbandonSession', {}), content, now);
    expect(abandoned.sandboxJobs.map(candidate => [candidate.puzzleKey, candidate.operation])).toContainEqual(['nethanel-git', 'destroy']);
  });

  describe('evaluation', () => {
    const snapshot = room2().next!;
    const puzzle = snapshot.puzzles.find(candidate => candidate.key === 'nethanel-git')!;
    const execute = jest.fn<Promise<ExecResult>, [{ commandId: string; command: string }]>();
    const factory = new ComponentFactory({ execute }, { compare: jest.fn() });
    const run = (command: unknown, extra: object = {}) => factory.evaluate(git, snapshot, puzzle, 'c-1', { kind: 'command', command, ...extra });
    const respond = (stdout: string, extra: Partial<ExecResult> = {}) => execute.mockImplementationOnce(async ({ commandId }) =>
      ({ commandId, stdout, stderr: '', exitCode: 0, timedOut: false, truncated: false, ...extra }));
    beforeEach(() => execute.mockReset());

    test('solves only when the output holds the whole private key', async () => {
      respond(`${key}\n`);
      expect(await run('git show HEAD~1:server.key')).toEqual({ verdict: 'solved', reason: null, output: `${key}\n` });
      respond(key.split('\n').slice(0, 5).join('\n'));
      expect(await run('git show HEAD~1:server.key')).toMatchObject({ verdict: 'progress' });
      respond('abc def\n');
      expect(await run('git log --oneline')).toEqual({ verdict: 'progress', reason: null, output: 'abc def\n' });
    });

    test('blocked commands are rejected without reaching the sandbox', async () => {
      for (const line of ['vim', 'less x', 'curl http://a', 'git push', 'git log | cat', 'ls > x', 'ls; ls', 'ls && ls', '`ls`', '$(ls)']) {
        expect(await run(line)).toEqual({ verdict: 'rejected', reason: 'policyBlocked', output: '' });
      }
      expect(await factory.evaluate(git, snapshot, puzzle, 'c', { kind: 'command' })).toMatchObject({ reason: 'policyBlocked' });
      expect(await run('git log', { extra: 1 })).toMatchObject({ reason: 'policyBlocked' });
      expect(execute).not.toHaveBeenCalled();
    });

    test('shows stderr, reports a timeout as a restarting sandbox and passes busy through', async () => {
      respond('', { stderr: 'fatal: bad revision\n', exitCode: 128 });
      expect(await run('git show nope')).toEqual({ verdict: 'progress', reason: null, output: 'fatal: bad revision\n' });
      respond('', { stderr: 'Command timed out.\n', exitCode: null, timedOut: true });
      expect(await run('git log -p')).toEqual({ verdict: 'rejected', reason: 'sandboxRestarting', output: 'Command timed out.' });
      execute.mockRejectedValueOnce(new SandboxExecutionError('busy'));
      await expect(run('git log')).rejects.toMatchObject({ code: 'busy' });
      execute.mockRejectedValueOnce(new SandboxExecutionError('commandConflict'));
      expect(await run('git log')).toMatchObject({ reason: 'policyBlocked' });
    });
  });
});

test('git helper envelopes may be empty or free text; SQL framing stays strict', () => {
  const commandId = randomUUID();
  const envelope = { version: 1, commandId, stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
  expect(validateHelperResult(envelope, commandId, 'text')).toMatchObject({ exitCode: 0 });
  expect(validateHelperResult({ ...envelope, stdout: 'a b\tc\r\n' }, commandId, 'text')).toMatchObject({ stdout: 'a b\tc\r\n' });
  expect(() => validateHelperResult(envelope, commandId)).toThrow(SandboxExecutionError);
  expect(() => validateHelperResult({ ...envelope, stdout: 'x\r\n' }, commandId)).toThrow(SandboxExecutionError);
});
