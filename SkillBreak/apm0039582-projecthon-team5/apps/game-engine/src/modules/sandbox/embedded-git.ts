import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { room2GitFixture } from '../script-catalog/room2';
import type { GitPolicy } from './git-command';

export type EmbeddedGitRequest =
  | { type: 'run'; command: string; limit: number }
  | { type: 'inspect' }
  | { type: 'sleep'; ms: number };
export type EmbeddedGitResult =
  | { ok: true; stdout: string; stderr: string; truncated: boolean; exitCode: number | null }
  | { ok: true; head: string; branch: string | null; headMessage: string;
    branchTip: string | null; headInHistory: boolean; keyCommitPresent: boolean }
  | { ok: true }
  | { ok: false };

interface Thread {
  worker: Worker;
  head: string;
  pending: Map<number, (result: EmbeddedGitResult | Error) => void>;
}

/**
 * One git sandbox: a repository on an in-memory file system, living in its own worker thread. Requests run
 * one at a time. A request that overruns terminates the thread; the next request starts a fresh one and
 * rebuilds the repository from the fixture, so a timed-out sandbox starts over from the original history.
 */
export class EmbeddedGit {
  private starting?: Promise<Thread>;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(private readonly policy: GitPolicy, private readonly fixturePath = room2GitFixture) {}

  /** Resolves with the HEAD oid of the rebuilt repository (already checked against the fixture). */
  async start(): Promise<string> {
    return (await this.thread()).head;
  }

  private thread(): Promise<Thread> {
    if (this.starting) return this.starting;
    const starting: Promise<Thread> = new Promise<Thread>((resolve, reject) => {
      const typescript = path.extname(__filename) === '.ts';
      const thread: Thread = {
        worker: new Worker(path.join(__dirname, `embedded-git.worker${path.extname(__filename)}`), {
          workerData: { fixturePath: this.fixturePath, policy: this.policy },
          ...(typescript ? { execArgv: ['-r', 'ts-node/register'] } : {}),
        }),
        head: '',
        pending: new Map(),
      };
      thread.worker.unref();
      thread.worker.on('message', (message: { type?: 'started'; head?: string; id?: number; result?: EmbeddedGitResult }) => {
        if (message.type === 'started') {
          thread.head = message.head!;
          resolve(thread);
        } else if (message.id !== undefined && message.result) {
          thread.pending.get(message.id)?.(message.result);
          thread.pending.delete(message.id);
        }
      });
      thread.worker.on('error', reject);
      thread.worker.on('exit', () => {
        if (this.starting === starting) this.starting = undefined;
        reject(new Error('Embedded git worker exited'));
        for (const settle of thread.pending.values()) settle(new Error('Embedded git worker exited'));
        thread.pending.clear();
      });
    });
    this.starting = starting;
    starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
    return starting;
  }

  /** Resolves 'timeout' when the request overran; the thread is then discarded. */
  run(request: EmbeddedGitRequest, timeoutMs: number): Promise<EmbeddedGitResult | 'timeout'> {
    const task = this.queue.then(async () => {
      const thread = await this.thread();
      const id = this.nextId++;
      return new Promise<EmbeddedGitResult | 'timeout'>((resolve, reject) => {
        const timer = setTimeout(() => {
          thread.pending.delete(id);
          resolve('timeout');
          if (this.starting) this.starting = undefined;
          void thread.worker.terminate();
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

  /** Stops whatever is running and drops the repository. */
  async close(): Promise<void> {
    const starting = this.starting;
    this.starting = undefined;
    const thread = await starting?.catch(() => undefined);
    if (thread) await thread.worker.terminate();
  }
}
