import { randomUUID } from 'node:crypto';
import type { PlayerCommand } from '@team5/contracts';
import { ComponentFactory } from '../src/modules/components/components';
import { EmbeddedGit } from '../src/modules/sandbox/embedded-git';
import { failedGitInvariant } from '../src/modules/sandbox/git-invariants';
import { room2GitPolicy } from '../src/modules/sandbox/git-command';
import type { ExecResult, RepositoryState } from '../src/modules/sandbox/sandbox.contracts';
import { reduceProjection } from '../src/modules/projection/projection.reducer';
import { room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { commandRejection } from '../src/modules/sessions/core/eligibility';
import type { Snapshot } from '../src/modules/sessions/core/state';
import { transition } from '../src/modules/sessions/core/transition';

jest.setTimeout(60000);

const templates = Object.fromEntries([...room1Templates, ...room2Templates('sha256:test')].map(t => [`${t.key}@${t.version}`, t]));
const v4 = structuredClone(room1GameplayScript);
v4.version = 4;
const content = { script: room2Script(v4), templates };
const git = room2Templates('sha256:test')[0] as Extract<ReturnType<typeof room2Templates>[number], { engine: 'terminal-git' }>;
const sessionId = randomUUID();
const userId = randomUUID();
const t0 = new Date('2026-11-10T10:00:00Z');
const later = new Date(t0.getTime() + 60000);
const solved = { verdict: 'solved' as const, reason: null, output: '' };
const ruinedEval = { verdict: 'ruined' as const, reason: null, output: '[main abc1234] x\n', invariant: 'headUnchanged' };
const msg = (type: string, payload: object, messageId = randomUUID()) => ({ type, messageId, sessionId, payload: { userId, ...payload } }) as never;
const gitCommand = (command: string, messageId = randomUUID()) =>
  msg('SubmitInput', { puzzleKey: 'nethanel-git', input: { kind: 'command', command } }, messageId) as Extract<PlayerCommand, { type: 'SubmitInput' }>;

/** A v5 session standing in Room 2 with the git sandbox ready at generation 1. */
function gitReady() {
  let snapshot = transition(null, msg('StartSession', { scriptSlug: 'escape-room' }), content, t0).next!;
  snapshot = transition(snapshot, msg('SubmitInput', { puzzleKey: 'dana-login', input: { kind: 'answer', answer: 'x' } }), content, t0, solved).next!;
  snapshot = transition(snapshot, msg('OpenDoor', { roomKey: 'room-1' }), content, t0).next!;
  const entered = transition(snapshot, msg('EnterRoom', { roomKey: 'room-1' }), content, t0);
  const provision = entered.sandboxJobs.find(job => job.puzzleKey === 'nethanel-git')!;
  const ready = transition(entered.next!, { type: 'SandboxOutcome', messageId: randomUUID(), sessionId,
    payload: { ...provision, kind: 'ready', occurredAt: t0.toISOString() } } as never, content, t0);
  return ready.next!;
}
const gitPuzzle = (snapshot: Snapshot) => snapshot.puzzles.find(p => p.key === 'nethanel-git')!;

describe('git invariants on a real sandbox', () => {
  const sandbox = new EmbeddedGit(room2GitPolicy);
  afterAll(() => sandbox.close());
  const run = (command: string) => sandbox.run({ type: 'run', command, limit: 65536 }, 5000);
  const state = async () => (await sandbox.run({ type: 'inspect' }, 5000)) as unknown as RepositoryState;
  const failed = async () => failedGitInvariant(await state(), git.definition.invariants);

  test('a pristine repository, and reading the old revision, keep every invariant', async () => {
    expect(await failed()).toBeUndefined();
    await run('git checkout HEAD~1');
    expect(await failed()).toBeUndefined();
    await run('git checkout main');
    expect(await failed()).toBeUndefined();
  });

  test('a new commit, a reset and a commit off the branch are detected', async () => {
    await run('git commit --allow-empty -m x');
    expect(await failed()).toBe('headUnchanged');
    await run('git reset --hard HEAD~1');
    expect(await failed()).toBeUndefined();
    await run('git reset --hard HEAD~1');
    expect(await failed()).toBe('headUnchanged');
  });

  test('a commit on a detached HEAD breaks no-new-commits', async () => {
    const fresh = new EmbeddedGit(room2GitPolicy);
    try {
      await fresh.run({ type: 'run', command: 'git checkout HEAD~1', limit: 65536 }, 5000);
      await fresh.run({ type: 'run', command: 'git commit --allow-empty -m detached', limit: 65536 }, 5000);
      const repo = await fresh.run({ type: 'inspect' }, 5000) as unknown as RepositoryState;
      expect(failedGitInvariant(repo, git.definition.invariants)).toBe('noNewCommits');
    } finally { await fresh.close(); }
  });
});

describe('ruin verdict from the git component', () => {
  const snapshot = gitReady();
  const puzzle = gitPuzzle(snapshot);
  const pristine: RepositoryState = { head: git.definition.invariants.headOid, branch: 'main', branchTip: git.definition.invariants.headOid,
    headInHistory: true, keyCommitPresent: true };
  const build = (repo: RepositoryState | Error) => {
    const execute = jest.fn(async ({ commandId }: { commandId: string }): Promise<ExecResult> =>
      ({ commandId, stdout: 'out\n', stderr: '', exitCode: 0, timedOut: false, truncated: false }));
    const inspect = jest.fn(async () => { if (repo instanceof Error) throw repo; return repo; });
    return { factory: new ComponentFactory({ execute, inspect }, { compare: jest.fn() }), inspect };
  };
  const evaluate = (factory: ComponentFactory) => factory.evaluate(git, snapshot, puzzle, 'c', { kind: 'command', command: 'git log' });

  test('an intact repository gives progress; a broken one gives ruined with the invariant name', async () => {
    const ok = build(pristine);
    expect(await evaluate(ok.factory)).toEqual({ verdict: 'progress', reason: null, output: 'out\n' });
    expect(ok.inspect).toHaveBeenCalledWith(sandboxIdentity(sessionId, 'nethanel-git', 1));
    expect(await evaluate(build({ ...pristine, branchTip: 'f'.repeat(40) }).factory))
      .toEqual({ verdict: 'ruined', reason: null, output: 'out\n', invariant: 'headUnchanged' });
  });

  test('an unavailable probe rejects with sandboxRestarting instead of passing the command', async () => {
    expect(await evaluate(build(new Error('boom')).factory)).toMatchObject({ verdict: 'rejected', reason: 'sandboxRestarting' });
  });
});

describe('resetPuzzle in transition', () => {
  test('ruin: generation+1, destroy old, provision new, puzzle open, PuzzleReset, session and clock untouched', () => {
    const ready = gitReady();
    const command = gitCommand('git commit --allow-empty -m x');
    const result = transition(ready, command, content, later, ruinedEval);
    const puzzle = gitPuzzle(result.next!);
    expect(result.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated', 'PuzzleReset']);
    expect(result.gameEvents[0]).toMatchObject({ payload: { result: { verdict: 'ruined', reason: null, commandId: command.messageId } } });
    expect(JSON.stringify(result.gameEvents)).not.toContain('headUnchanged');
    expect(result.gameEvents[1]).toMatchObject({ payload: { scope: 'puzzle', roomKey: 'room-2',
      puzzle: { key: 'nethanel-git', status: 'open', sandbox: { status: 'provisioning', generation: 2 } } } });
    expect(puzzle).toMatchObject({ status: 'open', sandbox: { status: 'provisioning', generation: 2 }, attempts: 1 });
    expect(result.sandboxJobs.map(job => [job.operation, job.generation])).toEqual([['destroy', 1], ['provision', 2]]);
    expect(result.sandboxJobs[1]).toMatchObject({ seedRef: 'room2-git-v1', policyRef: 'nethanel-git@1' });
    expect(result.sandboxJobs[0].podName).not.toBe(result.sandboxJobs[1].podName);
    expect(result.next).toMatchObject({ status: 'Active', deadlineAt: ready.deadlineAt, endedAt: null });
    expect(result.next!.puzzles.filter(p => p.roomKey === 'room-2' && p.key !== 'nethanel-git').map(p => p.status))
      .toEqual(['locked', 'locked', 'locked']);
  });

  test('old-generation commands are rejected while the new sandbox starts; old outcomes are ignored; new ready reopens', () => {
    const ready = gitReady();
    const reset = transition(ready, gitCommand('git commit --allow-empty -m x'), content, later, ruinedEval);
    expect(commandRejection(reset.next!, 'nethanel-git', later)).toBe('sandboxRestarting');
    const rejected = transition(reset.next!, gitCommand('git log'), content, later, undefined);
    expect(rejected.gameEvents[0]).toMatchObject({ payload: { result: { verdict: 'rejected', reason: 'sandboxRestarting' } } });
    expect(rejected.sandboxJobs).toEqual([]);
    const [destroy, provision] = reset.sandboxJobs;
    const outcome = (job: typeof destroy, kind: 'ready' | 'destroyed') => ({ type: 'SandboxOutcome', messageId: randomUUID(), sessionId,
      payload: { ...job, kind, occurredAt: later.toISOString() } }) as never;
    expect(transition(reset.next!, outcome(destroy, 'destroyed'), content, later).changed).toBe(false);
    expect(transition(reset.next!, outcome({ ...destroy }, 'ready'), content, later).changed).toBe(false);
    const up = transition(reset.next!, outcome(provision, 'ready'), content, later);
    expect(gitPuzzle(up.next!).sandbox).toEqual({ status: 'ready', generation: 2 });
    expect(up.gameEvents.map(e => e.type)).toEqual(['PuzzleOpened']);
    expect(commandRejection(up.next!, 'nethanel-git', later)).toBeUndefined();
  });

  test('redelivery of the ruining command (same commandId) does not reset twice', () => {
    const ready = gitReady();
    const command = gitCommand('git commit --allow-empty -m x');
    const first = transition(ready, command, content, later, ruinedEval);
    const again = transition(first.next!, command, content, later, ruinedEval);
    expect(again.sandboxJobs).toEqual([]);
    expect(again.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated']);
    expect(gitPuzzle(again.next!).sandbox.generation).toBe(2);
  });

  test('a ruin on an already solved git puzzle resets the sandbox but keeps it solved', () => {
    const ready = gitReady();
    gitPuzzle(ready).status = 'solved';
    const result = transition(ready, gitCommand('git commit --allow-empty -m x'), content, later, ruinedEval);
    expect(gitPuzzle(result.next!)).toMatchObject({ status: 'solved', sandbox: { generation: 2, status: 'provisioning' } });
    expect(result.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated', 'PuzzleReset']);
  });

  test('input families never reset: a stray ruined verdict is only recorded', () => {
    const ready = gitReady();
    ready.puzzles.find(p => p.key === 'rsa-decryptor')!.status = 'open';
    const result = transition(ready, msg('SubmitInput', { puzzleKey: 'rsa-decryptor',
      input: { kind: 'rsa', privateKey: 'k', encryptedPms: 'e', modulus: 'n' } }), content, later, ruinedEval);
    expect(result.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated']);
    expect(result.sandboxJobs).toEqual([]);
  });

  test('projection applies PuzzleReset, ignores older versions logic by version, and refuses a regression', () => {
    const events = [] as unknown[];
    let snapshot = null as Snapshot | null;
    const feed = (result: ReturnType<typeof transition>) => { events.push(...result.gameEvents); snapshot = result.next; };
    feed(transition(null, msg('StartSession', { scriptSlug: 'escape-room' }), content, t0));
    feed(transition(snapshot, msg('SubmitInput', { puzzleKey: 'dana-login', input: { kind: 'answer', answer: 'x' } }), content, t0, solved));
    feed(transition(snapshot, msg('OpenDoor', { roomKey: 'room-1' }), content, t0));
    const entered = transition(snapshot, msg('EnterRoom', { roomKey: 'room-1' }), content, t0);
    feed(entered);
    const provision = entered.sandboxJobs.find(job => job.puzzleKey === 'nethanel-git')!;
    feed(transition(snapshot, { type: 'SandboxOutcome', messageId: randomUUID(), sessionId,
      payload: { ...provision, kind: 'ready', occurredAt: t0.toISOString() } } as never, content, t0));
    const reset = transition(snapshot, gitCommand('git commit --allow-empty -m x'), content, later, ruinedEval);
    let record: any = null;
    for (const event of [...events, ...reset.gameEvents]) {
      const next = reduceProjection(record, event);
      record = { ownerId: next.ownerId, view: next.view, version: (event as { sessionVersion: number }).sessionVersion, revision: '1' };
    }
    const view = record.view.currentRoom.puzzles.find((p: { key: string }) => p.key === 'nethanel-git');
    expect(view).toMatchObject({ status: 'open', sandbox: { generation: 2, status: 'provisioning' },
      latestResult: { verdict: 'ruined' } });
    const stale = structuredClone(reset.gameEvents[1]) as any;
    expect(() => reduceProjection(record, stale)).toThrow('regression');
  });

  test('escaping destroys the live git sandbox (regression)', () => {
    const ready = gitReady();
    ready.puzzles.forEach(p => { if (p.roomKey === 'room-2') p.status = 'solved'; });
    ready.puzzles[0].sandbox = { status: 'none', generation: 1 };
    const opened = transition(ready, msg('OpenDoor', { roomKey: 'room-2' }), content, later);
    const escaped = transition(opened.next!, msg('EnterRoom', { roomKey: 'room-2' }), content, later);
    expect(escaped.next!.status).toBe('Escaped');
    expect(escaped.sandboxJobs).toContainEqual(expect.objectContaining({ operation: 'destroy',
      ...sandboxIdentity(sessionId, 'nethanel-git', 1) }));
  });
});
