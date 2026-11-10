import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PlayerCommand, PuzzleInput } from '@team5/contracts';
import { ComponentFactory } from '../src/modules/components/components';
import { room as projectedRoom } from '../src/modules/projection/projection.reducer';
import type { ComponentTemplateDto, ScriptVersionDto } from '../src/modules/script-catalog/catalog.types';
import { room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { ROOM2_FILE, ROOM2_HINTS, ROOM2_TEMPLATE_REFS, room2GitFixture, room2GitImageDigest, room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import { transition } from '../src/modules/sessions/core/transition';

// The generator and verifier are plain Node scripts so they run offline without a build.
const generator = require('../../../scripts/room2/generate') as { buildScenario(): { artifacts: { path: string; content: string }[] } };
const verifier = require('../../../scripts/room2/verify') as {
  verifyScenario(input: { fixtureBytes: Buffer; scenario: typeof room2Scenario }): string[];
  loadCommitted(): { fixtureBytes: Buffer; scenario: typeof room2Scenario };
};

const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value));

function gameplayV4(): ScriptVersionDto {
  const script = structuredClone(room1GameplayScript);
  script.version = 4;
  script.states[0].puzzles[0].templateRef = 'idan-db-sql@2';
  return script;
}

function secrets(): string[] {
  const body = room2Scenario.privateKeyPem.split('\n').filter(line => line && !line.startsWith('-----'));
  return [room2Scenario.cardNumber, room2Scenario.rsa.expectedPmsHex, body[1], 'PRIVATE KEY', 'card_number', 'Decrypted Application Data'];
}

describe('Room 2 generator and chain verification', () => {
  test('regeneration is byte-identical to the committed artifacts', () => {
    const first = generator.buildScenario().artifacts;
    const second = generator.buildScenario().artifacts;
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    for (const artifact of first) expect(readFileSync(artifact.path, 'utf8')).toBe(artifact.content);
  });

  test('the committed chain verifies end to end: git key, certificate, PMS, TLS records, Luhn card', () => {
    const checks = verifier.verifyScenario(verifier.loadCommitted());
    expect(checks).toHaveLength(5);
    expect(checks.join('\n')).toContain('Security fix: Removed private key from repository.');
  });

  test.each([
    ['a card number that fails Luhn', (scenario: typeof room2Scenario) => { scenario.cardNumber = '4000000131941182'; }],
    ['a different PMS', (scenario: typeof room2Scenario) => { scenario.rsa.expectedPmsHex = `${scenario.rsa.expectedPmsHex.slice(0, -2)}00`; }],
    ['a corrupted record', (scenario: typeof room2Scenario) => { const hex = scenario.tls.records[2].fragmentHex; scenario.tls.records[2].fragmentHex = `${hex.slice(0, -2)}00`; }],
    ['a modulus that is not the certificate key', (scenario: typeof room2Scenario) => { scenario.rsa.modulusHex = `0${scenario.rsa.modulusHex.slice(1)}`; }],
    ['a leaked card number in the encrypted capture', (scenario: typeof room2Scenario) => { scenario.captureEncrypted += scenario.cardNumber; }],
  ])('verification fails for %s', (_name, tamper) => {
    const { fixtureBytes, scenario } = verifier.loadCommitted();
    const broken = clone(scenario);
    tamper(broken);
    expect(() => verifier.verifyScenario({ fixtureBytes, scenario: broken })).toThrow('Room 2 scenario check failed');
  });

  test.each([
    ['a changed latest message', (git: { commits: { message: string }[] }) => { git.commits[git.commits.length - 1].message = 'Fix'; }],
    ['a key that is only in HEAD~2', (git: { commits: { files: Record<string, string> }[] }) => { delete git.commits[git.commits.length - 2].files['server.key']; }],
  ])('git verification fails for %s', (_name, tamper) => {
    const { fixtureBytes, scenario } = verifier.loadCommitted();
    const git = JSON.parse(fixtureBytes.toString('utf8'));
    tamper(git);
    expect(() => verifier.verifyScenario({ fixtureBytes: Buffer.from(JSON.stringify(git)), scenario })).toThrow('Room 2 scenario check failed');
  });
});

