import { parentPort } from 'node:worker_threads';
import { handlers } from './crypto-tasks';

parentPort?.on('message', (task: { kind?: string }) => {
  parentPort!.postMessage(handlers[task.kind ?? 'hash'](task));
});
