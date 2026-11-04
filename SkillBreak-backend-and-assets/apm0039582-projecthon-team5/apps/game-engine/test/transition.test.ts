import { commandRejection } from '../src/modules/sessions/core/eligibility';
import type { Snapshot } from '../src/modules/sessions/core/state';
import { randomUUID } from 'node:crypto';
import type { PlayerCommand } from '@team5/contracts';
import { transition } from '../src/modules/sessions/core/transition';
import { room1Script, room1Templates, ROOM1 } from '../src/modules/script-catalog/room1';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';

const content = { script: room1Script, templates: Object.fromEntries(room1Templates.map(template => [`${template.key}@${template.version}`, template])) };
const start: Extract<PlayerCommand, { type: 'StartSession' }> = { type: 'StartSession', messageId: randomUUID(),
  sessionId: randomUUID(), payload: { userId: randomUUID(), scriptSlug: 'escape-room' } };
function input(puzzleKey: string): Extract<PlayerCommand, { type: 'SubmitInput' }> {
  return { type: 'SubmitInput', messageId: randomUUID(), sessionId: start.sessionId,
    payload: { userId: start.payload.userId, puzzleKey, input: { kind: 'answer', answer: 'sensitive-input' } } };
}

const now = new Date('2026-11-02T10:00:00Z');
function readySnapshot(): Snapshot {
  return {
    id: 'session', ownerId: 'owner', scriptId: 'escape-room', scriptVersion: 1,
    version: 2, status: 'Active', roomKey: 'room-1', visitedRooms: ['room-1'],
    startedAt: now.toISOString(), deadlineAt: '2026-11-02T10:45:00Z', endedAt: null,
    puzzles: [{ key: 'idan-db', roomKey: 'room-1', family: 'sql', templateRef: 'idan-db-sql@1',
      status: 'open', sandbox: { generation: 1, status: 'ready' }, latestResult: null,
      openedAt: now.toISOString(), attempts: 0, wrongAttempts: 0 }],
  };
}

test.each(['locked', 'time', 'sandbox', 'failed', 'inactive', 'unvisited', 'unknown'] as const)(
  'rejects %s input using canonical reasons', condition => {
    const snapshot = readySnapshot();
    if (condition === 'locked') snapshot.puzzles[0].status = 'locked';
    if (condition === 'sandbox') snapshot.puzzles[0].sandbox.status = 'provisioning';
    if (condition === 'failed') snapshot.puzzles[0].sandbox.status = 'failed';
    if (condition === 'inactive') snapshot.status = 'Abandoned';
    if (condition === 'unvisited') snapshot.visitedRooms = [];
    expect(commandRejection(snapshot, condition === 'unknown' ? 'missing' : 'idan-db',
      condition === 'time' ? new Date(snapshot.deadlineAt) : now)).toBe({
      locked: 'puzzleLocked', time: 'timeUp', sandbox: 'sandboxRestarting', failed: 'sandboxRestarting',
      inactive: 'sessionEnded', unvisited: 'puzzleLocked', unknown: 'puzzleLocked',
    }[condition]);
    expect(snapshot.puzzles[0].attempts).toBe(0);
  },
);
test('allows solved SQL revisits without extending the deadline', () => {
  const snapshot = readySnapshot();
  snapshot.roomKey = 'room-2';
  snapshot.visitedRooms.push('room-2');
  snapshot.puzzles[0].status = 'solved';
  expect(commandRejection(snapshot, 'idan-db', now)).toBeUndefined();
  expect(snapshot.deadlineAt).toBe('2026-11-02T10:45:00Z');
});

test('starts once with pinned content and deterministic same-version sibling events without seq', () => {
  const result = transition(null, start, content, now);
  expect(result).toEqual(transition(null, start, content, now));
  expect(result.next).toMatchObject({ version: 1, scriptVersion: 1, deadlineAt: '2026-11-02T10:45:00.000Z' });
  expect(result.gameEvents.map(event => event.type)).toEqual(['SessionStarted', 'PuzzleOpened']);
  expect(new Set(result.gameEvents.map(event => event.eventId)).size).toBe(2);
  for (const event of result.gameEvents) {
    expect(event.sessionVersion).toBe(1);
    expect(event.messageId).toBe(event.eventId);
    expect(event).not.toHaveProperty('seq');
  }
  expect(result.sandboxJobs).toHaveLength(1);
  expect(result.sandboxJobs[0].operation).toBe('provision');
  expect(transition(result.next, start, content, now).changed).toBe(false);
  expect(JSON.stringify(result.gameEvents)).not.toContain(ROOM1.danaPassword);
});

