import type { SandboxJobRequest, SandboxOutcome, ExecResult } from '../src/modules/sandbox/sandbox.contracts';

const identity = { sessionId: 'session', puzzleKey: 'sql', generation: 1, namespace: 'sandbox', podName: 'session-sql-1' };
const provision: SandboxJobRequest = { ...identity, jobId: 'provision-1', operation: 'provision', imageDigest: 'example@sha256:digest', seedRef: null, policyRef: 'read-only' };

test('retries retain stable job and pod identity; destroy targets the original pod', () => {
  const retry: SandboxJobRequest = { ...provision };
  const destroy: SandboxJobRequest = { ...identity, jobId: 'destroy-1', operation: 'destroy' };
  expect(retry).toEqual(provision);
  expect(destroy.podName).toBe(provision.podName);
  expect(destroy.jobId).not.toBe(provision.jobId);
});

test('every outcome and explicit timeout is representable without a worker', () => {
  const outcomes: SandboxOutcome[] = [
    { ...identity, jobId: provision.jobId, kind: 'ready', occurredAt: '2026-11-01T00:00:00.000Z' },
    { ...identity, jobId: provision.jobId, kind: 'failed', operation: 'provision', errorCode: 'pod_failed', occurredAt: '2026-11-01T00:00:00.000Z' },
    { ...identity, jobId: 'destroy-1', kind: 'destroyed', occurredAt: '2026-11-01T00:00:00.000Z' },
  ];
  const result: ExecResult = { commandId: 'command', stdout: '', stderr: '', exitCode: null, timedOut: true, truncated: false };
  expect(outcomes.map(outcome => outcome.kind)).toEqual(['ready', 'failed', 'destroyed']);
  const reset = { ...identity, generation: 2, podName: 'session-sql-2' };
  expect(outcomes[0].generation).not.toBe(reset.generation);
  expect(result.exitCode).toBeNull();
  expect(result.timedOut).toBe(true);
});
