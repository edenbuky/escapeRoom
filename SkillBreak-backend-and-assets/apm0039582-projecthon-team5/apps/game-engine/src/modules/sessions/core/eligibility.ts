import type { RejectionReason } from '@team5/contracts';
import type { Snapshot } from './state';

export function commandRejection(snapshot: Snapshot, puzzleKey: string, now: Date): RejectionReason | undefined {
  if (snapshot.status !== 'Active') return 'sessionEnded';
  if (now.getTime() >= Date.parse(snapshot.deadlineAt)) return 'timeUp';
  const puzzle = snapshot.puzzles.find(candidate => candidate.key === puzzleKey);
  if (!puzzle || puzzle.status === 'locked' || !snapshot.visitedRooms.includes(puzzle.roomKey)) return 'puzzleLocked';
  if (puzzle.family === 'sql' && puzzle.sandbox.status !== 'ready') return 'sandboxRestarting';
  return undefined;
}