import type { RejectionReason } from '@team5/contracts';
import type { Snapshot } from './state';
import { isSandboxEngine } from '../../sandbox/sandbox-seeds';

export function commandRejection(snapshot: Snapshot, puzzleKey: string, now: Date): RejectionReason | undefined {
  if (snapshot.status !== 'Active') return 'sessionEnded';
  if (now.getTime() >= Date.parse(snapshot.deadlineAt)) return 'timeUp';
  const puzzle = snapshot.puzzles.find(candidate => candidate.key === puzzleKey);
  if (snapshot.scriptVersion >= 3 && puzzle?.roomKey !== snapshot.roomKey) return 'puzzleLocked';
  if (!puzzle || puzzle.status === 'locked' || !snapshot.visitedRooms.includes(puzzle.roomKey)) return 'puzzleLocked';
  if (isSandboxEngine(puzzle.family) && puzzle.sandbox.status !== 'ready') return 'sandboxRestarting';
  return undefined;
}