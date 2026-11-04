import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { sandboxIdentity, uuidV5 } from '../sessions/core/ids';
import type { ProvisionJob, SandboxIdentity, SandboxJobRequest, SandboxOutcome } from './sandbox.contracts';
import type { PuzzleState, Snapshot } from '../sessions/core/state';
import { SandboxExecutionError, type SandboxErrorCode } from './sandbox-errors';

export function validateSandboxIdentity(identity: SandboxIdentity): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity.sessionId)
    || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(identity.puzzleKey)
    || !Number.isSafeInteger(identity.generation) || identity.generation < 1 || identity.generation > 2147483647) {
    throw new SandboxExecutionError('invalidIdentity');
  }
  const expected = sandboxIdentity(identity.sessionId, identity.puzzleKey, identity.generation);
  if (expected.namespace !== identity.namespace || expected.podName !== identity.podName) {
    throw new SandboxExecutionError('invalidIdentity');
  }
  return expected.podName;
}

export function inputFingerprint(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

export interface SandboxJobRow {
  job_id: string;
  session_id: string;
  request: SandboxJobRequest;
  status: 'pending' | 'running' | 'waiting_cleanup' | 'completed' | 'failed' | 'superseded';
  first_attempt_at: Date | null;
  deadline_at: Date | null;
  readiness_started_at: Date | null;
  readiness_checks: number;
  attempt_count: number;
}

export interface NewSandboxInstance extends SandboxIdentity {
  templateRef: string;
  imageDigest: string;
  seedRef: string;
  policyRef: string;
}

export interface SandboxInstanceRow {
  sandbox_id: string;
  pod_uid: string | null;
  template_ref: string;
  image_digest: string;
  seed_ref: string;
  policy_ref: string;
  status: 'provisioning' | 'ready' | 'failed' | 'destroying' | 'destroyed' | 'unavailable';
  desired_state: 'ready' | 'destroyed';
  active_command_id: string | null;
  lease_expires_at: Date;
  max_expires_at: Date;
}

export type LockResult<T> = { acquired: false } | { acquired: true; value: T };

export class SandboxRepository {
  private readonly logger = new Logger(SandboxRepository.name);
  private activeLocks = 0;
  private stopped = false;
  private readonly quarantined = new Map<QueryRunner, string>();
  private readonly sessions = new Map<QueryRunner, { pid: number; started: string }>();

  constructor(private readonly database: DataSource, private readonly maxLocks = 2) {
    if (!Number.isInteger(maxLocks) || maxLocks < 1 || maxLocks > 4) {
      throw new Error('Sandbox lock concurrency must be between 1 and 4');
    }
  }

  async withLock<T>(identity: SandboxIdentity, work: (runner: QueryRunner) => Promise<T>): Promise<LockResult<T>> {
    const key = `team5:sandbox:${validateSandboxIdentity(identity)}`;
    if (this.stopped) throw new SandboxExecutionError('stopped');
    if (this.quarantined.size) throw new SandboxExecutionError('lockCleanupFailed');
    if (this.activeLocks >= this.maxLocks) throw new SandboxExecutionError('capacityExceeded');
    const runner = this.database.createQueryRunner();
    this.activeLocks++;
    let mayHoldLock = false;
    let acquired = false;
    try {
      await runner.connect();
      mayHoldLock = true;
      const [row]: { acquired: boolean; pid: number; backend_start: string }[] = await runner.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired,pg_backend_pid() AS pid,
          (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start`, [key]);
      if (!row || typeof row.acquired !== 'boolean') throw new SandboxExecutionError('persistenceFailure');
      if (!row.acquired) { mayHoldLock = false; return { acquired: false }; }
      acquired = true;
      if (!Number.isInteger(row.pid) || typeof row.backend_start !== 'string') {
        throw new SandboxExecutionError('persistenceFailure');
      }
      this.sessions.set(runner, { pid: row.pid, started: row.backend_start });
      const value = await work(runner);
      if (runner.isTransactionActive) throw new SandboxExecutionError('persistenceFailure');
      return { acquired: true, value };
    } catch (error) {
      throw this.failure(error);
    } finally {
      try {
        await this.release(runner, key, mayHoldLock, acquired);
      } finally { this.activeLocks--; }
    }
  }

  async pendingJobs(limit = this.maxLocks): Promise<SandboxJobRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid sandbox job batch size');
    try {
      return await this.database.query(`SELECT job_id,session_id,request,status,first_attempt_at,deadline_at,
        readiness_started_at,readiness_checks,attempt_count FROM engine_sandbox_requests
        WHERE status IN ('pending','running','waiting_cleanup') AND next_attempt_at <= now()
        ORDER BY created_at,job_id LIMIT $1`, [limit]);
    } catch (error) { throw this.failure(error); }
  }

  async claim(runner: QueryRunner, jobId: string): Promise<SandboxJobRow | undefined> {
    const [row]: SandboxJobRow[] = await runner.query(`WITH claimed AS (
      UPDATE engine_sandbox_requests SET status=CASE WHEN status='waiting_cleanup' THEN status ELSE 'running' END,
        first_attempt_at=coalesce(first_attempt_at,now()),
        deadline_at=CASE WHEN request->>'operation'='provision'
          THEN coalesce(deadline_at,now()+interval '60 seconds') ELSE NULL END,
        attempt_count=attempt_count+1,updated_at=now()
      WHERE job_id=$1 AND status IN ('pending','running','waiting_cleanup') AND next_attempt_at<=now()
      RETURNING *) SELECT * FROM claimed`, [jobId]);
    return row;
  }

  async now(runner: QueryRunner): Promise<Date> {
    const [row]: { time: Date }[] = await runner.query('SELECT now() AS time');
    if (!(row?.time instanceof Date)) throw new SandboxExecutionError('persistenceFailure');
    return row.time;
  }

  async instance(runner: QueryRunner, identity: SandboxIdentity): Promise<SandboxInstanceRow | undefined> {
    const [row]: SandboxInstanceRow[] = await runner.query('SELECT * FROM sandbox_instances WHERE sandbox_id=$1',
      [validateSandboxIdentity(identity)]);
    return row;
  }

  async currentProvision(runner: QueryRunner, job: ProvisionJob): Promise<boolean> {
    const rows: { puzzle: PuzzleState; session: Pick<Snapshot, 'status'>;
      definition: { imageDigest?: string; seedRef?: string } }[] = await runner.query(`
      SELECT p.state AS puzzle,s.state AS session,t.definition
      FROM session_puzzles p JOIN sessions s ON s.id=p.session_id
      JOIN catalog.component_templates t ON t.key || '@' || t.version::text=p.state->>'templateRef'
      WHERE p.session_id=$1 AND p.puzzle_key=$2 AND t.engine='sql' AND t.status='published'`,
    [job.sessionId, job.puzzleKey]);
    const row = rows[0];
    if (!row || row.session.status !== 'Active' || row.puzzle.status !== 'open'
      || row.puzzle.family !== 'sql' || row.puzzle.sandbox.generation !== job.generation) return false;
    if (row.puzzle.templateRef !== job.policyRef || row.definition.imageDigest !== job.imageDigest
      || row.definition.seedRef !== job.seedRef || job.seedRef !== 'room1-sql-v1') {
      throw new SandboxExecutionError('templateMismatch');
    }
    const destroy = await runner.query(`SELECT job_id FROM engine_sandbox_requests WHERE session_id=$1
      AND request->>'puzzleKey'=$2 AND (request->>'generation')::int=$3 AND request->>'operation'='destroy' LIMIT 1`,
    [job.sessionId, job.puzzleKey, job.generation]);
    return destroy.length === 0;
  }

  async schedule(runner: QueryRunner, jobId: string, code?: SandboxErrorCode): Promise<void> {
    await runner.query(`UPDATE engine_sandbox_requests
      SET status=CASE WHEN status='waiting_cleanup' THEN status ELSE 'pending' END,
        next_attempt_at=now()+interval '250 milliseconds',last_error_code=$2,updated_at=now()
      WHERE job_id=$1`, [jobId, code ?? null]);
  }

  async supersede(runner: QueryRunner, jobId: string): Promise<void> {
    await runner.query("UPDATE engine_sandbox_requests SET status='superseded',updated_at=now() WHERE job_id=$1", [jobId]);
  }

  async beginReadiness(runner: QueryRunner, jobId: string): Promise<SandboxJobRow> {
    const [row]: SandboxJobRow[] = await runner.query(`WITH checked AS (
      UPDATE engine_sandbox_requests SET readiness_started_at=coalesce(readiness_started_at,now()),
        readiness_checks=readiness_checks+1,updated_at=now() WHERE job_id=$1 AND readiness_checks<3
      RETURNING *) SELECT * FROM checked`, [jobId]);
    if (!row) throw new SandboxExecutionError('readinessFailed');
    return row;
  }

  async stage(runner: QueryRunner, job: SandboxJobRequest, kind: SandboxOutcome['kind'],
    errorCode?: SandboxErrorCode): Promise<void> {
    await runner.startTransaction();
    try {
      if (kind === 'ready' && job.operation === 'provision' && !await this.currentProvision(runner, job)) {
        await this.supersede(runner, job.jobId);
        await runner.commitTransaction();
        return;
      }
      const occurredAt = (await this.now(runner)).toISOString();
      const { sessionId, puzzleKey, generation, namespace, podName, jobId } = job;
      const identity = { sessionId, puzzleKey, generation, namespace, podName, jobId, occurredAt };
      const payload: SandboxOutcome = kind === 'failed'
        ? { ...identity, kind, operation: job.operation, errorCode: errorCode ?? 'runtimeUnavailable' }
        : { ...identity, kind };
      await runner.query(`INSERT INTO sandbox_outcomes(job_id,kind,payload) VALUES ($1,$2,$3)
        ON CONFLICT (job_id,kind) DO NOTHING`, [job.jobId, kind, payload]);
      await runner.query(`UPDATE engine_sandbox_requests SET status=$2,last_error_code=$3,updated_at=now(),
        next_attempt_at=now()+interval '250 milliseconds' WHERE job_id=$1`,
      [job.jobId, kind === 'failed' ? 'waiting_cleanup' : 'completed', errorCode ?? null]);
      if (kind === 'ready') {
        await runner.query("UPDATE sandbox_instances SET status='ready',updated_at=now() WHERE sandbox_id=$1",
          [job.podName]);
      } else {
        await runner.query(`UPDATE sandbox_instances SET desired_state='destroyed',status=$2,
          last_error_code=$3,updated_at=now() WHERE sandbox_id=$1`,
        [job.podName, kind === 'destroyed' ? 'destroyed' : 'failed', errorCode ?? null]);
      }
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }

  async pendingOutcomes(): Promise<SandboxOutcome[]> {
    await this.database.query(`UPDATE sandbox_outcomes o SET delivery_status='superseded'
      FROM sandbox_instances i JOIN session_puzzles p ON p.session_id=i.session_id AND p.puzzle_key=i.puzzle_key
      WHERE o.payload->>'podName'=i.sandbox_id AND o.kind='ready' AND o.delivery_status='pending'
      AND (i.desired_state='destroyed' OR (p.state#>>'{sandbox,generation}')::int IS DISTINCT FROM i.generation)`);
    const rows: { payload: SandboxOutcome }[] = await this.database.query(`SELECT payload FROM sandbox_outcomes
      WHERE delivery_status='pending' AND next_attempt_at<=now() ORDER BY created_at,job_id LIMIT 100`);
    return rows.map(row => row.payload);
  }

  async outcomeDelivered(outcome: SandboxOutcome, delivered: boolean): Promise<void> {
    await this.database.query(`UPDATE sandbox_outcomes SET attempt_count=attempt_count+1,
      delivery_status=CASE WHEN $3 THEN 'delivered' ELSE 'pending' END,
      delivered_at=CASE WHEN $3 THEN now() ELSE NULL END,
      next_attempt_at=now()+make_interval(secs=>least(30,1+attempt_count)),
      last_error_code=CASE WHEN $3 THEN NULL ELSE 'runtimeUnavailable' END
      WHERE job_id=$1 AND kind=$2 AND delivery_status='pending'`, [outcome.jobId, outcome.kind, delivered]);
  }

  async requestDestroy(runner: QueryRunner, identity: SandboxIdentity, code: SandboxErrorCode): Promise<void> {
    const id = validateSandboxIdentity(identity);
    if (!runner.isTransactionActive) throw new SandboxExecutionError('persistenceFailure');
    const jobId = uuidV5(`sandbox-destroy:${id}`);
    const request: SandboxJobRequest = { ...sandboxIdentity(identity.sessionId, identity.puzzleKey, identity.generation),
      jobId, operation: 'destroy' };
    await runner.query(`UPDATE sandbox_instances SET desired_state='destroyed',
      status=CASE WHEN status='destroyed' THEN status ELSE 'unavailable' END,last_error_code=$2,updated_at=now()
      WHERE sandbox_id=$1`, [id, code]);
    await runner.query(`INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)
      ON CONFLICT (job_id) DO NOTHING`, [jobId, identity.sessionId, request]);
    const rows = await runner.query('SELECT job_id FROM engine_sandbox_requests WHERE job_id=$1 AND request=$2::jsonb',
      [jobId, JSON.stringify(request)]);
    if (rows.length !== 1) throw new SandboxExecutionError('persistenceFailure');
  }

  async createInstance(manager: EntityManager, input: NewSandboxInstance): Promise<void> {
    const id = validateSandboxIdentity(input);
    try {
      const rows: { sandbox_id: string }[] = await manager.query(`INSERT INTO sandbox_instances(
        sandbox_id,session_id,puzzle_key,generation,namespace,pod_name,template_ref,image_digest,seed_ref,policy_ref)
        VALUES ($1,$2,$3,$4,$5,$1,$6,$7,$8,$9) ON CONFLICT (sandbox_id) DO NOTHING RETURNING sandbox_id`,
      [id, input.sessionId, input.puzzleKey, input.generation, input.namespace, input.templateRef,
        input.imageDigest, input.seedRef, input.policyRef]);
      if (rows.length) return;
      const existing = await manager.query(`SELECT sandbox_id FROM sandbox_instances WHERE sandbox_id=$1
        AND session_id=$2 AND puzzle_key=$3 AND generation=$4 AND namespace=$5 AND pod_name=$1
        AND template_ref=$6 AND image_digest=$7 AND seed_ref=$8 AND policy_ref=$9`,
      [id, input.sessionId, input.puzzleKey, input.generation, input.namespace, input.templateRef,
        input.imageDigest, input.seedRef, input.policyRef]);
      if (!existing.length) throw new SandboxExecutionError('templateMismatch');
    } catch (error) { throw this.failure(error); }
  }

  async saveInstanceError(manager: EntityManager, identity: SandboxIdentity, code: SandboxErrorCode): Promise<void> {
    const id = validateSandboxIdentity(identity);
    try {
      const rows = await manager.query(`UPDATE sandbox_instances SET last_error_code=$2,updated_at=now()
        WHERE sandbox_id=$1 RETURNING sandbox_id`, [id, code]);
      if (!rows[0]?.length) throw new SandboxExecutionError('notReady');
    } catch (error) { throw this.failure(error); }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.activeLocks) throw new SandboxExecutionError('busy');
    await this.recoverConnections();
  }

  async recoverConnections(): Promise<void> {
    const failures: Error[] = [];
    for (const [runner, key] of this.quarantined) {
      try {
        await this.release(runner, key, true);
        this.quarantined.delete(runner);
      } catch {
        const session = this.sessions.get(runner);
        if (session) {
          const present = await this.database.query(`SELECT pid FROM pg_stat_activity
            WHERE pid=$1 AND backend_start=$2::timestamptz`, [session.pid, session.started]);
          if (!present.length) {
            this.logger.warn('Quarantined sandbox database session confirmed absent');
            await runner.release();
            this.quarantined.delete(runner);
            this.sessions.delete(runner);
            continue;
          }
        }
        failures.push(new SandboxExecutionError('lockCleanupFailed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Sandbox lock cleanup incomplete');
  }

  private async release(runner: QueryRunner, key: string, mayHoldLock: boolean, acquired = false): Promise<void> {
    try {
      if (runner.isReleased) {
        if (mayHoldLock) throw new SandboxExecutionError('lockCleanupFailed');
        this.sessions.delete(runner);
        return;
      }
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (mayHoldLock) {
        const [row]: { unlocked: boolean }[] = await runner.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key]);
        if (!row || typeof row.unlocked !== 'boolean' || (acquired && !row.unlocked)) {
          throw new SandboxExecutionError('lockCleanupFailed');
        }
      }
      await runner.release();
      this.sessions.delete(runner);
    } catch {
      // Never return a connection with uncertain session-lock ownership to the pool.
      this.quarantined.set(runner, key);
      this.logger.error('Sandbox failure: lockCleanupFailed');
      throw new SandboxExecutionError('lockCleanupFailed');
    }
  }

  private failure(error: unknown): SandboxExecutionError {
    if (error instanceof SandboxExecutionError) return error;
    this.logger.error('Sandbox failure: persistenceFailure');
    return new SandboxExecutionError('persistenceFailure');
  }
}
