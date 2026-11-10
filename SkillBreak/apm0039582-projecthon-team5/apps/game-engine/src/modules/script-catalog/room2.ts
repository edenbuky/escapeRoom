import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ComponentTemplateDto, PuzzleDef, ScriptVersionDto } from './catalog.types';
import { gitRepositoryDir, room2GitPolicy } from '../sandbox/git-command';
import { room2Scenario } from './room2-scenario.generated';

export const ROOM2_SCRIPT_VERSION = 5;
export const ROOM2_FILE = 'Cibus_payment_try.pcap';
export const ROOM2_TEMPLATE_REFS = {
  'nethanel-git': 'nethanel-git@1',
  'rsa-decryptor': 'rsa-decryptor@1',
  'tls-decryptor': 'tls-decryptor@1',
  door: 'nathanel-door@1',
} as const;

// DESIGN-v2 section 13, "Hints in the Demo". Hint texts only; there is no hint mechanism yet.
export const ROOM2_HINTS = {
  'rsa-decryptor': 'Nathaniel says the private key was removed. Git remembers what came before. With the key, the RSA decryptor also needs two values from the capture: the encrypted PMS from the Client Key Exchange, and N from the certificate.',
  'tls-decryptor': 'The TLS decryptor needs the PMS you just got and the Client Random. The start of the capture, before the Client Key Exchange, is not encrypted.',
  door: 'Open the capture on Nathaniel\'s computer again: it is decrypted now. Look in the Application Data for his Cibus payment. What does the door code look like?',
} as const;

/** The git history lives in a committed fixture served by the embedded runtime (docs/adr/0001-embedded-sandbox-driver.md). */
export const room2GitFixture = path.resolve(__dirname, '../../../../../sandboxes/git/fixtures/room2-git-v1.json');

/** Pinned identity of the embedded git runtime: the content digest of the fixture it serves (no image exists). */
export function room2GitImageDigest(fixturePath = room2GitFixture): string {
  return `embedded/room2-git@sha256:${createHash('sha256').update(readFileSync(fixturePath)).digest('hex')}`;
}

function commandSchema(): Record<string, unknown> {
  return { type: 'object', required: ['kind', 'command'], additionalProperties: false,
    properties: { kind: { const: 'command' }, command: { type: 'string', minLength: 1, maxLength: 4096 } } };
}

export function room2Templates(imageDigest = room2GitImageDigest()): ComponentTemplateDto[] {
  const git = JSON.parse(readFileSync(room2GitFixture, 'utf8')) as { branch: string; keyPath: string; commits: { oid: string; message: string }[] };
  const head = git.commits[git.commits.length - 1];
  const keyCommit = git.commits[git.commits.length - 2];
  return [
    { key: 'nethanel-git', version: 1, family: 'sandbox', engine: 'terminal-git', definition: {
      imageDigest, seedRef: 'room2-git-v1',
      policy: { ...room2GitPolicy, allowedCommands: [...room2GitPolicy.allowedCommands],
        allowedGitSubcommands: [...room2GitPolicy.allowedGitSubcommands] },
      goal: { type: 'resultContains', value: room2Scenario.privateKeyPem.trimEnd() },
      // R2-04 detects a ruined repository by comparing the sandbox's HEAD with headOid (the `inspect` helper reports it).
      // The key is readable at keyRevision (the last commit that still has it); the goal is the whole PEM in the output.
      invariants: { branch: git.branch, headOid: head.oid, headMessage: head.message, keyCommitOid: keyCommit.oid,
        keyPath: git.keyPath, keyRevision: 'HEAD~1', workingDirectory: gitRepositoryDir },
      inputSchema: commandSchema(),
    } },
    { key: 'rsa-decryptor', version: 1, family: 'input', engine: 'rsa', definition: {
      seed: { ...room2Scenario.rsa },
      inputSchema: { type: 'object', required: ['kind', 'privateKey', 'encryptedPms', 'modulus'], additionalProperties: false,
        properties: { kind: { const: 'rsa' }, privateKey: { type: 'string', minLength: 1, maxLength: 4096 },
          encryptedPms: { type: 'string', minLength: 1, maxLength: 1024 }, modulus: { type: 'string', minLength: 1, maxLength: 1024 } } },
    } },
    { key: 'tls-decryptor', version: 1, family: 'input', engine: 'tls', definition: {
      seed: { cipherSuite: room2Scenario.tls.cipherSuite, cipherSuiteId: room2Scenario.tls.cipherSuiteId,
        clientRandomHex: room2Scenario.tls.clientRandomHex, serverRandomHex: room2Scenario.tls.serverRandomHex,
        records: room2Scenario.tls.records.map(entry => ({ ...entry, direction: entry.direction as 'client' | 'server' })),
        decryptedCapture: room2Scenario.captureDecrypted },
      inputSchema: { type: 'object', required: ['kind', 'pms', 'clientRandom'], additionalProperties: false,
        properties: { kind: { const: 'tls' }, pms: { type: 'string', minLength: 1, maxLength: 256 },
          clientRandom: { type: 'string', minLength: 1, maxLength: 256 } } },
    } },
    { key: 'nathanel-door', version: 1, family: 'input', engine: 'answer', definition: {
      seed: { fields: { answer: room2Scenario.cardNumber } },
      inputSchema: { type: 'object', required: ['kind', 'answer'], additionalProperties: false,
        properties: { kind: { const: 'answer' }, answer: { type: 'string', minLength: 1, maxLength: 128 } } },
    } },
  ];
}

/** Script v5 = the current gameplay catalog (v4) with the Room 2 content added; Room 1 is kept as it is. */
export function room2Script(gameplay: ScriptVersionDto): ScriptVersionDto {
  const script = structuredClone(gameplay);
  const room1 = script.states.find(state => state.key === 'room-1');
  const room2 = script.states.find(state => state.key === 'room-2');
  if (!room1 || !room2 || room2.puzzles.length > 0 || room2.files.length > 0) throw new Error('Gameplay script is not the expected catalog 4 baseline');
  const puzzle = (key: keyof typeof ROOM2_TEMPLATE_REFS, opensAfter: string[], hint?: string): PuzzleDef =>
    ({ key, templateRef: ROOM2_TEMPLATE_REFS[key], opensAfter, onRuin: 'resetPuzzle', ...(hint ? { hint } : {}) });
  script.version = ROOM2_SCRIPT_VERSION;
  script.finalStates = ['escaped'];
  room1.door = { to: 'room-2', unlockedBy: 'dana-login' };
  room2.files = [{ name: ROOM2_FILE, content: room2Scenario.captureEncrypted, revealedBy: 'tls-decryptor' }];
  room2.puzzles = [
    puzzle('nethanel-git', []),
    puzzle('rsa-decryptor', ['nethanel-git'], ROOM2_HINTS['rsa-decryptor']),
    puzzle('tls-decryptor', ['rsa-decryptor'], ROOM2_HINTS['tls-decryptor']),
    puzzle('door', ['tls-decryptor'], ROOM2_HINTS.door),
  ];
  room2.door = { to: 'escaped', unlockedBy: 'door' };
  script.states.push({ key: 'escaped', files: [], puzzles: [], transitions: [] });
  return script;
}
