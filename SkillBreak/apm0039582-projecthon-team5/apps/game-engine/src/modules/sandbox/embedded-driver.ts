import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OnModuleDestroy } from '@nestjs/common';
import { parse } from 'pgsql-ast-parser';
import type { ProvisionJob, SandboxIdentity } from './sandbox.contracts';
import type { HelperMode, SandboxDriver, SandboxResource } from './sandbox-driver';
import { SandboxExecutionError } from './sandbox-errors';
import { validateSandboxIdentity } from './sandbox.repository';
import { defaultFixture, EmbeddedSql } from './embedded-sql';
import { EmbeddedGit } from './embedded-git';
import { room2GitPolicy } from './git-command';
import { isAllowedSeed } from './sandbox-seeds';
import { room2GitFixture, room2GitImageDigest } from '../script-catalog/room2';

/** Pinned identity of the embedded runtime: the content digest of the fixture it serves (no image exists). */
export function embeddedImageDigest(fixturePath = defaultFixture): string {
  return `embedded/room1-sql@sha256:${createHash('sha256').update(readFileSync(fixturePath)).digest('hex')}`;
}

// Same seed, limits, diagnostics and token rules as sandboxes/sql/query-helper.mjs (the pod helper).
const seedRef = 'room1-sql-v1';
const expectedHash = 'ea7e95b64496fb6f22959c4a2f6442ab5bd4d8a2ba9c5a0ff9404ee792a6ac90';
const outputLimit = 65536;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rowStatements = new Set(['select', 'union', 'union all', 'values', 'with', 'with recursive']);

interface Instance { uid: string; tokens: Map<string, 'running' | 'done'>; seedRef: string; git?: EmbeddedGit }

const gitSeedRef = 'room2-git-v1';

function resource(uid: string): SandboxResource {
  return { metadata: { uid }, status: { phase: 'Running' } };
}

function diagnostic(code?: string): string {
  if (code === '42501' || code === '25006') return 'SQL operation is not permitted.\n';
  if (code === '42601') return 'SQL syntax is invalid; submit one statement.\n';
  if (code && /^[0-9A-Z]{5}$/.test(code)) return 'SQL query failed.\n';
  throw new SandboxExecutionError('runtimeUnavailable');
}

function streamsRows(command: string): boolean {
  try { return rowStatements.has(parse(command)[0]?.type ?? ''); } catch { return false; }
}

/**
 * Runs each sandbox inside the engine process instead of a pod (docs/adr/0001-embedded-sandbox-driver.md).
 * Room 1 SQL sandboxes are logical instances over one read-only embedded Postgres. Room 2 git sandboxes
 * each own a writable in-memory git repository (isomorphic-git on memfs) in a worker thread.
 */
export class EmbeddedDriver implements SandboxDriver, OnModuleDestroy {
  private readonly instances = new Map<string, Instance>();
  private readonly image: string;
  private readonly gitImage: string;
  private readonly gitHead: string;

  constructor(private readonly sql = new EmbeddedSql(), private readonly queryTimeoutMs = 5000, fixturePath = defaultFixture,
    private readonly gitFixturePath = room2GitFixture,
    private readonly gitFactory: () => EmbeddedGit = () => new EmbeddedGit(room2GitPolicy, gitFixturePath)) {
    this.image = embeddedImageDigest(fixturePath);
    this.gitImage = room2GitImageDigest(gitFixturePath);
    const commits = (JSON.parse(readFileSync(gitFixturePath, 'utf8')) as { commits: { oid: string }[] }).commits;
    this.gitHead = commits[commits.length - 1].oid;
  }

  validateImage(image: string): void {
    // Like the Kubernetes allowlist: only the template published for this embedded fixture may run here.
    if (image !== this.image && image !== this.gitImage) throw new SandboxExecutionError('imageNotPinned');
  }

  async confirmAbsent(identity: SandboxIdentity): Promise<boolean> {
    validateSandboxIdentity(identity);
    return !this.instances.has(identity.podName);
  }

  async checkAvailable(): Promise<void> {
    try { await this.sql.start(); } catch { throw new SandboxExecutionError('runtimeUnavailable'); }
  }

