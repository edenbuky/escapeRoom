export interface SandboxIdentity {
  sessionId: string;
  puzzleKey: string;
  generation: number;
  namespace: string;
  podName: string;
}
export type ProvisionJob = SandboxIdentity & {
  jobId: string;
  operation: 'provision';
  imageDigest: string;
  seedRef: string | null;
  policyRef: string;
};
export type DestroyJob = SandboxIdentity & { jobId: string; operation: 'destroy' };
/** Future enqueue commits with engine state; jobId/podName never change on retry. */
export type SandboxJobRequest = ProvisionJob | DestroyJob;
type OutcomeIdentity = SandboxIdentity & { jobId: string; occurredAt: string };
export type ReadyOutcome = OutcomeIdentity & { kind: 'ready' };
export type FailedOutcome = OutcomeIdentity & { kind: 'failed'; operation: 'provision' | 'destroy'; errorCode: string };
export type DestroyedOutcome = OutcomeIdentity & { kind: 'destroyed' };
export type SandboxOutcome = ReadyOutcome | FailedOutcome | DestroyedOutcome;
export interface SandboxOutcomeSink {
  /** Resolve after durable recording; deduplicate identity and reject obsolete generations. */
  record(outcome: SandboxOutcome): Promise<void>;
}
export type ExecRequest = SandboxIdentity & { commandId: string; command: string };
export interface ExecResult {
  commandId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}
export interface SandboxExecutor {
  /** Server owns policy/limits. Unexpected failures reject, rather than fabricate an exit. */
  execute(request: ExecRequest): Promise<ExecResult>;
}
