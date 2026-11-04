import type { EvaluationView, GameEvent, PuzzleView, SessionStatus } from '@team5/contracts';
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
  puzzles: PuzzleState[];
}
export type Evaluation = Omit<Extract<EvaluationView, { verdict: 'rejected' }>, 'commandId'>
  | Omit<Exclude<EvaluationView, { verdict: 'rejected' }>, 'commandId'>;
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