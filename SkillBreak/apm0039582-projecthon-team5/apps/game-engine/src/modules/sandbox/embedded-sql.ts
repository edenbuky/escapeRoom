import path from 'node:path';
import { Worker } from 'node:worker_threads';

export type EmbeddedSqlRequest = { type: 'ready' } | { type: 'query'; command: string; cursor: boolean; limit: number };
export type EmbeddedSqlResult =
  | { ok: true; stdout: string; truncated: boolean }
  | { ok: true; rows: unknown[][] }
  | { ok: false; code?: string };

interface Thread {
  worker: Worker;
  pending: Map<number, (result: EmbeddedSqlResult | Error) => void>;
}

export const defaultFixture = path.resolve(__dirname, '../../../../../sandboxes/sql/fixtures/room1-sql-v1.sql');

/** One embedded Postgres in a worker thread. Requests run one at a time; an overrun restarts the thread. */
export class EmbeddedSql {
  private starting?: Promise<Thread>;
  private current?: Thread;
  private snapshot?: ArrayBuffer;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(private readonly fixturePath = defaultFixture) {}

  start(): Promise<Thread> {
    if (this.starting) return this.starting;
    const starting: Promise<Thread> = new Promise<Thread>((resolve, reject) => {
      const typescript = path.extname(__filename) === '.ts';
      const thread: Thread = {
        worker: new Worker(path.join(__dirname, `embedded-sql.worker${path.extname(__filename)}`), {
          workerData: { fixturePath: this.fixturePath, snapshot: this.snapshot },
          ...(typescript ? { execArgv: ['-r', 'ts-node/register'] } : {}),
        }),
        pending: new Map(),
      };
      thread.worker.unref();
      thread.worker.on('message', (message: { type?: 'started'; snapshot?: ArrayBuffer; id?: number; result?: EmbeddedSqlResult }) => {
        if (message.type === 'started') {
          this.snapshot ??= message.snapshot;
          if (this.starting === starting) this.current = thread;
          resolve(thread);
        } else if (message.id !== undefined && message.result) {
          thread.pending.get(message.id)?.(message.result);
          thread.pending.delete(message.id);
        }
      });
      thread.worker.on('error', reject);
      thread.worker.on('exit', () => {
        this.forget(thread);
        if (this.starting === starting) this.starting = undefined;
        reject(new Error('Embedded SQL worker exited'));
        for (const settle of thread.pending.values()) settle(new Error('Embedded SQL worker exited'));
        thread.pending.clear();
      });
    });
    this.starting = starting;
    starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
    return starting;
  }

  /** Resolves 'timeout' when the request overran; the thread is then replaced from the snapshot. */
  run(request: EmbeddedSqlRequest, timeoutMs: number): Promise<EmbeddedSqlResult | 'timeout'> {
    const task = this.queue.then(async () => {
      const thread = await this.start();
      const id = this.nextId++;
      return new Promise<EmbeddedSqlResult | 'timeout'>((resolve, reject) => {
        const timer = setTimeout(() => {
          thread.pending.delete(id);
          resolve('timeout');
          void this.stop(thread);
        }, timeoutMs);
        thread.pending.set(id, result => {
          clearTimeout(timer);
          if (result instanceof Error) reject(result); else resolve(result);
        });
        thread.worker.postMessage({ id, ...request });
      });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Stops whatever is running; the next request starts a fresh thread from the snapshot. */
  async restart(): Promise<void> {
    const starting = this.starting;
    this.starting = undefined;
    this.current = undefined;
    const thread = await starting?.catch(() => undefined);
    if (thread) await thread.worker.terminate();
  }

  close(): Promise<void> {
    return this.restart();
  }

  // Synchronous, so a queued request never picks up a thread that is being terminated.
  private stop(thread: Thread): Promise<number> {
    this.forget(thread);
    return thread.worker.terminate();
  }

  private forget(thread: Thread): void {
    if (this.current !== thread) return;
    this.current = undefined;
    this.starting = undefined;
  }
}
