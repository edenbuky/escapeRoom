import type { EvaluationView, GameEvent, RoomFile, PuzzleView, SessionStatus } from '@team5/contracts';
import type { ComponentTemplateDto, ScriptVersionDto } from '../../script-catalog/catalog.types';
import type { SandboxJobRequest } from '../../sandbox/sandbox.contracts';

export interface PuzzleState extends PuzzleView {
  roomKey: string;
  templateRef: string;
  openedAt: string | null;
  attempts: number;
  wrongAttempts: number;
}
export interface Snapshot {
  id: string;
  ownerId: string;
  scriptId: string;
  scriptVersion: number;
  version: number;
  status: SessionStatus;
  roomKey: string;
  visitedRooms: string[];
  startedAt: string;
  deadlineAt: string;
  endedAt: string | null;
  doors?: Record<string, string>;
  roomEnteredAt?: Record<string, string>;
  sqlMilestone?: { startedAt: string; completedAt: string | null; elapsedSeconds: number | null };
  puzzles: PuzzleState[];
  roomFiles?: Record<string, RoomFile[]>;
}
export type Evaluation = (Omit<Extract<EvaluationView, { verdict: 'rejected' }>, 'commandId'>
  | Omit<Exclude<EvaluationView, { verdict: 'rejected' }>, 'commandId'>)
  & { reveal?: string | Record<string, string>; invariant?: string };
export interface ResolvedScript {
  script: ScriptVersionDto;
  templates: Record<string, ComponentTemplateDto>;
}
export interface TransitionResult {
  next: Snapshot | null;
  gameEvents: GameEvent[];
  sandboxJobs: SandboxJobRequest[];
  changed: boolean;
}