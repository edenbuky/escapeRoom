import { publicView, reduceProjection } from '../src/modules/projection/projection.reducer';
import { fixtureView, started } from './helpers/projection-harness';
test('recursively allowlists public state, retaining authorized output', () => {
  const value = fixtureView();
  const output = { commandId: started().messageId, verdict: 'progress', reason: null, output: 'name\nDana\n', input: 'private' };
  const safe = publicView({ ...value, ownerId: 'private', latestResult: output, currentRoom: {
    ...value.currentRoom, expectedAnswer: 'private', puzzles: value.currentRoom.puzzles.map(puzzle => ({
      ...puzzle, template: 'private', latestResult: output, sandbox: { ...puzzle.sandbox, secret: 'private' },
    })),
  } });
  expect(JSON.stringify(safe)).not.toContain('private');
  expect(safe.currentRoom.puzzles[0].latestResult?.output).toBe('name\nDana\n');
});
test('rejects malformed types, identities, enum values, duplicates and nullability', () => {
  const value = fixtureView();
  for (const patch of [{ sessionId: 'bad' }, { version: 0 }, { version: 1.5 }, { deadlineAt: 'bad' },
    { status: 'unknown' }, { endedAt: new Date().toISOString() }, { latestResult: {} },
    { currentRoom: { ...value.currentRoom, puzzles: [...value.currentRoom.puzzles, ...value.currentRoom.puzzles] } }]) {
    expect(() => publicView({ ...value, ...patch })).toThrow();
  }
});

test('reduces all six types, including distinct equal-version results and sandbox updates', () => {
  const start = started();
  let state = reduceProjection(null, start)!;
  const apply = (type: string, payload: unknown) => {
    state = reduceProjection({ ...state, version: state.view.version, revision: '1' },
      { ...started(), sessionId: start.sessionId, type, payload })!;
  };
  const initialPuzzle = state.view.currentRoom.puzzles[0];
  apply('PuzzleOpened', { roomKey: 'room-1', openedAt: start.occurredAt,
    puzzle: { ...initialPuzzle, sandbox: { generation: 1, status: 'ready' } } });
  expect(state.view.currentRoom.puzzles[0].status).toBe('locked');
  apply('PuzzleOpened', { roomKey: 'room-1', openedAt: start.occurredAt,
    puzzle: { ...initialPuzzle, status: 'open', sandbox: { generation: 1, status: 'ready' } } });
  const result = { commandId: started().messageId, verdict: 'solved', reason: null, output: 'clue\n' };
  apply('CommandEvaluated', { roomKey: 'room-1', puzzleKey: 'sql', commandId: result.commandId, result });
  apply('PuzzleSolved', { roomKey: 'room-1', puzzleKey: 'sql', solvedAt: start.occurredAt, solveSeconds: 2,
    files: [{ name: 'clue.txt', content: 'fictional' }] });
  expect(state.view.currentRoom.puzzles[0]).toMatchObject({ status: 'solved', latestResult: result });
  expect(state.view.currentRoom.files).toEqual([{ name: 'clue.txt', content: 'fictional' }]);
  apply('RoomEntered', { room: { key: 'room-2', puzzles: [], files: [] }, enteredAt: start.occurredAt });
  expect(state.view).toMatchObject({ version: 1, deadlineAt: start.payload.deadlineAt, latestResult: result });
  apply('SessionAbandoned', { endedAt: start.occurredAt });
  const rejection = { ...result, verdict: 'rejected', reason: 'sessionEnded' };
  apply('CommandEvaluated', { roomKey: 'room-2', puzzleKey: null, commandId: result.commandId, result: rejection });
  expect(state.view).toMatchObject({ status: 'Abandoned', endedAt: start.occurredAt, latestResult: rejection });
  expect(() => apply('RoomEntered', { room: start.payload.room, enteredAt: start.occurredAt })).toThrow();
});

test('rejects missing prerequisites, changing owner and puzzle regressions', () => {
  const start = started();
  const initial = reduceProjection(null, start)!;
  const current = { ...initial, version: 1, revision: '1' };
  expect(() => reduceProjection(null, { ...start, type: 'SessionAbandoned', payload: { endedAt: start.occurredAt } })).toThrow();
  expect(() => reduceProjection(current, started())).toThrow();
  for (const patch of [
    { roomKey: 'other', puzzle: start.payload.room.puzzles[0] },
    { roomKey: 'room-1', puzzle: { ...start.payload.room.puzzles[0], key: 'missing' } },
    { roomKey: 'room-1', puzzle: { ...start.payload.room.puzzles[0], sandbox: { generation: 0, status: 'ready' } } },
  ]) expect(() => reduceProjection(current, { ...start, type: 'PuzzleOpened', payload: { ...patch, openedAt: start.occurredAt } })).toThrow();
  current.view.currentRoom.puzzles[0].status = 'solved';
  expect(() => reduceProjection(current, { ...start, type: 'PuzzleOpened', payload: {
    roomKey: 'room-1', openedAt: start.occurredAt, puzzle: { ...start.payload.room.puzzles[0], status: 'open' },
  } })).toThrow();
});