  async read(job: ProvisionJob, uid?: string): Promise<SandboxResource | null> {
    validateSandboxIdentity(job);
    const instance = this.instances.get(job.podName);
    if (!instance) return null;
    if (uid !== undefined && uid !== instance.uid) throw new SandboxExecutionError('ownershipConflict');
    return resource(instance.uid);
  }

  async ensure(job: ProvisionJob): Promise<SandboxResource> {
    if (!isAllowedSeed(job.seedRef, job.policyRef)) throw new SandboxExecutionError('templateMismatch');
    const existing = await this.read(job);
    if (existing) return existing;
    if (job.seedRef === gitSeedRef) {
      if (job.imageDigest !== this.gitImage) throw new SandboxExecutionError('imageNotPinned');
      const instance: Instance = { uid: randomUUID(), tokens: new Map(), seedRef: gitSeedRef, git: this.gitFactory() };
      this.instances.set(job.podName, instance);
      try { await this.startGit(instance); }
      catch (error) { this.instances.delete(job.podName); await instance.git!.close(); throw error; }
      return resource(instance.uid);
    }
    await this.checkAvailable();
    const instance: Instance = { uid: randomUUID(), tokens: new Map(), seedRef };
    this.instances.set(job.podName, instance);
    return resource(instance.uid);
  }

  async remove(job: ProvisionJob, uid: string): Promise<void> {
    const instance = this.instances.get(job.podName);
    if (instance?.uid !== uid) return;
    this.instances.delete(job.podName);
    await instance.git?.close();
  }

  async helper(job: ProvisionJob, uid: string, mode: HelperMode, input: Record<string, unknown> = {}): Promise<unknown> {
    if (!await this.read(job, uid)) throw new SandboxExecutionError('notReady');
    const instance = this.instances.get(job.podName)!;
    if (instance.git) return this.helperGit(instance, mode, input);
    if (mode === 'ready') return this.ready();
    if (mode === 'status' && input.probeSeed === true) {
      await this.checkAvailable();
      return { version: 1, seeded: true, seedRef };
    }
    if (mode === 'status' || mode === 'cancel') return this.token(instance, input, mode === 'cancel');
    if (mode === 'query') return this.query(instance, input);
    // 'inspect' probes pod isolation controls, which an embedded sandbox does not have.
    throw new SandboxExecutionError('policyBlocked');
  }