function startedReady(): Snapshot {
  const snapshot = transition(null, start, content, now).next!;
  snapshot.puzzles[0].sandbox.status = 'ready';
  return snapshot;
}

test('plays all puzzles, preserves deadline and keeps solved SQL available in room 2', () => {
  let snapshot = startedReady();
  const original = structuredClone(snapshot);
  for (const key of ['idan-db', 'hash-cracker', 'dana-login']) {
    const result = transition(snapshot, input(key), content, now, { verdict: 'solved', reason: null, output: '' });
    expect(result.sandboxJobs).toEqual([]);
    snapshot = result.next!;
  }
  expect(snapshot).toMatchObject({ roomKey: 'room-2', status: 'Active', visitedRooms: ['room-1', 'room-2'], deadlineAt: original.deadlineAt });
  const revisit = transition(snapshot, input('idan-db'), content, now, { verdict: 'progress', reason: null, output: 'safe output' });
  expect(revisit.gameEvents.map(event => event.type)).toEqual(['CommandEvaluated']);
  expect(revisit.next!.puzzles[0].status).toBe('solved');
  expect(original.puzzles[0].attempts).toBe(0);
});

test('counts wrong answers without leaking submitted credentials', () => {
  const snapshot = startedReady();
  const command = input('idan-db');
  const result = transition(snapshot, command, content, now, { verdict: 'rejected', reason: 'wrongAnswer', output: '' });
  expect(result.next!.puzzles[0]).toMatchObject({ attempts: 1, wrongAttempts: 1 });
  expect(JSON.stringify(result)).not.toContain('sensitive-input');
  command.payload.userId = randomUUID();
  expect(transition(snapshot, command, content, now).changed).toBe(false);
});

test('updates sandbox state once, preserving openedAt, and ignores obsolete generations', () => {
  const snapshot = startedReady();
  const outcome = { type: 'SandboxOutcome' as const, sessionId: snapshot.id, messageId: randomUUID(), payload: {
    ...sandboxIdentity(snapshot.id, 'idan-db', 1), jobId: randomUUID(), kind: 'failed' as const,
    operation: 'provision' as const, errorCode: 'failed', occurredAt: now.toISOString(),
  } };
  const result = transition(snapshot, outcome, content, now);
  expect(result.gameEvents[0]).toMatchObject({ type: 'PuzzleOpened', payload: { openedAt: snapshot.puzzles[0].openedAt,
    puzzle: { sandbox: { generation: 1, status: 'failed' } } } });
  expect(transition(result.next, outcome, content, now).changed).toBe(false);
  outcome.payload.generation = 0;
  expect(transition(snapshot, outcome, content, now).changed).toBe(false);
});

test('expires at the deadline and destroys sandboxes; abandonment is idempotent', () => {
  const snapshot = startedReady();
  const expired = transition(snapshot, input('idan-db'), content, new Date(snapshot.deadlineAt));
  expect(expired.next!.status).toBe('Expired');
  expect(expired.gameEvents.map(event => event.type)).toEqual(['CommandEvaluated', 'SessionExpired']);
  expect(expired.sandboxJobs[0].operation).toBe('destroy');
  const abandon = { type: 'AbandonSession' as const, sessionId: snapshot.id, messageId: randomUUID(), payload: { userId: snapshot.ownerId } };
  const ended = transition(snapshot, abandon, content, now);
  expect(ended.next!.status).toBe('Abandoned');
  expect(transition(ended.next, abandon, content, now).changed).toBe(false);
});

test('hint without configured content returns noHint and reconnect preserves the deadline', () => {
  const snapshot = startedReady();
  const request = { sessionId: snapshot.id, messageId: randomUUID(), payload: { userId: snapshot.ownerId } };
  expect(transition(snapshot, { ...request, type: 'RequestHint' }, content, now).gameEvents[0])
    .toMatchObject({ type: 'CommandEvaluated', payload: { puzzleKey: null, result: { reason: 'noHint' } } });
  expect(transition(snapshot, { ...request, type: 'PlayerReconnected' }, content, now).next!.deadlineAt).toBe(snapshot.deadlineAt);
});