import { randomUUID } from 'node:crypto';
import type { PlayerCommand } from '@team5/contracts';
import { transition } from '../src/modules/sessions/core/transition';
import { room1GameplayScript, room1Templates } from '../src/modules/script-catalog/room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';
import { room2TlsReveal } from '../src/modules/script-catalog/room2-reveal';
import { room2Scenario } from '../src/modules/script-catalog/room2-scenario.generated';
import { reduceProjection } from '../src/modules/projection/projection.reducer';
import type { Snapshot } from '../src/modules/sessions/core/state';

const script = room2Script(room1GameplayScript);
const content = { script, templates: Object.fromEntries([...room1Templates, ...room2Templates()].map(t => [`${t.key}@${t.version}`, t])) };
const now = new Date('2026-11-02T10:00:00Z');
const ROOM2_FILE = 'Cibus_payment_try.pcap';

function session(): { snapshot: Snapshot; userId: string; sessionId: string; enter: Snapshot } {
  const userId = randomUUID(); const sessionId = randomUUID();
  const start: PlayerCommand = { type: 'StartSession', messageId: randomUUID(), sessionId, payload: { userId, scriptSlug: 'escape-room' } };
  const snapshot = transition(null, start, content, now).next!;
  const enter = structuredClone(snapshot);
  enter.roomKey = 'room-2'; enter.visitedRooms = ['room-1', 'room-2'];
  return { snapshot, userId, sessionId, enter };
}
function submit(s: { userId: string; sessionId: string }, puzzleKey: string): PlayerCommand {
  return { type: 'SubmitInput', messageId: randomUUID(), sessionId: s.sessionId,
    payload: { userId: s.userId, puzzleKey, input: { kind: 'answer', answer: 'x' } } } as PlayerCommand;
}
// Puts a session in room 2 with the given puzzles open, through the real RoomEntered path.
function inRoom2() {
  const s = session();
  let snap = transition(s.snapshot, submit(s, 'dana-login'), content, now, { verdict: 'solved', reason: null, output: '' }).next!;
  snap = transition(snap, { type: 'OpenDoor', messageId: randomUUID(), sessionId: s.sessionId, payload: { userId: s.userId, roomKey: 'room-1' } }, content, now).next!;
  const entered = transition(snap, { type: 'EnterRoom', messageId: randomUUID(), sessionId: s.sessionId, payload: { userId: s.userId, roomKey: 'room-1' } }, content, now);
  return { ...s, snap: entered.next!, entered };
}

test('RoomEntered carries the encrypted file without revealedBy and per-session contents', () => {
  const { snap, entered } = inRoom2();
  const event = entered.gameEvents.find(e => e.type === 'RoomEntered')!;
  expect(JSON.stringify(entered.gameEvents)).not.toContain('revealedBy');
  expect(JSON.stringify(snap)).not.toContain('revealedBy');
  expect((event.payload as any).room.files).toEqual([{ name: ROOM2_FILE, content: room2Scenario.captureEncrypted }]);
  expect(snap.roomFiles!['room-2'][0].content).toBe(room2Scenario.captureEncrypted);
});

test('a stub reveal swaps only the revealedBy puzzle file, and another session still sees the encrypted file', () => {
  const a = inRoom2(); const b = inRoom2();
  const other = a.snap.puzzles.find(p => p.roomKey === 'room-2' && p.status === 'open')!;
  expect(other.key).not.toBe('tls-decryptor');
  const wrong = transition(a.snap, submit(a, other.key), content, now, { verdict: 'solved', reason: null, output: '', reveal: 'WRONG' });
  expect(wrong.next!.roomFiles!['room-2'][0].content).toBe(room2Scenario.captureEncrypted);
  a.snap.puzzles.find(p => p.key === 'tls-decryptor')!.status = 'open';
  a.snap.puzzles.find(p => p.key === 'tls-decryptor')!.openedAt = now.toISOString();
  const solved = transition(a.snap, submit(a, 'tls-decryptor'), content, now,
    { verdict: 'solved', reason: null, output: 'ok', reveal: room2TlsReveal() });
  expect(solved.next!.roomFiles!['room-2'][0].content).toBe(room2Scenario.captureDecrypted);
  const event = solved.gameEvents.find(e => e.type === 'PuzzleSolved')!;
  expect((event.payload as any).files).toEqual([{ name: ROOM2_FILE, content: room2Scenario.captureDecrypted }]);
  expect(JSON.stringify(solved.gameEvents.filter(e => e.type === 'CommandEvaluated'))).not.toContain('card_number');
  expect(b.snap.roomFiles!['room-2'][0].content).toBe(room2Scenario.captureEncrypted);
  expect(b.snap.puzzles.find(p => p.key === 'tls-decryptor')).toBeTruthy();
});

test('projection applies the encrypted to decrypted swap', () => {
  const a = inRoom2();
  const tls = a.snap.puzzles.find(p => p.key === 'tls-decryptor')!;
  tls.status = 'open'; tls.openedAt = now.toISOString();
  const solved = transition(a.snap, submit(a, 'tls-decryptor'), content, now, { verdict: 'solved', reason: null, output: '', reveal: room2TlsReveal() });
  const start = transition(null, { type: 'StartSession', messageId: randomUUID(), sessionId: a.sessionId,
    payload: { userId: a.userId, scriptSlug: 'escape-room' } }, content, now).gameEvents[0];
  let state = reduceProjection(null, start as any);
  let n = 1;
  for (const event of [...a.entered.gameEvents, ...solved.gameEvents]) {
    if (event.type === 'PuzzleSolved') state.view.currentRoom.puzzles.find(p => p.key === 'tls-decryptor')!.status = 'open';
    state = reduceProjection({ ...state, version: n, revision: String(n) } as any, event as any); n++;
  }
  expect(state.view.currentRoom.files).toEqual([{ name: ROOM2_FILE, content: room2Scenario.captureDecrypted }]);
  expect(JSON.stringify(state.view)).not.toContain('revealedBy');
});
