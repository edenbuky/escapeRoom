import type { EventMessage } from './envelope';
import type { EvaluationView, PuzzleView, RoomFile, RoomView } from '../views/session-view';

export type GameEvent =
  | EventMessage<'SessionStarted', { ownerId: string; scriptId: string; scriptVersion: number; startedAt: string; deadlineAt: string; room: RoomView }>
  | EventMessage<'PuzzleOpened', { roomKey: string; puzzle: PuzzleView; openedAt: string }>
  | EventMessage<'CommandEvaluated', { commandId: string; roomKey: string; puzzleKey: string | null; result: EvaluationView }>
  | EventMessage<'PuzzleSolved', { roomKey: string; puzzleKey: string; solvedAt: string; solveSeconds: number; files: RoomFile[] }>
  | EventMessage<'HintRevealed', { roomKey: string; puzzleKey: string; text: string; firstTime: boolean; revealedAt: string }>
  | EventMessage<'RoomEntered', { room: RoomView; enteredAt: string }>
  | EventMessage<'PuzzleReset', { roomKey: string; puzzle: PuzzleView; resetAt: string; scope: 'puzzle' | 'room'; files: RoomFile[] }>
  | EventMessage<'SessionEscaped', { endedAt: string }>
  | EventMessage<'SessionExpired', { endedAt: string }>
  | EventMessage<'SessionAbandoned', { endedAt: string }>;
