import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { PlayerCommand } from '@team5/contracts';
import { ComponentFactory } from '../src/modules/components/components';
import { CryptoPool } from '../src/modules/components/hash-pool';
import { EmbeddedDriver, embeddedImageDigest } from '../src/modules/sandbox/embedded-driver';
import type { ExecRequest, ExecResult, ProvisionJob, RepositoryState, SandboxExecutor, SandboxIdentity, SandboxJobRequest } from '../src/modules/sandbox/sandbox.contracts';
import { validateHelperResult } from '../src/modules/sandbox/sql-result';
import type { ComponentTemplateDto } from '../src/modules/script-catalog/catalog.types';
import { ROOM1, room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import { commandRejection } from '../src/modules/sessions/core/eligibility';
import type { Snapshot } from '../src/modules/sessions/core/state';
import { transition } from '../src/modules/sessions/core/transition';

// The whole game, Start to Escaped, on the real catalog v5 content and without a database:
// real transition + ComponentFactory, the embedded SQL/git sandboxes, and the real crypto worker pool.
jest.setTimeout(120000);

const worker = () => new Worker(path.resolve(__dirname, '../src/modules/components/crypto.worker.ts'),
  { execArgv: ['-r', 'ts-node/register/transpile-only'] });
const pool = new CryptoPool(5000, 1, worker);
const driver = new EmbeddedDriver();

/** Catalog v5 as publishRoom2 publishes it: gameplay v4 (SQL template 2 on the embedded image) plus Room 2. */
const sqlV2: ComponentTemplateDto = { ...structuredClone(room1Templates[0]), version: 2 } as ComponentTemplateDto;
(sqlV2.definition as { imageDigest: string }).imageDigest = embeddedImageDigest();
const v4 = structuredClone(room1GameplayScript);
v4.version = 4;
v4.states[0].puzzles[0].templateRef = 'idan-db-sql@2';
const content = { script: room2Script(v4),
  templates: Object.fromEntries([...room1Templates, sqlV2, ...room2Templates()].map(t => [`${t.key}@${t.version}`, t])) };

/** Worker stand-in: provisions and destroys through the real embedded driver, and executes commands in the live sandboxes. */
class LocalSandboxes implements SandboxExecutor {
  readonly live = new Map<string, { job: ProvisionJob; uid: string }>();
  readonly destroyed: string[] = [];
  async provision(job: ProvisionJob) { this.live.set(job.podName, { job, uid: (await driver.ensure(job)).metadata!.uid! }); }
  async destroy(job: SandboxIdentity) {
    const entry = this.live.get(job.podName);
    if (!entry) return;
    await driver.remove(entry.job, entry.uid);
    this.live.delete(job.podName);
    this.destroyed.push(job.podName);
  }
  async execute(request: ExecRequest): Promise<ExecResult> {
    const { job, uid } = this.live.get(request.podName)!;
    return validateHelperResult(await driver.helper(job, uid, 'query', { executionToken: randomUUID(), commandId: request.commandId,
      command: request.command }), request.commandId, job.seedRef === 'room2-git-v1' ? 'text' : undefined);
  }
  async inspect(identity: SandboxIdentity): Promise<RepositoryState> {
    const { job, uid } = this.live.get(identity.podName)!;
    const state = await driver.helper(job, uid, 'inspect') as RepositoryState;
    return { head: state.head, branch: state.branch ?? null, branchTip: state.branchTip, headInHistory: state.headInHistory,
      keyCommitPresent: state.keyCommitPresent };
  }
}
const sandboxes = new LocalSandboxes();
const factory = new ComponentFactory(sandboxes, pool);
afterAll(async () => { for (const { job } of [...sandboxes.live.values()]) await sandboxes.destroy(job); await driver.onModuleDestroy(); await pool.close(); });

const userId = randomUUID();
const sessionId = randomUUID();
let clock = new Date('2026-11-10T10:00:00Z');
let snapshot: Snapshot | null = null;
const events: { type: string; payload: any }[] = [];
const jobsSeen: SandboxJobRequest[] = [];
let queue: SandboxJobRequest[] = [];

const message = (type: string, payload: object) => ({ type, messageId: randomUUID(), sessionId, payload: { userId, ...payload } }) as unknown as PlayerCommand;
const puzzle = (key: string) => snapshot!.puzzles.find(p => p.key === key)!;
const lastResult = (key: string) => puzzle(key).latestResult as { verdict: string; reason: string | null; output: string } | undefined;

/** What the engine service does for one command, then what the sandbox worker does for the jobs it queued. */
async function play(command: PlayerCommand) {
  clock = new Date(clock.getTime() + 1000);
  let evaluation;
  if (command.type === 'SubmitInput' && snapshot && !commandRejection(snapshot, command.payload.puzzleKey, clock)) {
    const target = puzzle(command.payload.puzzleKey);
    evaluation = await factory.evaluate(content.templates[target.templateRef], snapshot, target, command.messageId, command.payload.input);
  }
  const result = transition(snapshot, command, content, clock, evaluation);
  events.push(...(result.gameEvents as unknown as typeof events));
  snapshot = result.next ?? snapshot;
  queue.push(...result.sandboxJobs);
  jobsSeen.push(...result.sandboxJobs);
  return result;
}
async function runWorker() {
  while (queue.length) {
    const job = queue.shift()!;
    if (job.operation === 'provision') await sandboxes.provision(job); else await sandboxes.destroy(job);
    const outcome = { type: 'SandboxOutcome', messageId: randomUUID(), sessionId,
      payload: { ...job, kind: job.operation === 'provision' ? 'ready' : 'destroyed', occurredAt: clock.toISOString() } } as never;
    const result = transition(snapshot, outcome, content, clock);
    events.push(...(result.gameEvents as unknown as typeof events));
    snapshot = result.next ?? snapshot;
  }
}
const answer = (puzzleKey: string, value: string) => message('SubmitInput', { puzzleKey, input: { kind: 'answer', answer: value } });
const run = (command: string) => message('SubmitInput', { puzzleKey: 'nethanel-git', input: { kind: 'command', command } });

test('Room 1: SQL, hash cracker, Dana login, the door, and Room 2 starts with its git sandbox', async () => {
  await play(message('StartSession', { scriptSlug: 'escape-room' }));
  await runWorker();
  expect(snapshot).toMatchObject({ status: 'Active', roomKey: 'room-1', scriptVersion: 5 });
  expect(puzzle('idan-db').sandbox.status).toBe('ready');

  await play(message('SubmitInput', { puzzleKey: 'idan-db', input: { kind: 'command', command:
    `SELECT l.password_hash FROM logs l JOIN employees e ON e.id = l.employee_id WHERE e.username = '${ROOM1.danaUsername}' AND l.password_hash IS NOT NULL` } }));
  expect(puzzle('idan-db').status).toBe('solved');
  await play(answer('hash-cracker', ROOM1.danaPasswordSha256));
  expect(lastResult('hash-cracker')).toMatchObject({ verdict: 'solved', output: ROOM1.danaPassword });
  await play(message('SubmitInput', { puzzleKey: 'dana-login', input: { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword } }));
  expect(puzzle('dana-login').status).toBe('solved');

  await play(message('EnterRoom', { roomKey: 'room-1' }));
  expect(snapshot!.roomKey).toBe('room-1'); // the door is not open yet
  await play(message('OpenDoor', { roomKey: 'room-1' }));
  await play(message('EnterRoom', { roomKey: 'room-1' }));
  await runWorker();
  expect(snapshot).toMatchObject({ roomKey: 'room-2', visitedRooms: ['room-1', 'room-2'] });
  expect(puzzle('nethanel-git')).toMatchObject({ status: 'open', sandbox: { status: 'ready', generation: 1 } });
  expect(puzzle('rsa-decryptor').status).toBe('locked');
});

test('Room 2 git: history, blocked editor, a ruin resets to a pristine generation 2, then the key is recovered', async () => {
  await play(run('git log --oneline'));
  const log = lastResult('nethanel-git')!;
  expect(log.verdict).toBe('progress');
  expect(log.output.trim().split('\n')).toHaveLength(5);
  expect(log.output.split('\n')[0]).toContain('Security fix: Removed private key from repository.');

  await play(run('vim server.key'));
  expect(lastResult('nethanel-git')).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });

  const ruin = await play(run('git commit --allow-empty -m oops'));
  await runWorker();
  expect(ruin.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated', 'PuzzleReset']);
  expect(lastResult('nethanel-git')).toMatchObject({ verdict: 'ruined' });
  expect(puzzle('nethanel-git')).toMatchObject({ status: 'open', sandbox: { status: 'ready', generation: 2 } });
  expect(snapshot!.status).toBe('Active');
  expect(sandboxes.destroyed).toHaveLength(1); // generation 1 is gone, generation 2 is live
  await play(run('git log --oneline'));
  expect(lastResult('nethanel-git')!.output.trim().split('\n')).toHaveLength(5); // pristine again, no "oops"
  expect(lastResult('nethanel-git')!.output).not.toContain('oops');

  await play(run('git show HEAD~1:server.key'));
  expect(lastResult('nethanel-git')).toMatchObject({ verdict: 'solved' });
  expect(lastResult('nethanel-git')!.output).toContain(room2Scenario.privateKeyPem.trimEnd());
  expect(puzzle('nethanel-git').status).toBe('solved');
  expect(puzzle('rsa-decryptor').status).toBe('open');
});

