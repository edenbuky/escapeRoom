import type { SandboxJobRequest, SandboxExecutor, SandboxOutcomeSink } from '../src/modules/sandbox/sandbox.contracts';

// @ts-expect-error durable job identity is required
const missing: SandboxJobRequest = { operation: 'destroy' };
export async function consume(executor: SandboxExecutor, sink: SandboxOutcomeSink): Promise<void> {
  const identity = { sessionId: 's', puzzleKey: 'p', generation: 1, namespace: 'n', podName: 'pod' };
  await executor.execute({ ...identity, commandId: 'c', command: 'SELECT 1' });
  await sink.record({ ...identity, jobId: 'j', kind: 'ready', occurredAt: '2026-11-01T00:00:00.000Z' });
  // @ts-expect-error failures require a stable error code and operation
  await sink.record({ ...identity, jobId: 'j', kind: 'failed', occurredAt: '2026-11-01T00:00:00.000Z' });
}
void missing;
