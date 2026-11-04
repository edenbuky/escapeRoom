import type { GameEvent, PlayerCommand, PuzzleView, SessionView } from '../src';

export const sessionId = '00000000-0000-4000-8000-000000000001';
export const commandId = '00000000-0000-4000-8000-000000000002';
export const at = '2026-11-01T22:00:00.000Z';
export const puzzle: PuzzleView = {
  key: 'sql', family: 'sql', status: 'open',
  sandbox: { generation: 1, status: 'provisioning' }, latestResult: null,
};
export const view: SessionView = {
  sessionId, version: 1, status: 'Active',
  currentRoom: { key: 'room-1', puzzles: [puzzle], files: [{ name: 'capture', content: 'public ciphertext' }] },
  deadlineAt: at, endedAt: null, latestResult: null, revealedHints: [],
};
const metadata = { sessionId, messageId: commandId };
export const commands = {
  StartSession: { ...metadata, type: 'StartSession', payload: { userId: 'player', scriptSlug: 'escape-room' } },
  SubmitInput: { ...metadata, type: 'SubmitInput', payload: { userId: 'player', puzzleKey: 'sql', input: { kind: 'command', command: 'SELECT 1' } } },
  RequestHint: { ...metadata, type: 'RequestHint', payload: { userId: 'player' } },
  PlayerReconnected: { ...metadata, type: 'PlayerReconnected', payload: { userId: 'player' } },
  AbandonSession: { ...metadata, type: 'AbandonSession', payload: { userId: 'player' } },
} satisfies { [T in PlayerCommand['type']]: Extract<PlayerCommand, { type: T }> };
const envelope = (id: number) => ({
  sessionId, eventId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  messageId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  sessionVersion: 1, occurredAt: at,
});
export const events = {
  SessionStarted: { ...envelope(10), type: 'SessionStarted', payload: { ownerId: 'player', scriptId: 'escape', scriptVersion: 1, startedAt: at, deadlineAt: at, room: view.currentRoom } },
  PuzzleOpened: { ...envelope(11), type: 'PuzzleOpened', payload: { roomKey: 'room-1', puzzle, openedAt: at } },
  CommandEvaluated: { ...envelope(12), type: 'CommandEvaluated', payload: { commandId, roomKey: 'room-1', puzzleKey: null, result: { commandId, verdict: 'rejected', output: 'No hint for this step', reason: 'noHint' } } },
  PuzzleSolved: { ...envelope(13), type: 'PuzzleSolved', payload: { roomKey: 'room-1', puzzleKey: 'sql', solvedAt: at, solveSeconds: 30, files: [{ name: 'capture', content: 'authorized solve output' }] } },
  HintRevealed: { ...envelope(14), type: 'HintRevealed', payload: { roomKey: 'room-1', puzzleKey: 'sql', text: 'Inspect the schema', firstTime: true, revealedAt: at } },
  RoomEntered: { ...envelope(15), type: 'RoomEntered', payload: { room: view.currentRoom, enteredAt: at } },
  PuzzleReset: { ...envelope(16), type: 'PuzzleReset', payload: { roomKey: 'room-1', puzzle: { ...puzzle, sandbox: { generation: 2, status: 'provisioning' } }, resetAt: at, scope: 'room', files: view.currentRoom.files } },
  SessionEscaped: { ...envelope(17), type: 'SessionEscaped', payload: { endedAt: at } },
  SessionExpired: { ...envelope(18), type: 'SessionExpired', payload: { endedAt: at } },
  SessionAbandoned: { ...envelope(19), type: 'SessionAbandoned', payload: { endedAt: at } },
} satisfies { [T in GameEvent['type']]: Extract<GameEvent, { type: T }> };
