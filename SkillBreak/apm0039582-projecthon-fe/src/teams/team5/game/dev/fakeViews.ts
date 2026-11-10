import type { PuzzleView, SessionView } from '../../contracts/view';
import { ROOM_2_FILE_NAME, ROOM_2_PUZZLE_KEYS } from '../../contracts/keys';

type FakeViewName = 'starting' | 'ready' | 'sqlRows' | 'sqlSyntaxError' | 'sqlFailed' | 'sqlTruncated' | 'hash' | 'login' | 'room2'
  | 'room2GitReady' | 'room2RsaOpen' | 'room2TlsOpen' | 'room2DoorOpen' | 'room2Escaped';

import { DECRYPTED_CAPTURE, ENCRYPTED_CAPTURE } from '../screens/capture-viewer/capture-fixture';

/** Engine output for a SELECT: tab-separated, header row first, `\N` for NULL, ends with a newline. */
const SQL_ROWS = 'employee_id\tfull_name\tusername\temail\n1\tIdan Levi\tidanl\tidan@example.test\n2\tDana Cohen\tdanac\t\\N\n';

export function fakeViews(now = Date.now()): Record<FakeViewName, SessionView> {
  const starting: SessionView = {
    sessionId: '00000000-0000-4000-8000-000000000001', version: 1, status: 'Active',
    currentRoom: { key: 'room-1', files: [], puzzles: [
      { key: 'idan-db', family: 'sql', status: 'open', sandbox: { generation: 1, status: 'provisioning' }, latestResult: null },
      { key: 'hash-cracker', family: 'hash', status: 'locked', sandbox: { generation: 0, status: 'none' }, latestResult: null },
      { key: 'dana-login', family: 'answer', status: 'locked', sandbox: { generation: 0, status: 'none' }, latestResult: null },
    ] },
    deadlineAt: new Date(now + 45 * 60000).toISOString(), endedAt: null, latestResult: null, revealedHints: [],
  };
  const ready = structuredClone(starting); ready.version = 2; ready.currentRoom.puzzles[0].sandbox.status = 'ready';
  const sqlResult = (output: string) => {
    const view = structuredClone(ready); view.version = 3;
    view.currentRoom.puzzles[0].latestResult = { commandId: 'fixture-sql', verdict: 'progress', reason: null, output };
    return view;
  };
  const sqlRows = sqlResult(SQL_ROWS);
  const sqlSyntaxError = sqlResult('SQL syntax is invalid or unsupported.');
  const sqlFailed = sqlResult('SQL command failed');
  const sqlTruncated = sqlResult(`SQL output truncated. Narrow the query.\n${SQL_ROWS}`);
  const hash = structuredClone(ready); hash.version = 3;
  hash.currentRoom.puzzles[0].status = 'solved'; hash.currentRoom.puzzles[1].status = 'open';
  hash.currentRoom.puzzles[0].latestResult = { commandId: 'fixture-sql', verdict: 'solved', reason: null, output: 'Query complete' };
  const login = structuredClone(hash); login.version = 4; login.currentRoom.puzzles[1].status = 'solved'; login.currentRoom.puzzles[2].status = 'open';
  login.currentRoom.puzzles[1].latestResult = { commandId: 'fixture-hash', verdict: 'solved', reason: null, output: 'fixture-password' };
  const room2 = structuredClone(login); room2.version = 5;
  // Room 2 as the server sends it on entry: the git puzzle open (sandbox starting), the rest locked, the door not opened yet.
  const room2Puzzle = (key: string, family: PuzzleView['family'], status: PuzzleView['status']): PuzzleView => ({
    key, family, status, sandbox: { generation: key === ROOM_2_PUZZLE_KEYS.git ? 1 : 0, status: key === ROOM_2_PUZZLE_KEYS.git ? 'provisioning' : 'none' }, latestResult: null,
  });
  room2.currentRoom = { key: 'room-2', files: [{ name: ROOM_2_FILE_NAME, content: ENCRYPTED_CAPTURE }], puzzles: [
    room2Puzzle(ROOM_2_PUZZLE_KEYS.git, 'terminal-git', 'open'),
    room2Puzzle(ROOM_2_PUZZLE_KEYS.rsa, 'rsa', 'locked'),
    room2Puzzle(ROOM_2_PUZZLE_KEYS.tls, 'tls', 'locked'),
    room2Puzzle(ROOM_2_PUZZLE_KEYS.door, 'answer', 'locked'),
  ] };
  room2.latestResult = { commandId: 'fixture-login', verdict: 'solved', reason: null, output: 'Accepted' };
  /** A later Room 2 state: puzzles before `step` solved, the one at `step` open, the rest locked; doorOpenedAt is explicit (null). */
  const room2At = (step: number, version: number) => {
    const view = structuredClone(room2); view.version = version;
    view.currentRoom.doorOpenedAt = null;
    view.currentRoom.puzzles.forEach((puzzle, index) => {
      puzzle.status = index < step ? 'solved' : index === step ? 'open' : 'locked';
    });
    view.currentRoom.puzzles[0].sandbox.status = 'ready';
    return view;
  };
  const room2GitReady = room2At(0, 6);
  const room2RsaOpen = room2At(1, 7);
  const room2TlsOpen = room2At(2, 8);
  const room2DoorOpen = room2At(3, 9);
  room2DoorOpen.currentRoom.files = [{ name: ROOM_2_FILE_NAME, content: DECRYPTED_CAPTURE }];
  const room2Escaped = room2At(4, 10);
  room2Escaped.status = 'Escaped'; room2Escaped.endedAt = new Date(now).toISOString();
  room2Escaped.currentRoom.doorOpenedAt = new Date(now).toISOString();
  room2Escaped.currentRoom.files = [{ name: ROOM_2_FILE_NAME, content: DECRYPTED_CAPTURE }];
  return { starting, ready, sqlRows, sqlSyntaxError, sqlFailed, sqlTruncated, hash, login, room2, room2GitReady, room2RsaOpen, room2TlsOpen, room2DoorOpen, room2Escaped };
}