describe('Room 2 templates and script v5', () => {
  const templates = room2Templates();
  const byKey = Object.fromEntries(templates.map(template => [template.key, template]));

  test('pins the git template to the embedded identity of the committed fixture', () => {
    const digest = createHash('sha256').update(readFileSync(room2GitFixture)).digest('hex');
    expect(room2GitImageDigest()).toBe(`embedded/room2-git@sha256:${digest}`);
    expect(room2GitFixture).toBe(path.resolve(__dirname, '../../../sandboxes/git/fixtures/room2-git-v1.json'));
    expect(room2GitImageDigest()).toMatch(/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/);
    const git = byKey['nethanel-git'];
    expect(git).toMatchObject({ version: 1, family: 'sandbox', engine: 'terminal-git',
      definition: { imageDigest: room2GitImageDigest(), seedRef: 'room2-git-v1',
        invariants: { branch: 'main', headMessage: 'Security fix: Removed private key from repository.', keyPath: 'server.key' } } });
  });

  test('defines version-1 templates with the seeds the later tasks need', () => {
    expect(templates.map(template => `${template.key}@${template.version}`))
      .toEqual(['nethanel-git@1', 'rsa-decryptor@1', 'tls-decryptor@1', 'nathanel-door@1']);
    expect(byKey['rsa-decryptor']).toMatchObject({ family: 'input', engine: 'rsa', definition: { seed: {
      modulusHex: room2Scenario.rsa.modulusHex, publicExponent: 65537, encryptedPmsHex: room2Scenario.rsa.encryptedPmsHex,
      expectedPmsHex: room2Scenario.rsa.expectedPmsHex } } });
    expect(byKey['tls-decryptor']).toMatchObject({ family: 'input', engine: 'tls', definition: { seed: {
      cipherSuite: 'TLS_RSA_WITH_AES_128_GCM_SHA256', clientRandomHex: room2Scenario.tls.clientRandomHex,
      serverRandomHex: room2Scenario.tls.serverRandomHex, decryptedCapture: room2Scenario.captureDecrypted } } });
    expect(byKey['nathanel-door']).toMatchObject({ family: 'input', engine: 'answer', definition: { seed: { fields: { answer: room2Scenario.cardNumber } } } });
    expect(room2Scenario.cardNumber).toMatch(/^\d{16}$/);
  });

  test('input schemas match the frozen PuzzleInput contracts', () => {
    const inputs: PuzzleInput[] = [
      { kind: 'command', command: 'git log' },
      { kind: 'rsa', privateKey: 'k', encryptedPms: 'e', modulus: 'n' },
      { kind: 'tls', pms: 'p', clientRandom: 'c' },
      { kind: 'answer', answer: room2Scenario.cardNumber },
    ];
    for (const [index, input] of inputs.entries()) {
      const schema = templates[index].definition.inputSchema;
      expect(schema.required).toEqual(Object.keys(input));
      expect(Object.keys(schema.properties as object)).toEqual(Object.keys(input));
      expect(schema.properties).toMatchObject({ kind: { const: input.kind } });
      expect(schema.additionalProperties).toBe(false);
    }
  });

  test('v5 keeps Room 1 as catalog 4 has it and adds the Room 2 puzzles, file, door data and final state', () => {
    const v4 = gameplayV4();
    const frozen = structuredClone(v4);
    const v5 = room2Script(v4);
    expect(v4).toEqual(frozen);
    expect(v5).toMatchObject({ scriptId: 'escape-room', version: 5, durationMinutes: 45, initialState: 'room-1', finalStates: ['escaped'] });
    expect(v5.states.map(state => state.key)).toEqual(['room-1', 'room-2', 'escaped']);
    const { door: room1Door, ...room1 } = v5.states[0];
    expect(room1).toEqual(v4.states[0]);
    expect(room1.puzzles[0].templateRef).toBe('idan-db-sql@2');
    expect(room1Door).toEqual({ to: 'room-2', unlockedBy: 'dana-login' });
    const room2 = v5.states[1];
    expect(room2.puzzles).toEqual([
      { key: 'nethanel-git', templateRef: ROOM2_TEMPLATE_REFS['nethanel-git'], opensAfter: [], onRuin: 'resetPuzzle' },
      { key: 'rsa-decryptor', templateRef: 'rsa-decryptor@1', opensAfter: ['nethanel-git'], onRuin: 'resetPuzzle', hint: ROOM2_HINTS['rsa-decryptor'] },
      { key: 'tls-decryptor', templateRef: 'tls-decryptor@1', opensAfter: ['rsa-decryptor'], onRuin: 'resetPuzzle', hint: ROOM2_HINTS['tls-decryptor'] },
      { key: 'door', templateRef: 'nathanel-door@1', opensAfter: ['tls-decryptor'], onRuin: 'resetPuzzle', hint: ROOM2_HINTS.door },
    ]);
    expect(room2.files).toEqual([{ name: ROOM2_FILE, content: room2Scenario.captureEncrypted, revealedBy: 'tls-decryptor' }]);
    expect(room2.door).toEqual({ to: 'escaped', unlockedBy: 'door' });
    expect(v5.states[2]).toEqual({ key: 'escaped', files: [], puzzles: [], transitions: [] });
  });

  test('hint wording is the DESIGN-v2 text', () => {
    const design = readFileSync(path.resolve(__dirname, '../../../DESIGN-v2.md'), 'utf8');
    for (const hint of Object.values(ROOM2_HINTS)) expect(design).toContain(`"${hint}"`);
  });

  test('refuses a baseline that is not catalog 4 with an empty room 2', () => {
    const populated = gameplayV4();
    populated.states[1].files = [{ name: 'x', content: 'y' }];
    expect(() => room2Script(populated)).toThrow('catalog 4 baseline');
  });

  test('the script holds only the encrypted capture; secrets live in the templates', () => {
    const script = JSON.stringify(room2Script(gameplayV4()));
    for (const secret of secrets()) expect(script).not.toContain(secret);
    const encrypted = room2Scenario.captureEncrypted;
    for (const visible of [room2Scenario.tls.clientRandomHex, room2Scenario.rsa.modulusHex, room2Scenario.rsa.encryptedPmsHex]) {
      expect(encrypted).toContain(visible);
    }
    for (const secret of secrets()) expect(encrypted).not.toContain(secret);
    expect(room2Scenario.captureDecrypted).toContain(room2Scenario.cardNumber);
  });
});