test('RSA, TLS (the reveal), door code, OpenDoor, EnterRoom end in Escaped with every sandbox destroyed', async () => {
  const before = JSON.stringify(events);
  expect(before).not.toContain(room2Scenario.cardNumber);
  expect(before).not.toContain('POST /api/v2/payments');

  await play(message('SubmitInput', { puzzleKey: 'rsa-decryptor', input: { kind: 'rsa', privateKey: room2Scenario.privateKeyPem,
    encryptedPms: room2Scenario.rsa.encryptedPmsHex, modulus: room2Scenario.rsa.modulusHex } }));
  const pms = lastResult('rsa-decryptor')!;
  expect(pms).toMatchObject({ verdict: 'solved', output: room2Scenario.rsa.expectedPmsHex });
  expect(pms.output).toMatch(/^0303[0-9a-f]{92}$/);
  expect(puzzle('tls-decryptor').status).toBe('open');
  expect(JSON.stringify(events)).not.toContain(room2Scenario.cardNumber);

  const eventsBeforeTls = events.length;
  await play(message('SubmitInput', { puzzleKey: 'tls-decryptor', input: { kind: 'tls', pms: pms.output, clientRandom: room2Scenario.tls.clientRandomHex } }));
  expect(lastResult('tls-decryptor')).toMatchObject({ verdict: 'solved', output: 'The file has been decrypted' });
  const solvedTls = events.slice(eventsBeforeTls).find(e => e.type === 'PuzzleSolved')!;
  expect(JSON.stringify(solvedTls.payload.files)).toContain(room2Scenario.cardNumber);
  expect(puzzle('door').status).toBe('open');
  // No earlier event carried the card number, and no command result ever did.
  expect(JSON.stringify(events.slice(0, eventsBeforeTls))).not.toContain(room2Scenario.cardNumber);
  expect(JSON.stringify(events.filter(e => e.type === 'CommandEvaluated'))).not.toContain(room2Scenario.cardNumber);

  await play(answer('door', '4000000131941182'));
  expect(lastResult('door')).toMatchObject({ verdict: 'rejected', reason: 'wrongAnswer' });
  expect(puzzle('door').status).toBe('open');
  await play(message('EnterRoom', { roomKey: 'room-2' }));
  expect(snapshot!.status).toBe('Active'); // not before the door is solved and opened
  await play(answer('door', room2Scenario.cardNumber));
  expect(puzzle('door').status).toBe('solved');
  await play(message('OpenDoor', { roomKey: 'room-2' }));
  await play(message('EnterRoom', { roomKey: 'room-2' }));
  await runWorker();

  expect(snapshot).toMatchObject({ status: 'Escaped', roomKey: 'room-2', endedAt: clock.toISOString() });
  expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['DoorOpened', 'SessionEscaped']));
  expect(sandboxes.live.size).toBe(0);
  const provisioned = jobsSeen.filter(j => j.operation === 'provision').map(j => j.podName);
  expect([...sandboxes.destroyed].sort()).toEqual([...provisioned].sort());
  expect(provisioned).toHaveLength(3); // SQL, git generation 1, git generation 2
});

test('the private key reached the player only through the git output; the card number only through the TLS reveal', () => {
  const key = 'BEGIN RSA PRIVATE KEY';
  const carriers = events.filter(e => e.type === 'CommandEvaluated' && JSON.stringify(e.payload).includes(key));
  expect(carriers).toHaveLength(1);
  expect(carriers[0].payload).toMatchObject({ puzzleKey: 'nethanel-git', result: { verdict: 'solved' } });
  expect(JSON.stringify(events.filter(e => e.type !== 'CommandEvaluated'))).not.toContain(key);
});
