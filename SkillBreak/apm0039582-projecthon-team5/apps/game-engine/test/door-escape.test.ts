import { randomUUID } from 'node:crypto';
import type { PlayerCommand } from '@team5/contracts';
import { ComponentFactory } from '../src/modules/components/components';
import { reduceProjection } from '../src/modules/projection/projection.reducer';
import { room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import type { Snapshot } from '../src/modules/sessions/core/state';
import { transition } from '../src/modules/sessions/core/transition';

const templates = Object.fromEntries([...room1Templates, ...room2Templates('sha256:test')].map(t => [`${t.key}@${t.version}`, t]));
const v4 = structuredClone(room1GameplayScript);
v4.version = 4;
const v5 = { script: room2Script(v4), templates };
const v3 = { script: room1GameplayScript, templates };
const factory = new ComponentFactory(undefined, { compare: async () => false });
const userId = randomUUID();
const sessionId = randomUUID();
const t0 = new Date('2026-11-09T10:00:00Z');
const solved = { verdict: 'solved' as const, reason: null, output: '' };
const cmd = <Type extends 'OpenDoor' | 'EnterRoom'>(type: Type, roomKey: string) =>
  ({ type, messageId: randomUUID(), sessionId, payload: { userId, roomKey } }) as Extract<PlayerCommand, { type: Type }>;
const submit = (puzzleKey: string, answer: string): Extract<PlayerCommand, { type: 'SubmitInput' }> =>
  ({ type: 'SubmitInput', messageId: randomUUID(), sessionId, payload: { userId, puzzleKey, input: { kind: 'answer', answer } } });
const start: Extract<PlayerCommand, { type: 'StartSession' }> = { type: 'StartSession', messageId: randomUUID(), sessionId,
  payload: { userId, scriptSlug: 'escape-room' } };

function inRoom2(content = v5): Snapshot {
  let snapshot = transition(null, start, content, t0).next!;
  snapshot = transition(snapshot, submit('dana-login', 'x'), content, t0, solved).next!;
  snapshot = transition(snapshot, cmd('OpenDoor', 'room-1'), content, t0).next!;
  snapshot = transition(snapshot, cmd('EnterRoom', 'room-1'), content, t0).next!;
  return snapshot;
}
const withDoorPuzzle = (snapshot: Snapshot, status: 'open' | 'solved') => {
  snapshot.puzzles.forEach(puzzle => { if (puzzle.roomKey === 'room-2') puzzle.status = puzzle.key === 'door' ? status : 'solved'; });
  return snapshot;
};
const reasonOf = (result: ReturnType<typeof transition>) => (result.gameEvents[0] as any).payload.result.reason;

describe('catalog-driven doors', () => {
  test('Room 1 door works on v5 catalog data and on legacy v3 data without door fields', () => {
    for (const content of [v5, v3]) {
      expect(inRoom2(content)).toMatchObject({ roomKey: 'room-2', visitedRooms: ['room-1', 'room-2'] });
    }
    expect(v3.script.states[0].door).toBeUndefined();
  });

  test('the door code solves via single-field answer, tolerating spaces; wrong codes count', async () => {
    const snapshot = withDoorPuzzle(inRoom2(), 'open');
    const door = snapshot.puzzles.find(p => p.key === 'door')!;
    const template = templates[door.templateRef];
    expect(room2Scenario.cardNumber).toBe('4000000131941181');
    const check = (answer: string) => factory.evaluate(template, snapshot, door, randomUUID(), { kind: 'answer', answer });
    expect(await check(' 4000 0001 3194 1181 ')).toMatchObject({ verdict: 'solved' });
    expect(await check('4000000131941181')).toMatchObject({ verdict: 'solved' });
    expect(await check('4000000131941182')).toMatchObject({ verdict: 'rejected', reason: 'wrongAnswer' });
    expect(await check('4000-0001-3194-1181')).toMatchObject({ reason: 'wrongAnswer' });
    expect(await check('abc')).toMatchObject({ reason: 'wrongAnswer' });
    const wrong = transition(snapshot, submit('door', '1'), v5, t0, { verdict: 'rejected', reason: 'wrongAnswer', output: '' }).next!;
    expect(wrong.puzzles.find(p => p.key === 'door')).toMatchObject({ wrongAttempts: 1, status: 'open' });
  });

  test('OpenDoor/EnterRoom in room-2 are rejected until the door puzzle is solved and the door opened', () => {
    const snapshot = withDoorPuzzle(inRoom2(), 'open');
    expect(reasonOf(transition(snapshot, cmd('OpenDoor', 'room-2'), v5, t0))).toBe('puzzleLocked');
    expect(reasonOf(transition(snapshot, cmd('EnterRoom', 'room-2'), v5, t0))).toBe('puzzleLocked');
    withDoorPuzzle(snapshot, 'solved');
    expect(reasonOf(transition(snapshot, cmd('EnterRoom', 'room-2'), v5, t0))).toBe('puzzleLocked');
    expect(reasonOf(transition(snapshot, cmd('OpenDoor', 'room-1'), v5, t0))).toBe('puzzleLocked');
  });

  test('full exit: OpenDoor then EnterRoom escapes, destroys sandboxes and ends the session', () => {
    let snapshot = withDoorPuzzle(inRoom2(), 'solved');
    snapshot.puzzles.find(p => p.key === 'nethanel-git')!.sandbox = { status: 'ready', generation: 1 };
    snapshot.puzzles[0].family = 'sql';
    snapshot.puzzles[0].sandbox = { status: 'ready', generation: 1 };
    const opened = transition(snapshot, cmd('OpenDoor', 'room-2'), v5, new Date(t0.getTime() + 60000));
    expect(opened.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated', 'DoorOpened']);
    expect(opened.next!).toMatchObject({ status: 'Active', roomKey: 'room-2' });
    snapshot = opened.next!;
    const at = new Date(t0.getTime() + 120000);
    const escaped = transition(snapshot, cmd('EnterRoom', 'room-2'), v5, at);
    expect(escaped.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated', 'SessionEscaped']);
    expect(escaped.next).toMatchObject({ status: 'Escaped', endedAt: at.toISOString(), roomKey: 'room-2' });
    expect(escaped.sandboxJobs.some(job => job.operation === 'destroy')).toBe(true);
    const later = transition(escaped.next!, cmd('OpenDoor', 'room-2'), v5, at);
    expect(reasonOf(later)).toBe('sessionEnded');
    expect(reasonOf(transition(escaped.next!, cmd('EnterRoom', 'room-2'), v5, at))).toBe('sessionEnded');
    expect(transition(escaped.next!, submit('door', '1'), v5, at, undefined).gameEvents[0]).toMatchObject({ payload: { result: { reason: 'sessionEnded' } } });
    expect(escaped.next!.status).toBe('Escaped');
  });

  test('after the deadline EnterRoom yields timeUp and Expired, not Escaped', () => {
    const snapshot = withDoorPuzzle(inRoom2(), 'solved');
    snapshot.doors = { ...snapshot.doors, 'room-2': t0.toISOString() };
    const late = transition(snapshot, cmd('EnterRoom', 'room-2'), v5, new Date(Date.parse(snapshot.deadlineAt) + 1000));
    expect(reasonOf(late)).toBe('timeUp');
    expect(late.next!.status).toBe('Expired');
    expect(late.gameEvents.map(e => e.type)).toEqual(['CommandEvaluated', 'SessionExpired']);
  });

  test('projection handles SessionEscaped', () => {
    const started = transition(null, start, v5, t0).gameEvents[0];
    const first = reduceProjection(null, started);
    const endedAt = new Date(t0.getTime() + 5000).toISOString();
    const next = reduceProjection({ ...first, version: 1, revision: '1' }, { type: 'SessionEscaped', payload: { endedAt }, messageId: randomUUID(),
      eventId: randomUUID(), sessionId, occurredAt: endedAt, sessionVersion: 2 });
    expect(next.view).toMatchObject({ status: 'Escaped', endedAt });
  });
});
