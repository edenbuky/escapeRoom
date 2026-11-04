import type { EvaluationView, PuzzleFamily, PuzzleStatus, SandboxStatus, SessionStatus, SessionView, Verdict } from '../src';
import { at, commandId, events, view } from './fixtures';

test('public view is an explicit allowlist with nullable results and no hidden replacement', () => {
  expect(Object.keys(view).sort()).toEqual(['currentRoom', 'deadlineAt', 'endedAt', 'latestResult', 'revealedHints', 'sessionId', 'status', 'version']);
  expect(view.latestResult).toBeNull();
  expect(view.currentRoom.puzzles[0].latestResult).toBeNull();
  expect(view.endedAt).toBeNull();
  expect(view.revealedHints).toEqual([]);
  expect(JSON.stringify(view)).not.toMatch(/solutionRef|expectedAnswer|ownerId|authorized solve output/);
  expect(new Set(view.currentRoom.files.map(file => file.name)).size).toBe(view.currentRoom.files.length);
  expect(new Set(view.currentRoom.puzzles.map(puzzle => puzzle.key)).size).toBe(view.currentRoom.puzzles.length);
});

test('authorized examples retain hints/files and session-level rejection feedback on reconnect', () => {
  const disclosed: SessionView = { ...view, latestResult: events.CommandEvaluated.payload.result,
    currentRoom: { ...view.currentRoom, files: events.PuzzleSolved.payload.files },
    revealedHints: [{ roomKey: 'room-1', puzzleKey: 'sql', text: 'Inspect the schema', revealedAt: at }] };
  expect(JSON.parse(JSON.stringify(disclosed))).toEqual(disclosed);
  expect(disclosed.latestResult?.reason).toBe('noHint');
  expect(view.currentRoom.files[0].content).toBe('public ciphertext');
  expect(events.CommandEvaluated.payload.puzzleKey).toBeNull();
});

test('status and verdict vocabulary remains closed and all four verdict examples are representable', () => {
  const statuses: Record<SessionStatus, null> = { Active: null, Escaped: null, Expired: null, Abandoned: null };
  const puzzles: Record<PuzzleStatus, null> = { locked: null, open: null, solved: null };
  const sandbox: Record<SandboxStatus, null> = { none: null, provisioning: null, ready: null, failed: null };
  const families: Record<PuzzleFamily, null> = { sql: null, 'terminal-git': null, hash: null, rsa: null, tls: null, answer: null };
  const verdicts: Record<Verdict, EvaluationView> = {
    progress: { commandId, output: '', verdict: 'progress', reason: null },
    solved: { commandId, output: '', verdict: 'solved', reason: null },
    rejected: { commandId, output: '', verdict: 'rejected', reason: 'wrongAnswer' },
    ruined: { commandId, output: '', verdict: 'ruined', reason: null },
  };
  expect(Object.keys(statuses)).toHaveLength(4);
  expect(Object.keys(puzzles)).toHaveLength(3);
  expect(Object.keys(sandbox)).toHaveLength(4);
  expect(Object.keys(families)).toHaveLength(6);
  expect(Object.keys(verdicts)).toEqual(['progress', 'solved', 'rejected', 'ruined']);
});
