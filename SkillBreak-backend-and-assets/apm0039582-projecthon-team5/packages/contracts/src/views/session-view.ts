import type { PuzzleFamily, PuzzleStatus, RejectionReason, SandboxStatus, SessionStatus } from '../messages/value-types';

export type EvaluationView = { commandId: string; output: string } & (
  | { verdict: 'rejected'; reason: RejectionReason }
  | { verdict: 'progress' | 'solved' | 'ruined'; reason: null }
);
export interface RoomFile {
  name: string;
  content: string;
}
export interface RevealedHint {
  roomKey: string;
  puzzleKey: string;
  text: string;
  revealedAt: string;
}
export interface PuzzleView {
  key: string;
  family: PuzzleFamily;
  status: PuzzleStatus;
  sandbox: { generation: number; status: SandboxStatus };
  latestResult: EvaluationView | null;
}
export interface RoomView {
  key: string;
  puzzles: PuzzleView[];
  files: RoomFile[];
}
/** Only authorized display data. Types do not sanitize private objects at runtime. */
export interface SessionView {
  sessionId: string;
  version: number;
  status: SessionStatus;
  currentRoom: RoomView;
  deadlineAt: string;
  endedAt: string | null;
  latestResult: EvaluationView | null;
  revealedHints: RevealedHint[];
}