  async preflight(image: string): Promise<unknown> {
    this.validateImage(image);
    if (image === this.gitImage) {
      const probe = this.gitFactory();
      try { await this.startGit({ uid: '', tokens: new Map(), seedRef: gitSeedRef, git: probe }); }
      finally { await probe.close(); }
      return { verified: true, embedded: true, outputLimit };
    }
    await this.checkAvailable();
    await this.ready();
    return { verified: true, embedded: true, outputLimit };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.instances.values()].map(instance => instance.git?.close()));
    await this.sql.close();
  }

  // The git thread verifies the rebuilt history against the fixture before it reports started.
  private async startGit(instance: Instance): Promise<void> {
    const head = await instance.git!.start().catch(() => { throw new SandboxExecutionError('runtimeUnavailable'); });
    if (head !== this.gitHead) throw new SandboxExecutionError('notReady');
  }

  private async helperGit(instance: Instance, mode: HelperMode, input: Record<string, unknown>): Promise<unknown> {
    const git = instance.git!;
    if (mode === 'ready') {
      // A sandbox restarted after an overrun is rebuilt from the fixture, so its first HEAD is always the fixture's.
      await this.startGit(instance);
      return { version: 1, ready: true, seedRef: gitSeedRef };
    }
    if (mode === 'status' && input.probeSeed === true) {
      await this.startGit(instance);
      return { version: 1, seeded: true, seedRef: gitSeedRef };
    }
    if (mode === 'status' || mode === 'cancel') {
      return this.token(instance, input, mode === 'cancel', () => git.close());
    }
    if (mode === 'query') return this.gitQuery(instance, input);
    if (mode === 'inspect') {
      // The sandbox's current HEAD, for the ruin check (R2-04): moved HEAD means the history was altered.
      const result = await git.run({ type: 'inspect' }, 2000).catch(() => { throw new SandboxExecutionError('runtimeUnavailable'); });
      if (result === 'timeout' || !('head' in result)) throw new SandboxExecutionError('runtimeUnavailable');
      return { version: 1, head: result.head, branch: result.branch, headMessage: result.headMessage,
        branchTip: result.branchTip, headInHistory: result.headInHistory, keyCommitPresent: result.keyCommitPresent };
    }
    throw new SandboxExecutionError('policyBlocked');
  }

  private async ready() {
    const result = await this.sql.run({ type: 'ready' }, 2000).catch(() => undefined);
    const rows = result && result !== 'timeout' && result.ok && 'rows' in result ? result.rows : [];
    if (rows.length !== 1 || rows[0][0] !== 'danaZ22' || rows[0][1] !== expectedHash) {
      throw new SandboxExecutionError('notReady');
    }
    return { version: 1, ready: true, seedRef };
  }

  private async token(instance: Instance, input: Record<string, unknown>, cancel: boolean,
    stop: () => Promise<unknown> = () => this.sql.restart()) {
    const executionToken = input.executionToken;
    if (typeof executionToken !== 'string' || !uuid.test(executionToken)) throw new SandboxExecutionError('runtimeUnavailable');
    const state = instance.tokens.get(executionToken);
    // An unknown token is claimed now, so a later query with it is refused, as in the pod helper.
    if (!state) instance.tokens.set(executionToken, 'done');
    if (state === 'running' && cancel) {
      await stop();
      instance.tokens.set(executionToken, 'done');
    }
    return { version: 1, executionToken, quiesced: instance.tokens.get(executionToken) === 'done' };
  }

  private async query(instance: Instance, input: Record<string, unknown>) {
    const { executionToken, commandId, command } = input;
    if (typeof executionToken !== 'string' || !uuid.test(executionToken) || typeof commandId !== 'string'
      || !uuid.test(commandId) || typeof command !== 'string' || !command.trim() || command.length > 4096
      || command.includes('\0') || instance.tokens.has(executionToken)) throw new SandboxExecutionError('runtimeUnavailable');
    instance.tokens.set(executionToken, 'running');
    const result = { version: 1, commandId, stdout: '', stderr: '', exitCode: null as number | null, timedOut: false, truncated: false };
    try {
      const outcome = await this.sql.run({ type: 'query', command, cursor: streamsRows(command), limit: outputLimit },
        this.queryTimeoutMs).catch(() => { throw new SandboxExecutionError('runtimeUnavailable'); });
      if (outcome === 'timeout') {
        result.timedOut = true;
        result.stderr = 'SQL execution timed out.\n';
      } else if (outcome.ok && 'stdout' in outcome) {
        result.stdout = outcome.stdout;
        result.truncated = outcome.truncated;
        result.exitCode = outcome.truncated ? null : 0;
      } else if (!outcome.ok) {
        result.stderr = diagnostic(outcome.code);
        result.exitCode = 1;
      } else throw new SandboxExecutionError('runtimeUnavailable');
    } finally { instance.tokens.set(executionToken, 'done'); }
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) result.stdout = '';
    return result;
  }

  // Same envelope as query(); the repository runs in the sandbox's own thread and an overrun discards it.
  private async gitQuery(instance: Instance, input: Record<string, unknown>) {
    const { executionToken, commandId, command } = input;
    if (typeof executionToken !== 'string' || !uuid.test(executionToken) || typeof commandId !== 'string'
      || !uuid.test(commandId) || typeof command !== 'string' || !command.trim() || command.length > 4096
      || command.includes('\0') || instance.tokens.has(executionToken)) throw new SandboxExecutionError('runtimeUnavailable');
    instance.tokens.set(executionToken, 'running');
    const result = { version: 1, commandId, stdout: '', stderr: '', exitCode: null as number | null, timedOut: false, truncated: false };
    try {
      const outcome = await instance.git!.run({ type: 'run', command, limit: outputLimit }, this.queryTimeoutMs)
        .catch(() => { throw new SandboxExecutionError('runtimeUnavailable'); });
      if (outcome === 'timeout') {
        result.timedOut = true;
        result.stderr = 'Command timed out.\n';
      } else if (outcome.ok && 'stdout' in outcome) {
        Object.assign(result, { stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated, exitCode: outcome.exitCode });
      } else throw new SandboxExecutionError('runtimeUnavailable');
    } finally { instance.tokens.set(executionToken, 'done'); }
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) result.stdout = '';
    return result;
  }
}
