import type { SessionView } from '../../contracts/view';

type FakeViewName = 'starting' | 'ready' | 'sqlRows' | 'sqlSyntaxError' | 'sqlFailed' | 'sqlTruncated' | 'hash' | 'login' | 'room2';

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
  room2.currentRoom = { key: 'room-2', puzzles: [], files: [] };
  room2.latestResult = { commandId: 'fixture-login', verdict: 'solved', reason: null, output: 'Accepted' };
  return { starting, ready, sqlRows, sqlSyntaxError, sqlFailed, sqlTruncated, hash, login, room2 };
}