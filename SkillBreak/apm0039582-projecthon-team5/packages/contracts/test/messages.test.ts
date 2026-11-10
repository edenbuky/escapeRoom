import { commands, events, sessionId } from './fixtures';

test('all seven commands and eleven events are session scoped with required data', () => {
  expect(Object.keys(commands)).toEqual(['StartSession', 'SubmitInput', 'OpenDoor', 'EnterRoom', 'RequestHint', 'PlayerReconnected', 'AbandonSession']);
  expect(Object.keys(events)).toEqual(['SessionStarted', 'PuzzleOpened', 'DoorOpened', 'CommandEvaluated', 'PuzzleSolved', 'HintRevealed', 'RoomEntered', 'PuzzleReset', 'SessionEscaped', 'SessionExpired', 'SessionAbandoned']);
  for (const message of [...Object.values(commands), ...Object.values(events)]) {
    expect(message.sessionId).toBe(sessionId);
    expect(message.messageId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(Object.keys(message.payload).length).toBeGreaterThan(0);
  }
  for (const event of Object.values(events)) {
    expect(event.messageId).toBe(event.eventId);
    expect(Number.isSafeInteger(event.sessionVersion) && event.sessionVersion > 0).toBe(true);
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
    expect(Object.keys(event).sort()).toEqual(['eventId', 'messageId', 'occurredAt', 'payload', 'sessionId', 'sessionVersion', 'type']);
  }
});

test('same-version siblings have distinct identity; redelivery preserves identity and content', () => {
  const first = events.SessionStarted;
  const sibling = events.PuzzleOpened;
  const retry = JSON.parse(JSON.stringify(first));
  expect(sibling.sessionVersion).toBe(first.sessionVersion);
  expect(sibling.eventId).not.toBe(first.eventId);
  expect(retry).toEqual(first);
  expect(new Set([first.messageId, sibling.messageId, retry.messageId]).size).toBe(2);
});

test('room-reset siblings carry independent IDs and generations, not an extra event sequence', () => {
  const first = events.PuzzleReset;
  const sibling = { ...first, eventId: events.RoomEntered.eventId, messageId: events.RoomEntered.messageId,
    payload: { ...first.payload, puzzle: { ...first.payload.puzzle, key: 'git' } } };
  expect(sibling.sessionVersion).toBe(first.sessionVersion);
  expect(sibling.payload.puzzle.key).not.toBe(first.payload.puzzle.key);
  expect(sibling.payload.files).toEqual(first.payload.files);
  expect(sibling).not.toHaveProperty('eventSeq');
});
