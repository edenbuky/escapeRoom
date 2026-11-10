import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { RsaOutcome, RsaTask, TlsOutcome, TlsTask } from './crypto-tasks';

interface Task {
  payload: object; resolve: (value: any) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; slot?: Slot;
}
interface Slot { worker: Worker; task?: Task }

/** Worker pool for CPU-bound crypto tasks ({ kind: 'hash' | 'rsa' | ... } handled in crypto-tasks.ts). */
export class CryptoPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private readonly terminating = new Set<Promise<number>>();
  private closed = false;
  constructor(private readonly timeoutMs = 2000, private readonly size = 2,
    private readonly workerFactory = () => new Worker(path.join(__dirname, `crypto.worker${path.extname(__filename)}`),
      path.extname(__filename) === '.ts' ? { execArgv: ['-r', 'ts-node/register'] } : {})) {
    if (!Number.isInteger(size) || size < 1 || timeoutMs < 1) throw new Error('Invalid crypto pool limits');
  }

  compare(input: string, expected: string): Promise<boolean> { return this.run({ kind: 'hash', input, expected }); }
  rsa(task: RsaTask): Promise<RsaOutcome> { return this.run({ kind: 'rsa', ...task }); }
  tls(task: TlsTask): Promise<TlsOutcome> { return this.run({ kind: 'tls', ...task }); }

  run<T>(payload: { kind: string; [key: string]: unknown }): Promise<T> {
    if (this.closed || this.queue.length >= 100) return Promise.reject(new Error('Crypto worker unavailable'));
    return new Promise<T>((resolve, reject) => {
      const task: Task = { payload, resolve, reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(task);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error('Crypto worker timeout'));
          if (task.slot) this.replace(task.slot);
        }, this.timeoutMs) };
      this.queue.push(task);
      while (this.slots.length < this.size) this.slots.push(this.createSlot());
      this.dispatch();
    });
  }
  private createSlot(): Slot {
    const slot: Slot = { worker: this.workerFactory() };
    slot.worker.on('message', (value: unknown) => {
      const task = slot.task;
      if (!task) return;
      clearTimeout(task.timer);
      slot.task = undefined;
      task.slot = undefined;
      task.resolve(value);
      this.dispatch();
    });
    slot.worker.on('error', () => this.replace(slot));
    slot.worker.on('exit', () => { if (!this.closed && this.slots.includes(slot)) this.replace(slot); });
    return slot;
  }
  private terminate(worker: Worker) {
    const pending = worker.terminate();
    this.terminating.add(pending);
    void pending.finally(() => this.terminating.delete(pending));
  }
  private replace(slot: Slot) {
    const index = this.slots.indexOf(slot);
    if (index < 0 || this.closed) return;
    if (slot.task) { clearTimeout(slot.task.timer); slot.task.reject(new Error('Crypto worker unavailable')); }
    this.slots.splice(index, 1);
    this.terminate(slot.worker);
    this.slots.push(this.createSlot());
    this.dispatch();
  }
  private dispatch() {
    for (const slot of this.slots) {
      if (slot.task) continue;
      const task = this.queue.shift();
      if (!task) break;
      slot.task = task;
      task.slot = slot;
      slot.worker.postMessage(task.payload);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const task of [...this.queue, ...this.slots.flatMap(slot => slot.task ? [slot.task] : [])]) {
      clearTimeout(task.timer); task.reject(new Error('Crypto worker closed'));
    }
    this.queue.length = 0;
    this.slots.forEach(slot => this.terminate(slot.worker));
    await Promise.all(this.terminating);
    this.slots.length = 0;
  }
  async onApplicationShutdown(): Promise<void> { await this.close(); }
}

/** Kept so existing imports keep working; the hash pool is the generic crypto pool. */
export class HashPool extends CryptoPool {}
