import { createHash } from 'node:crypto';
import type { SandboxIdentity } from '../../sandbox/sandbox.contracts';

export function uuidV5(name: string): string {
  const namespace = '7a7dfa5509c65a08bf8e331572241135';
  const bytes = createHash('sha1').update(Buffer.from(namespace, 'hex')).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sandboxIdentity(sessionId: string, puzzleKey: string, generation: number): SandboxIdentity {
  const suffix = createHash('sha256').update(`${sessionId}:${puzzleKey}:${generation}`).digest('hex').slice(0, 32);
  return { sessionId, puzzleKey, generation, namespace: 'team5-sandboxes', podName: `sbx-${suffix}` };
}