describe('a new v5 session entering Room 2', () => {
  const sqlV2: ComponentTemplateDto = { ...structuredClone(room1Templates[0]), version: 2 };
  const all = [...room1Templates, sqlV2, ...room2Templates()];
  const content = { script: room2Script(gameplayV4()), templates: Object.fromEntries(all.map(template => [`${template.key}@${template.version}`, template])) };
  const now = new Date('2026-11-10T10:00:00Z');
  const sessionId = randomUUID();
  const userId = randomUUID();
  const command = <Type extends PlayerCommand['type']>(type: Type, payload: object) =>
    ({ type, messageId: randomUUID(), sessionId, payload: { userId, ...payload } }) as unknown as Extract<PlayerCommand, { type: Type }>;

  function enterRoom2() {
    let snapshot = transition(null, command('StartSession', { scriptSlug: 'escape-room' }), content, now).next!;
    const started = transition(null, command('StartSession', { scriptSlug: 'escape-room' }), content, now).gameEvents;
    snapshot = transition(snapshot, command('SubmitInput', { puzzleKey: 'dana-login', input: { kind: 'answer', answer: 'x' } }), content, now,
      { verdict: 'solved', reason: null, output: '' }).next!;
    snapshot = transition(snapshot, command('OpenDoor', { roomKey: 'room-1' }), content, now).next!;
    const entered = transition(snapshot, command('EnterRoom', { roomKey: 'room-1' }), content, now);
    return { snapshot: entered.next!, events: [...started, ...entered.gameEvents] };
  }

  test('opens nethanel-git, keeps the other three locked and sends only the encrypted file', () => {
    const { snapshot, events } = enterRoom2();
    expect(snapshot.roomKey).toBe('room-2');
    expect(snapshot.puzzles.filter(puzzle => puzzle.roomKey === 'room-2').map(puzzle => [puzzle.key, puzzle.status])).toEqual([
      ['nethanel-git', 'open'], ['rsa-decryptor', 'locked'], ['tls-decryptor', 'locked'], ['door', 'locked']]);
    const entered = events.find(event => event.type === 'RoomEntered')!;
    const view = projectedRoom((entered.payload as { room: unknown }).room);
    expect(view.files).toEqual([{ name: ROOM2_FILE, content: room2Scenario.captureEncrypted }]);
    expect(view.puzzles.map(puzzle => puzzle.family)).toEqual(['terminal-git', 'rsa', 'tls', 'answer']);
    const serialized = JSON.stringify(view) + JSON.stringify(events.filter(event => event.type === 'SessionStarted'));
    for (const secret of secrets()) expect(serialized).not.toContain(secret);
  });

  test('malformed rsa and tls inputs are policy-blocked; git runs in its sandbox', async () => {
    const { snapshot } = enterRoom2();
    const factory = new ComponentFactory(undefined, { compare: jest.fn() });
    const git = snapshot.puzzles.find(candidate => candidate.key === 'nethanel-git')!;
    const gitInput = (command: string) => factory.evaluate(content.templates[git.templateRef], snapshot, git, 'command', { kind: 'command', command });
    expect(await gitInput('vim')).toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
    expect(await gitInput('git log')).toMatchObject({ verdict: 'rejected', reason: 'sandboxRestarting' }); // no sandbox executor in this factory
    const inputs: [string, unknown][] = [
      ['rsa-decryptor', { kind: 'rsa', privateKey: 'k', encryptedPms: 'e', modulus: 'n' }],
      ['tls-decryptor', { kind: 'tls', pms: 'p', clientRandom: 'c' }]];
    for (const [key, input] of inputs) {
      const puzzle = snapshot.puzzles.find(candidate => candidate.key === key)!;
      expect(await factory.evaluate(content.templates[puzzle.templateRef], snapshot, puzzle, 'command', input))
        .toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
    }
  });
});
