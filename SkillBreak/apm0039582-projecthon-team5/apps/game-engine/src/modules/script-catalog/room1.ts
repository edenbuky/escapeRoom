import type { ComponentTemplateDto, ScriptVersionDto } from './catalog.types';

export const ROOM1 = {
  danaUsername: 'danaZ22',
  danaPassword: 'edenIsMyFavourite',
  danaPasswordSha256: 'ea7e95b64496fb6f22959c4a2f6442ab5bd4d8a2ba9c5a0ff9404ee792a6ac90',
} as const;

export const ROOM1_TEMPLATE_REFS = {
  'idan-db': 'idan-db-sql@1',
  'hash-cracker': 'dana-hash@1',
  'dana-login': 'dana-login@1',
} as const;

export const room1Script: ScriptVersionDto = {
  scriptId: 'escape-room', version: 1, durationMinutes: 45,
  initialState: 'room-1', finalStates: [],
  states: [
    { key: 'room-1', files: [], puzzles: [
      { key: 'idan-db', templateRef: ROOM1_TEMPLATE_REFS['idan-db'], opensAfter: [], onRuin: 'resetPuzzle' },
      { key: 'hash-cracker', templateRef: ROOM1_TEMPLATE_REFS['hash-cracker'], opensAfter: ['idan-db'], onRuin: 'resetPuzzle' },
      { key: 'dana-login', templateRef: ROOM1_TEMPLATE_REFS['dana-login'], opensAfter: ['hash-cracker'], onRuin: 'resetPuzzle' },
    ], transitions: [{ on: 'AllSolved', to: 'room-2' }] },
    { key: 'room-2', files: [], puzzles: [], transitions: [] },
  ],
};

export const room1Templates: ComponentTemplateDto[] = [
  { key: 'idan-db-sql', version: 1, family: 'sandbox', engine: 'sql', definition: {
    imageDigest: 'local/room1-sql:dev', seedRef: 'room1-sql-v1',
    policy: { readOnly: true, singleStatement: true, maxQueryChars: 4096 },
    goal: { type: 'resultContains', value: ROOM1.danaPasswordSha256 },
    inputSchema: { type: 'object', required: ['kind', 'command'], additionalProperties: false,
      properties: { kind: { const: 'command' }, command: { type: 'string', minLength: 1, maxLength: 4096 } } },
  } },
  { key: 'dana-hash', version: 1, family: 'input', engine: 'hash', definition: {
    seed: { expectedHashHex: ROOM1.danaPasswordSha256, revealedPassword: ROOM1.danaPassword },
    inputSchema: { type: 'object', required: ['kind', 'answer'], additionalProperties: false,
      properties: { kind: { const: 'answer' }, answer: { type: 'string', maxLength: 128 } } },
  } },
  { key: 'dana-login', version: 1, family: 'input', engine: 'answer', definition: {
    seed: { fields: { username: ROOM1.danaUsername, password: ROOM1.danaPassword } },
    inputSchema: { type: 'object', required: ['kind', 'username', 'password'], additionalProperties: false,
      properties: { kind: { const: 'credentials' }, username: { type: 'string', maxLength: 256 },
        password: { type: 'string', maxLength: 256 } } },
  } },
];

export const room1GameplayScript: ScriptVersionDto = {
  ...structuredClone(room1Script), version: 3,
  states: room1Script.states.map(state => ({ ...structuredClone(state), transitions: [],
    puzzles: state.puzzles.map(puzzle => ({ ...puzzle, opensAfter: [] })) })),
};