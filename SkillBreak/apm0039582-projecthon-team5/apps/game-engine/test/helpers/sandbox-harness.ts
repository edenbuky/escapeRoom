import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { databaseOptions, loadConfig, type EngineConfig } from '../../src/config/config';

export type SandboxFaultPoint = 'afterClaim' | 'afterCreate' | 'afterSeed' | 'afterReadiness'
  | 'beforeDispatch' | 'afterDispatch' | 'beforeResultCommit' | 'afterResultCommit'
  | 'beforeOutcome' | 'afterOutcome';

export class SandboxHarness {
  readonly runId = randomUUID();
  readonly config: EngineConfig;
  database?: DataSource;
  clock: () => Date = () => new Date();
  readonly faults = new Map<SandboxFaultPoint, () => Promise<void>>();
  private readonly containers: string[] = [];
  private readonly pods = new Map<string, string>();

  constructor() {
    const secret = randomBytes(32).toString('hex');
    this.config = loadConfig({
      DATABASE_URL: `postgres://postgres:${secret}@127.0.0.1:1/sandbox_test`,
    });
  }

  async fault(point: SandboxFaultPoint): Promise<void> {
    await this.faults.get(point)?.();
  }

  async start(migrate = true): Promise<void> {
    try {
      const password = decodeURIComponent(new URL(this.config.databaseUrl).password);
      const pg = this.runContainer('postgres:16-alpine', '5432/tcp', [
        '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=sandbox_test',
        '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      ]);
      this.config.databaseUrl = `postgres://postgres:${password}@127.0.0.1:${pg}/sandbox_test`;
      const deadline = Date.now() + 30000;
      while (true) {
        const candidate = new DataSource(databaseOptions(this.config));
        try {
          await candidate.initialize();
          this.database = candidate;
          break;
        } catch {
          if (candidate.isInitialized) await candidate.destroy();
          if (Date.now() >= deadline) throw new Error('Disposable sandbox PostgreSQL did not become ready');
          await delay(150);
        }
      }
      if (migrate) await this.database.runMigrations();
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Sandbox harness startup and cleanup failed'); }
      throw error;
    }
  }

  requireLocalRuntime(): void {
    if (process.env.SANDBOX_KUBE_CONTEXT !== 'kind-skillbreak-local' || !process.env.KUBECONFIG) {
      throw new Error('Runtime tests require explicit KUBECONFIG and SANDBOX_KUBE_CONTEXT=kind-skillbreak-local');
    }
    const localKind = resolve(__dirname, '../../../../.local/bin/kind');
    this.command(existsSync(localKind) ? localKind : 'kind', ['version']);
    this.kubectl(['get', 'namespace', 'team5-sandboxes', '-o', 'name']);
  }

  ownPod(name: string): void {
    if (!/^sbx-[a-f0-9]{32}$/.test(name)) throw new Error('Noncanonical sandbox test pod name');
    const pod: { metadata: { uid: string; labels?: Record<string, string> } } = JSON.parse(
      this.kubectl(['get', 'pod', name, '-n', 'team5-sandboxes', '-o', 'json']));
    if (pod.metadata.labels?.['team5.test-run'] !== this.runId || !pod.metadata.uid) {
      throw new Error('Refusing to own unrelated test pod');
    }
    this.pods.set(name, pod.metadata.uid);
  }

  async restartDatabaseClient(): Promise<void> {
    if (!this.database) throw new Error('Sandbox database has not started');
    await this.database.destroy();
    this.database = new DataSource(databaseOptions(this.config));
    await this.database.initialize();
  }

  async close(): Promise<void> {
    const failures: Error[] = [];
    for (const [name, uid] of this.pods) {
      try {
        const present = this.kubectl(['get', 'pod', name, '-n', 'team5-sandboxes', '--ignore-not-found', '-o', 'name']);
        if (!present.trim()) { this.pods.delete(name); continue; }
        this.kubectl(['delete', '--raw', `/api/v1/namespaces/team5-sandboxes/pods/${name}`, '-f', '-'],
          JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } }));
        this.kubectl(['wait', '--for=delete', `pod/${name}`, '-n', 'team5-sandboxes', '--timeout=30s']);
        this.pods.delete(name);
      } catch { failures.push(new Error(`Cleanup failed for owned sandbox pod ${name} UID ${uid}`)); }
    }
    if (this.database?.isInitialized) {
      try { await this.database.destroy(); }
      catch { failures.push(new Error('Sandbox database client cleanup failed')); }
    }
    for (const id of [...this.containers]) {
      try {
        this.command('docker', ['stop', '--time', '1', id]);
        this.containers.splice(this.containers.indexOf(id), 1);
      } catch { failures.push(new Error(`Cleanup failed for owned sandbox test container ${id}`)); }
    }
    if (failures.length) throw new AggregateError(failures, 'Sandbox harness cleanup incomplete');
  }

  executionCount(name: string, fingerprint: string): number {
    const uid = this.pods.get(name);
    if (!uid || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Execution count requires an owned pod and fingerprint');
    const pod: { metadata: { uid: string } } = JSON.parse(
      this.kubectl(['get', 'pod', name, '-n', 'team5-sandboxes', '-o', 'json']));
    if (pod.metadata.uid !== uid) throw new Error('Execution-count pod ownership changed');
    const output = this.kubectl(['exec', '-n', 'team5-sandboxes', name, '--', 'node', '-e',
      `const fs=require('node:fs');const root='/tmp/sql-executions';
      const count=fs.readdirSync(root).filter(token=>{const file=root+'/'+token+'/owner';
        return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8')).fingerprint===process.argv[1]}).length;
      process.stdout.write(String(count));`, fingerprint]);
    if (!/^[0-9]+$/.test(output)) throw new Error('Invalid owned execution count');
    return Number(output);
  }

  private runContainer(image: string, port: string, args: string[] = []): number {
    const id = this.command('docker', ['run', '--detach', '--rm', '--label', `team5.test-run=${this.runId}`,
      '--publish', `127.0.0.1::${port.split('/')[0]}`, ...args, image]).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return an owned test container identity');
    this.containers.push(id);
    const published = this.command('docker', ['port', id, port]).trim();
    const mapped = Number(published.split(':').pop());
    if (!Number.isInteger(mapped) || mapped < 1 || mapped > 65535) throw new Error('Test container port unavailable');
    return mapped;
  }

  private kubectl(args: string[], input?: string): string {
    if (process.env.SANDBOX_KUBE_CONTEXT !== 'kind-skillbreak-local' || !process.env.KUBECONFIG) {
      throw new Error('Refusing Kubernetes access without explicit local test context');
    }
    return this.command('kubectl', ['--context=kind-skillbreak-local', ...args], input);
  }

  private command(binary: string, args: string[], input?: string): string {
    try {
      return execFileSync(binary, args, { encoding: 'utf8', input, timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    } catch {
      throw new Error(`Sandbox harness ${binary} operation failed; check local prerequisites`);
    }
  }
}
