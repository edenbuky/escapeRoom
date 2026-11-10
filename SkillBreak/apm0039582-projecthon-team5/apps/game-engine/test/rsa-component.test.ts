import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { PlayerCommand } from '@team5/contracts';
import { ComponentFactory } from '../src/modules/components/components';
import { CryptoPool } from '../src/modules/components/hash-pool';
import { room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import type { ComponentTemplateDto } from '../src/modules/script-catalog/catalog.types';
import { transition } from '../src/modules/sessions/core/transition';

const worker = () => new Worker(path.resolve(__dirname, '../src/modules/components/crypto.worker.ts'),
  { execArgv: ['-r', 'ts-node/register/transpile-only'] });
const pool = new CryptoPool(2000, 1, worker);
const factory = new ComponentFactory(undefined, pool);
afterAll(() => pool.close());

const sqlV2: ComponentTemplateDto = { ...structuredClone(room1Templates[0]), version: 2 };
const v4 = structuredClone(room1GameplayScript);
v4.version = 4;
v4.states[0].puzzles[0].templateRef = 'idan-db-sql@2';
const templates = [...room1Templates, sqlV2, ...room2Templates()];
const content = { script: room2Script(v4), templates: Object.fromEntries(templates.map(template => [`${template.key}@${template.version}`, template])) };
const now = new Date('2026-11-10T10:00:00Z');
const sessionId = randomUUID();
const userId = randomUUID();
const command = <Type extends PlayerCommand['type']>(type: Type, payload: object) =>
  ({ type, messageId: randomUUID(), sessionId, payload: { userId, ...payload } }) as unknown as Extract<PlayerCommand, { type: Type }>;
const solved = { verdict: 'solved' as const, reason: null, output: '' };

function room2() {
  let snapshot = transition(null, command('StartSession', { scriptSlug: 'escape-room' }), content, now).next!;
  snapshot = transition(snapshot, command('SubmitInput', { puzzleKey: 'dana-login', input: { kind: 'answer', answer: 'x' } }), content, now, solved).next!;
  snapshot = transition(snapshot, command('OpenDoor', { roomKey: 'room-1' }), content, now).next!;
  return transition(snapshot, command('EnterRoom', { roomKey: 'room-1' }), content, now).next!;
}
const snapshot = room2();
const puzzle = snapshot.puzzles.find(candidate => candidate.key === 'rsa-decryptor')!;
const template = content.templates[puzzle.templateRef];
const evaluate = (input: unknown, f = factory) => f.evaluate(template, snapshot, puzzle, 'command', input);
const good = { kind: 'rsa', privateKey: room2Scenario.privateKeyPem, encryptedPms: room2Scenario.rsa.encryptedPmsHex, modulus: room2Scenario.rsa.modulusHex };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

test('correct key, encrypted PMS and N solve with the PMS hex as output', async () => {
  expect(await evaluate(good)).toEqual({ verdict: 'solved', reason: null, output: room2Scenario.rsa.expectedPmsHex });
});

test('keys with CRLF or surrounding whitespace and N in any case/spacing still round-trip', async () => {
  const mangled = { ...good, privateKey: `\n  ${room2Scenario.privateKeyPem.replace(/\n/g, '\r\n')}\n\n`,
    modulus: ` ${room2Scenario.rsa.modulusHex.toUpperCase().replace(/(.{32})/g, '$1 \n')} `,
    encryptedPms: ` ${room2Scenario.rsa.encryptedPmsHex.toUpperCase()}\n` };
  expect(await evaluate(mangled)).toMatchObject({ verdict: 'solved', output: room2Scenario.rsa.expectedPmsHex });
});

test.each([
  ['wrong key', { privateKey: other }],
  ['wrong N', { modulus: `${room2Scenario.rsa.modulusHex.slice(0, -2)}00` }],
  ['wrong encrypted PMS', { encryptedPms: `${room2Scenario.rsa.encryptedPmsHex.slice(0, -2)}00` }],
])('%s is a wrong answer', async (_name, patch) => {
  expect(await evaluate({ ...good, ...patch })).toEqual({ verdict: 'rejected', reason: 'wrongAnswer', output: '' });
});

test.each([
  ['garbage key', { privateKey: 'not a key' }],
  ['public-key PEM', { privateKey: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' }],
  ['truncated PEM', { privateKey: room2Scenario.privateKeyPem.slice(0, 200) }],
  ['non-hex PMS', { encryptedPms: 'zz' }], ['odd-length PMS', { encryptedPms: 'abc' }], ['non-hex N', { modulus: 'xyz' }],
  ['oversized hex', { modulus: 'a'.repeat(8193) }], ['oversized key', { privateKey: 'a'.repeat(8193) }],
  ['empty key', { privateKey: '  ' }], ['non-string field', { modulus: 5 }], ['extra field', { extra: 1 }],
])('%s is policy-blocked', async (_name, patch) => {
  expect(await evaluate({ ...good, ...patch })).toEqual({ verdict: 'rejected', reason: 'policyBlocked', output: '' });
});

test('a key larger than 4096 bits is policy-blocked', async () => {
  const big = generateKeyPairSync('rsa', { modulusLength: 4104 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  expect(await evaluate({ ...good, privateKey: big })).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
}, 60_000);

test('a worker that overruns the limit is replaced, the result is unavailable and later tasks still work', async () => {
  let first = true;
  const hung = new CryptoPool(300, 1, () => first && !(first = false) ? new Worker('setInterval(() => {}, 1000)', { eval: true }) : worker());
  try {
    const started = Date.now();
    expect(await evaluate(good, new ComponentFactory(undefined, hung))).toEqual({ verdict: 'rejected', reason: 'sandboxRestarting', output: '' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await evaluate(good, new ComponentFactory(undefined, hung))).toMatchObject({ verdict: 'solved' });
  } finally { await hung.close(); }
}, 20_000);

test('the bounded queue refuses work instead of growing', async () => {
  const stuck = new CryptoPool(60_000, 1, () => new Worker('setInterval(() => {}, 1000)', { eval: true }));
  try {
    const pending = Array.from({ length: 101 }, () => stuck.compare('00', '00').catch(() => undefined));
    await expect(stuck.compare('00', '00')).rejects.toThrow('unavailable');
    void pending;
  } finally { await stuck.close(); }
}, 20_000);

test('logs never contain the private key or the PMS', async () => {
  const spies = (['warn', 'error', 'log'] as const).map(method => jest.spyOn(console, method).mockImplementation());
  const broken = new ComponentFactory(undefined, { compare: jest.fn(), rsa: () => Promise.reject(new Error(room2Scenario.privateKeyPem)) });
  try {
    expect(await evaluate(good, broken)).toMatchObject({ reason: 'sandboxRestarting' });
    const logged = JSON.stringify(spies.map(spy => spy.mock.calls));
    expect(logged).not.toContain('PRIVATE KEY');
    expect(logged).not.toContain(room2Scenario.rsa.expectedPmsHex);
  } finally { spies.forEach(spy => spy.mockRestore()); }
});

test('catalog opens rsa-decryptor only after nethanel-git and solving it opens tls-decryptor', () => {
  const status = (s: typeof snapshot, key: string) => s.puzzles.find(candidate => candidate.key === key)!.status;
  expect(status(snapshot, 'rsa-decryptor')).toBe('locked');
  expect(status(snapshot, 'nethanel-git')).toBe('open');
  snapshot.puzzles.find(p => p.key === 'nethanel-git')!.sandbox = { status: 'ready', generation: 1 }; // R2-03: git commands need a ready sandbox
  const afterGit = transition(snapshot, command('SubmitInput', { puzzleKey: 'nethanel-git', input: { kind: 'command', command: 'git log' } }),
    content, now, solved).next!;
  expect(status(afterGit, 'rsa-decryptor')).toBe('open');
  expect(status(afterGit, 'tls-decryptor')).toBe('locked');
  const afterRsa = transition(afterGit, command('SubmitInput', { puzzleKey: 'rsa-decryptor', input: good }), content, now, solved).next!;
  expect(status(afterRsa, 'tls-decryptor')).toBe('open');
});
