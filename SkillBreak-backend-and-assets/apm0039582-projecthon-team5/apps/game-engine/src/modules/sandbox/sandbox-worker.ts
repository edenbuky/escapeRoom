import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import type { KubernetesDriver } from './kubernetes-driver';
import { validatePinnedImage } from './kubernetes-driver';
import type { ProvisionJob, SandboxOutcomeSink } from './sandbox.contracts';
import { SandboxExecutionError, type SandboxErrorCode } from './sandbox-errors';
import { SandboxRepository, type SandboxJobRow } from './sandbox.repository';

export class SandboxWorker {
  private readonly logger = new Logger(SandboxWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private recover?: () => Promise<void>;
  private image?: string;
  private failures = 0;
  private nextPoll = 0;
  status: 'disabled' | 'starting' | 'ready' | 'unavailable' = 'disabled';
  lastError?: SandboxErrorCode;

  constructor(private readonly database: DataSource, private readonly repository: SandboxRepository,
    private readonly driver: KubernetesDriver, private readonly concurrency: number) {}

  async initialize(image: string): Promise<void> {
    this.status = 'starting';
    this.image = image;
    try {
      const [row]: { present: boolean }[] = await this.database.query(`SELECT
        to_regclass('sandbox_instances') IS NOT NULL AND to_regclass('sandbox_executions') IS NOT NULL
        AND to_regclass('sandbox_outcomes') IS NOT NULL AS present`);
      if (!row?.present) throw new SandboxExecutionError('persistenceFailure');
      await this.driver.preflight(image);
      this.status = 'ready';
      this.lastError = undefined;
      this.failures = 0;
      this.nextPoll = 0;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async start(sink: SandboxOutcomeSink, recover?: () => Promise<void>): Promise<void> {
    const [row]: { image: string }[] = await this.database.query(`SELECT definition->>'imageDigest' AS image
      FROM catalog.component_templates WHERE key='idan-db-sql' AND engine='sql' AND status='published'
      ORDER BY version DESC LIMIT 1`);
    if (!row?.image) throw new SandboxExecutionError('imageNotPinned');
    await this.initialize(row.image);
    this.recover = recover;
    this.timer = setInterval(() => {
      if (this.pending || this.stopped || Date.now() < this.nextPoll) return;
      this.pending = (async () => {
        await this.runOnce(sink);
        if (this.status === 'unavailable' && this.image) await this.initialize(this.image);
      })().catch(error => { this.fail(error); }).finally(() => { this.pending = undefined; });
    }, 100);
    this.timer.unref();
  }

  async runOnce(sink: SandboxOutcomeSink): Promise<void> {
    if (this.stopped || this.status === 'disabled' || this.status === 'starting') throw new SandboxExecutionError('stopped');
    await this.repository.recoverConnections();
    await this.recover?.();
    const jobs = await this.repository.pendingJobs(this.concurrency);
    await Promise.all(jobs.map(async candidate => {
      try {
        await this.repository.withLock(candidate.request, async runner => {
          const job = await this.repository.claim(runner, candidate.job_id);
          if (!job) return;
          if (job.status === 'waiting_cleanup') await this.cleanup(runner, job);
          else if (job.request.operation === 'provision') await this.provision(runner, job, job.request);
          else await this.destroy(runner, job);
        });
      } catch (error) {
        if (error instanceof SandboxExecutionError && error.code === 'capacityExceeded') return;
        throw error;
      }
    }));
    // Sink acquires the session lock, so it must run after every sandbox lock is released.
    for (const outcome of await this.repository.pendingOutcomes()) {
      try { await sink.record(outcome); }
      catch {
        this.logger.warn('Sandbox outcome delivery failed; durable retry scheduled');
        await this.repository.outcomeDelivered(outcome, false);
        continue;
      }
      await this.repository.outcomeDelivered(outcome, true);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }

  async checkRuntime(): Promise<boolean> {
    if (this.status !== 'ready') return false;
    try { await this.driver.checkAvailable(); return true; }
    catch (error) { this.fail(error); return false; }
  }

  private async provision(runner: QueryRunner, row: SandboxJobRow, job: ProvisionJob): Promise<void> {
    try {
      if (!await this.repository.currentProvision(runner, job)) {
        await this.repository.supersede(runner, job.jobId);
        return;
      }
      await this.assertDeadline(runner, row);
      if (this.status !== 'ready') throw new SandboxExecutionError('runtimeUnavailable');
      validatePinnedImage(job.imageDigest, this.driver.options.imageAllowlist);
      if (job.seedRef !== 'room1-sql-v1') throw new SandboxExecutionError('templateMismatch');
      await this.repository.createInstance(runner.manager, { ...job, templateRef: job.policyRef, seedRef: job.seedRef });
      const instance = await this.repository.instance(runner, job);
      if (!instance || instance.desired_state !== 'ready') {
        await this.repository.supersede(runner, job.jobId);
        return;
      }
      const pod = instance.pod_uid ? await this.driver.read(job, instance.pod_uid) : await this.driver.ensure(job);
      if (instance.pod_uid && !pod) throw new SandboxExecutionError('readinessFailed');
      if (!pod?.metadata?.uid) throw new SandboxExecutionError('notReady');
      await runner.query('UPDATE sandbox_instances SET pod_uid=$2,updated_at=now() WHERE sandbox_id=$1',
        [job.podName, pod.metadata.uid]);
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        throw new SandboxExecutionError('readinessFailed');
      }
      if (pod.status?.phase !== 'Running') { await this.repository.schedule(runner, job.jobId); return; }
      if (instance.status === 'ready') { await this.repository.stage(runner, job, 'ready'); return; }
      const seeded = await this.driver.helper(job, pod.metadata.uid, 'status', { probeSeed: true }, 2000);
      if (!this.matches(seeded, 'seeded')) { await this.repository.schedule(runner, job.jobId); return; }
      row = await this.repository.beginReadiness(runner, job.jobId);
      await this.assertDeadline(runner, row);
      const ready = await this.driver.helper(job, pod.metadata.uid, 'ready', {}, 2000);
      if (!this.matches(ready, 'ready')) throw new SandboxExecutionError('notReady');
      await this.assertDeadline(runner, row);
      await this.repository.stage(runner, job, 'ready');
    } catch (error) {
      if (!(error instanceof SandboxExecutionError)) throw error;
      let code = error.code;
      const now = await this.repository.now(runner);
      if (row.deadline_at && now >= row.deadline_at) code = 'provisionTimeout';
      else if (row.readiness_checks >= 3 || (row.readiness_started_at
        && now.getTime() >= row.readiness_started_at.getTime() + 10000)) code = 'readinessFailed';
      if (['notReady', 'runtimeUnavailable'].includes(code)) {
        this.logger.warn(`Sandbox provisioning retry: ${code}`);
        await this.repository.schedule(runner, job.jobId, code);
      } else {
        this.logger.warn(`Sandbox provisioning failed: ${code}`);
        await this.repository.stage(runner, job, 'failed', code);
      }
    }
  }

  private async assertDeadline(runner: QueryRunner, row: SandboxJobRow): Promise<void> {
    const now = await this.repository.now(runner);
    if (!row.deadline_at || now >= row.deadline_at) throw new SandboxExecutionError('provisionTimeout');
    if (row.readiness_started_at && now.getTime() >= row.readiness_started_at.getTime() + 10000) {
      throw new SandboxExecutionError('readinessFailed');
    }
  }

  private matches(value: unknown, key: 'ready' | 'seeded'): boolean {
    return value !== null && typeof value === 'object' && Reflect.get(value, 'version') === 1
      && Reflect.get(value, key) === true && Reflect.get(value, 'seedRef') === 'room1-sql-v1';
  }

  private async cleanup(runner: QueryRunner, row: SandboxJobRow): Promise<void> {
    if (row.request.operation !== 'provision') throw new SandboxExecutionError('persistenceFailure');
    try {
      const instance = await this.repository.instance(runner, row.request);
      const pod = await this.driver.read(row.request, instance?.pod_uid ?? undefined);
      if (pod?.metadata?.uid) await this.driver.remove(row.request, pod.metadata.uid);
      await runner.query(`UPDATE sandbox_instances SET desired_state='destroyed',status='destroyed',updated_at=now()
        WHERE sandbox_id=$1`, [row.request.podName]);
      await runner.query("UPDATE engine_sandbox_requests SET status='failed',updated_at=now() WHERE job_id=$1", [row.job_id]);
    } catch (error) {
      if (!(error instanceof SandboxExecutionError)) throw error;
      this.logger.warn(`Sandbox cleanup retry: ${error.code}`);
      await this.repository.schedule(runner, row.job_id, error.code);
    }
  }

  private async destroy(runner: QueryRunner, row: SandboxJobRow): Promise<void> {
    const job = row.request;
    const instance = await this.repository.instance(runner, job);
    await runner.query(`UPDATE sandbox_instances SET desired_state='destroyed',status='destroying',updated_at=now()
      WHERE sandbox_id=$1 AND status<>'destroyed'`, [job.podName]);
    if (instance?.active_command_id) { await this.repository.schedule(runner, row.job_id, 'inProgress'); return; }
    try {
      const [provision]: { request: ProvisionJob }[] = await runner.query(`SELECT request FROM engine_sandbox_requests
        WHERE session_id=$1 AND request->>'puzzleKey'=$2 AND (request->>'generation')::int=$3
        AND request->>'operation'='provision' ORDER BY created_at LIMIT 1`, [job.sessionId, job.puzzleKey, job.generation]);
      if (provision) {
        const pod = await this.driver.read(provision.request, instance?.pod_uid ?? undefined);
        if (pod?.metadata?.uid) await this.driver.remove(provision.request, pod.metadata.uid);
      } else if (!await this.driver.confirmAbsent(job)) throw new SandboxExecutionError('ownershipConflict');
      await this.repository.stage(runner, job, 'destroyed');
    } catch (error) {
      if (!(error instanceof SandboxExecutionError)) throw error;
      this.logger.warn(`Sandbox destroy retry: ${error.code}`);
      await this.repository.schedule(runner, row.job_id, error.code);
    }
  }

  private fail(error: unknown): void {
    this.status = 'unavailable';
    this.nextPoll = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.lastError = error instanceof SandboxExecutionError ? error.code : 'persistenceFailure';
    this.logger.error(`Sandbox worker unavailable: ${this.lastError}`);
  }
}
