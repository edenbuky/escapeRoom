import { parentPort } from 'node:worker_threads';
import { timingSafeEqual } from 'node:crypto';

parentPort?.on('message', (task: { input: string; expected: string }) => {
  const input = Buffer.from(task.input, 'hex');
  const expected = Buffer.from(task.expected, 'hex');
  parentPort!.postMessage(input.length === expected.length && timingSafeEqual(input, expected));
});