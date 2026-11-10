import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { PlayerCommand } from '@team5/contracts';
import { ComponentFactory } from '../src/modules/components/components';
import { CryptoPool } from '../src/modules/components/hash-pool';
import { room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import { transition } from '../src/modules/sessions/core/transition';
import type { Snapshot } from '../src/modules/sessions/core/state';

const worker = () => new Worker(path.resolve(__dirname, '../src/modules/components/crypto.worker.ts'),
  { execArgv: ['-r', 'ts-node/register/transpile-only'] });
const pool = new CryptoPool(2000, 1, worker);
const factory = new ComponentFactory(undefined, pool);
afterAll(() => pool.close());

const content = { script: room2Script(room1GameplayScript),
  templates: Object.fromEntries([...room1Templates, ...room2Templates()].map(t => [`${t.key}@${t.version}`, t])) };
const now = new Date('2026-11-10T10:00:00Z');
const sessionId = randomUUID(); const userId = randomUUID();
const command = <T extends PlayerCommand['type']>(type: T, payload: object) =>
  ({ type, messageId: randomUUID(), sessionId, payload: { userId, ...payload } }) as unknown as Extract<PlayerCommand, { type: T }>;
const solvedEval = { verdict: 'solved' as const, reason: null, output: '' };
const submit = (snap: Snapshot, puzzleKey: string, input: unknown, evaluation = solvedEval) =>
  transition(snap, command('SubmitInput', { puzzleKey, input }), content, now, evaluation);

const secret = { pms: '', clientRandom: room2Scenario.tls.clientRandomHex };
// The PMS is derived from the scenario's private key the same way the RSA task does.
const { createPrivateKey, privateDecrypt, constants } = require('node:crypto');
const block: Buffer = privateDecrypt({ key: createPrivateKey(room2Scenario.privateKeyPem), padding: constants.RSA_NO_PADDING },
  Buffer.from(room2Scenario.rsa.encryptedPmsHex, 'hex'));
secret.pms = block.subarray(block.indexOf(0, 2) + 1).toString('hex');
const good = { kind: 'tls', pms: secret.pms, clientRandom: secret.clientRandom };

function room2() {
  let snap = transition(null, command('StartSession', { scriptSlug: 'escape-room' }), content, now).next!;
  snap = submit(snap, 'dana-login', { kind: 'answer', answer: 'x' }).next!;
  snap = transition(snap, command('OpenDoor', { roomKey: 'room-1' }), content, now).next!;
  return transition(snap, command('EnterRoom', { roomKey: 'room-1' }), content, now);
}
const entered = room2();
let snap = entered.next!;
snap.puzzles.find(p => p.key === 'nethanel-git')!.sandbox = { status: 'ready', generation: 1 }; // R2-03: git commands need a ready sandbox
snap = submit(snap, 'nethanel-git', { kind: 'command', command: 'git log' }).next!;
const beforeEvents = [...entered.gameEvents];
snap = submit(snap, 'rsa-decryptor', { kind: 'rsa' }).next!;
const puzzle = snap.puzzles.find(p => p.key === 'tls-decryptor')!;
const template = content.templates[puzzle.templateRef];
const evaluate = (input: unknown, f = factory) => f.evaluate(template, snap, puzzle, 'command', input);

test('correct PMS and Client Random solve with the fixed output and a reveal', async () => {
  const result = await evaluate(good);
  expect(result).toMatchObject({ verdict: 'solved', reason: null, output: 'The file has been decrypted' });
  expect(result.output).not.toContain('4000000131941181');
  expect(Object.values(result.reveal as object)[0]).toContain(room2Scenario.cardNumber);
});

test('spacing, case and 0x prefix are normalized', async () => {
  const mangled = { ...good, pms: ` 0x${secret.pms.toUpperCase().replace(/(.{16})/g, '$1 \n')}`,
    clientRandom: room2Scenario.tls.clientRandomHex.toUpperCase().replace(/(.{2})/g, '$1:').slice(0, -1) };
  expect(await evaluate(mangled)).toMatchObject({ verdict: 'solved' });
});

test.each([
  ['wrong PMS', { pms: `${secret.pms.slice(0, -2)}${secret.pms.endsWith('00') ? '01' : '00'}` }],
  ['wrong client random', { clientRandom: room2Scenario.tls.serverRandomHex }],
])('%s is a wrong answer without reveal', async (_n, patch) => {
  expect(await evaluate({ ...good, ...patch })).toEqual({ verdict: 'rejected', reason: 'wrongAnswer', output: '' });
});

test.each([
  ['short PMS', { pms: 'abcd' }], ['non-hex PMS', { pms: 'z'.repeat(96) }], ['odd PMS', { pms: 'a'.repeat(95) }],
  ['long PMS', { pms: 'a'.repeat(98) }], ['short random', { clientRandom: 'ab' }], ['non-hex random', { clientRandom: 'g'.repeat(64) }],
  ['oversized', { pms: 'a'.repeat(5000) }], ['non-string', { pms: 5 }], ['extra field', { extra: 1 }],
])('%s is policy-blocked', async (_n, patch) => {
  expect(await evaluate({ ...good, ...patch })).toEqual({ verdict: 'rejected', reason: 'policyBlocked', output: '' });
});

test('solving applies the reveal, opens the door and no earlier event carries the capture or card number', async () => {
  const before = JSON.stringify(beforeEvents);
  expect(before).not.toContain(room2Scenario.cardNumber);
  expect(before).not.toContain('POST /api/v2/payments');
  expect(JSON.stringify(snap)).not.toContain(room2Scenario.cardNumber);
  const evaluation = await evaluate(good);
  const result = submit(snap, 'tls-decryptor', good, evaluation as any);
  const solved = result.gameEvents.find(e => e.type === 'PuzzleSolved')!;
  expect(JSON.stringify((solved.payload as any).files)).toContain(room2Scenario.cardNumber);
  expect(JSON.stringify(result.gameEvents.filter(e => e.type === 'CommandEvaluated'))).not.toContain(room2Scenario.cardNumber);
  expect(result.next!.puzzles.find(p => p.key === 'door')!.status).toBe('open');
});

test('logs never contain the PMS', async () => {
  const spies = (['warn', 'error', 'log'] as const).map(m => jest.spyOn(console, m).mockImplementation());
  const broken = new ComponentFactory(undefined, { compare: jest.fn(), tls: () => Promise.reject(new Error(secret.pms)) });
  try {
    expect(await evaluate(good, broken)).toMatchObject({ reason: 'sandboxRestarting' });
    expect(JSON.stringify(spies.map(s => s.mock.calls))).not.toContain(secret.pms);
  } finally { spies.forEach(s => s.mockRestore()); }
});
