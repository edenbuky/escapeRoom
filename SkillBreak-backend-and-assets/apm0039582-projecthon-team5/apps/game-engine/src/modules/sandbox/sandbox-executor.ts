import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import type { PuzzleState, Snapshot } from '../sessions/core/state';
import type { ExecRequest, ExecResult, ProvisionJob, SandboxExecutor, SandboxIdentity } from './sandbox.contracts';
import { SandboxExecutionError } from './sandbox-errors';
import { KubernetesDriver } from './kubernetes-driver';
import { inputFingerprint, SandboxRepository, validateSandboxIdentity, type SandboxInstanceRow } from './sandbox.repository';
import { validateSql } from './sql-policy';
import { validateHelperResult } from './sql-result';

interface ExecutionRow {
  command_id: string;
  sandbox_id: string;
  input_hash: string;
  execution_token: string;
  status: 'running' | 'completed' | 'interrupted';
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
}

export class SandboxExecutorService implements SandboxExecutor {
  private readonly logger = new Logger(SandboxExecutorService.name);
  private stopped = false;
  private readonly pending = new Set<Promise<ExecResult>>();

  constructor(private readonly database: DataSource, private readonly repository: SandboxRepository,
    private readonly driver: KubernetesDriver, private readonly isReady: () => boolean) {}

  async execute(request: ExecRequest): Promise<ExecResult> {
    const work = this.perform(request);
    this.pending.add(work);
    try { return await work; }
    finally { this.pending.delete(work); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
  }

  async recover(): Promise<void> {
    const rows: { command_id: string; identity: SandboxIdentity }[] = await this.database.query(`SELECT e.command_id,
      jsonb_build_object('sessionId',i.session_id,'puzzleKey',i.puzzle_key,'generation',i.generation,
        'namespace',i.namespace,'podName',i.pod_name) AS identity
      FROM sandbox_executions e JOIN sandbox_instances i ON i.sandbox_id=e.sandbox_id
      WHERE e.status='running' ORDER BY e.started_at LIMIT 4`);
    for (const row of rows) {
      try {
        await this.repository.withLock(row.identity, async runner => {
          const execution = await this.execution(row.command_id, runner);
          if (!execution || execution.status !== 'running') return;
          const instance = await this.repository.instance(runner, row.identity);
          if (!instance) throw new SandboxExecutionError('persistenceFailure');
          await this.interrupt(runner, row.identity, instance, execution);
        });
      } catch (error) {
        if (error instanceof SandboxExecutionError && error.code === 'capacityExceeded') continue;
        if (error instanceof SandboxExecutionError && ['runtimeUnavailable', 'ownershipConflict', 'notReady'].includes(error.code)) {
          this.logger.warn(`Sandbox recovery remains pending: ${error.code}`);
          await this.repository.saveInstanceError(this.database.manager, row.identity, error.code);
          continue;
        }
        throw this.failure(error);
      }
    }
  }

  private async perform(request: ExecRequest): Promise<ExecResult> {
    validateSandboxIdentity(request);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.commandId)
      || typeof request.command !== 'string') throw new SandboxExecutionError('invalidIdentity');
    const hash = inputFingerprint(request.command);
    try {
      const racedReplay = this.replay(await this.execution(request.commandId), request, hash);
      if (racedReplay) return racedReplay;
      if (this.stopped || !this.isReady()) throw new SandboxExecutionError('runtimeUnavailable');
      const locked = await this.repository.withLock(request, async runner => {
        const replay = this.replay(await this.execution(request.commandId, runner), request, hash);
        if (replay) return replay;
        const instance = await this.repository.instance(runner, request);
        await this.validateCurrent(runner, request, instance);
        if (!instance) throw new SandboxExecutionError('notReady');
        const now = await this.repository.now(runner);
        if (now >= instance.lease_expires_at || now >= instance.max_expires_at) {
          await this.transaction(runner, () => this.repository.requestDestroy(runner, request, 'expired'));
          throw new SandboxExecutionError('expired');
        }
        if (instance.status !== 'ready' || instance.desired_state !== 'ready' || !instance.pod_uid) {
          throw new SandboxExecutionError('notReady');
        }
        const destroy = await runner.query(`SELECT job_id FROM engine_sandbox_requests WHERE session_id=$1
          AND request->>'puzzleKey'=$2 AND (request->>'generation')::int=$3 AND request->>'operation'='destroy' LIMIT 1`,
        [request.sessionId, request.puzzleKey, request.generation]);
        if (destroy.length) throw new SandboxExecutionError('notReady');
        if (instance.active_command_id) throw new SandboxExecutionError('busy');
        const executionToken = randomUUID();
        await this.transaction(runner, async () => {
          await runner.query(`INSERT INTO sandbox_executions(command_id,sandbox_id,input_hash,execution_token)
            VALUES ($1,$2,$3,$4)`, [request.commandId, request.podName, hash, executionToken]);
          await runner.query(`UPDATE sandbox_instances SET active_command_id=$2,
            lease_expires_at=least(now()+interval '15 minutes',max_expires_at),updated_at=now()
            WHERE sandbox_id=$1`, [request.podName, request.commandId]);
        });
        const job = this.job(request, instance, request.commandId);
        try {
          const value = await this.driver.helper(job, instance.pod_uid, 'query',
            { executionToken, commandId: request.commandId, command: request.command }, 5500);
          const result = validateHelperResult(value, request.commandId);
          if (!await this.quiesced(job, instance.pod_uid, executionToken)) {
            throw new SandboxExecutionError('runtimeUnavailable');
          }
          await this.complete(runner, request, result);
          return result;
        } catch (error) {
          this.logger.warn('Accepted SQL execution failed; reconciling its consumed identity');
          const execution = await this.execution(request.commandId, runner);
          if (!execution) throw new SandboxExecutionError('persistenceFailure');
          if (execution.status === 'completed') return this.result(execution);
          await this.interrupt(runner, request, instance, execution);
          throw new SandboxExecutionError('interrupted');
        }
      });
      if (locked.acquired) return locked.value;
      const replay = this.replay(await this.execution(request.commandId), request, hash);
      if (replay) return replay;
      throw new SandboxExecutionError('busy');
    } catch (error) {
      if (error instanceof SandboxExecutionError && error.code === 'capacityExceeded') {
        throw new SandboxExecutionError('busy');
      }
      throw this.failure(error);
    }
  }

  private async validateCurrent(runner: QueryRunner, request: ExecRequest, instance?: SandboxInstanceRow): Promise<void> {
    const [row]: { puzzle: PuzzleState; session: Snapshot; definition: { policy: { maxQueryChars: number } } }[] =
      await runner.query(`SELECT p.state AS puzzle,s.state AS session,t.definition FROM session_puzzles p
        JOIN sessions s ON s.id=p.session_id JOIN catalog.component_templates t
          ON t.key || '@' || t.version::text=p.state->>'templateRef'
        WHERE p.session_id=$1 AND p.puzzle_key=$2 AND t.engine='sql' AND t.status='published'`,
      [request.sessionId, request.puzzleKey]);
    if (!row || row.puzzle.sandbox?.generation !== request.generation) throw new SandboxExecutionError('staleGeneration');
    if (row.session.status !== 'Active' || row.puzzle.status === 'locked'
      || !row.session.visitedRooms.includes(row.puzzle.roomKey)
      || (await this.repository.now(runner)).getTime() >= Date.parse(row.session.deadlineAt)) {
      throw new SandboxExecutionError('notReady');
    }
    if (instance && row.puzzle.templateRef !== instance.template_ref) throw new SandboxExecutionError('templateMismatch');
    validateSql(request.command, row.definition.policy.maxQueryChars);
  }

  private async execution(commandId: string, runner?: QueryRunner): Promise<ExecutionRow | undefined> {
    const [row]: ExecutionRow[] = await (runner ?? this.database).query(
      'SELECT * FROM sandbox_executions WHERE command_id=$1', [commandId]);
    return row;
  }

  private replay(row: ExecutionRow | undefined, request: ExecRequest, hash: string): ExecResult | undefined {
    if (!row) return undefined;
    if (row.sandbox_id !== request.podName || row.input_hash !== hash) throw new SandboxExecutionError('commandConflict');
    if (row.status === 'running') throw new SandboxExecutionError('inProgress');
    if (row.status === 'interrupted') throw new SandboxExecutionError('interrupted');
    return this.result(row);
  }

  private result(row: ExecutionRow): ExecResult {
    return { commandId: row.command_id, stdout: row.stdout, stderr: row.stderr,
      exitCode: row.exit_code, timedOut: row.timed_out, truncated: row.truncated };
  }

  private job(identity: SandboxIdentity, instance: SandboxInstanceRow, jobId: string): ProvisionJob {
    const { sessionId, puzzleKey, generation, namespace, podName } = identity;
    return { sessionId, puzzleKey, generation, namespace, podName, jobId, operation: 'provision',
      imageDigest: instance.image_digest, seedRef: instance.seed_ref, policyRef: instance.policy_ref };
  }

  private async quiesced(job: ProvisionJob, uid: string, executionToken: string): Promise<boolean> {
    for (const mode of ['status', 'cancel', 'status'] as const) {
      try {
        const value = await this.driver.helper(job, uid, mode, { executionToken }, 500);
        if (value !== null && typeof value === 'object' && Reflect.get(value, 'version') === 1
          && Reflect.get(value, 'executionToken') === executionToken && Reflect.get(value, 'quiesced') === true) return true;
      } catch (error) {
        this.logger.warn(`Token quiescence unavailable: ${error instanceof SandboxExecutionError ? error.code : 'runtimeUnavailable'}`);
      }
    }
    return false;
  }

  private async interrupt(runner: QueryRunner, identity: SandboxIdentity, instance: SandboxInstanceRow,
    execution: ExecutionRow): Promise<void> {
    if (execution.status !== 'running') return;
    const job = this.job(identity, instance, execution.command_id);
    let destroyed = false;
    if (!instance.pod_uid || !await this.quiesced(job, instance.pod_uid, execution.execution_token)) {
      await this.transaction(runner, () => this.repository.requestDestroy(runner, identity, 'interrupted'));
      this.logger.warn('Execution quiescence uncertain; admission fenced pending owned pod removal');
      if (instance.pod_uid) await this.driver.remove(job, instance.pod_uid);
      else if (!await this.driver.confirmAbsent(identity)) throw new SandboxExecutionError('ownershipConflict');
      destroyed = true;
    }
    await this.transaction(runner, async () => {
      await runner.query(`UPDATE sandbox_executions SET status='interrupted',error_code='interrupted',
        finished_at=now(),quiesced_at=now() WHERE command_id=$1 AND status='running'`, [execution.command_id]);
      await runner.query(`UPDATE sandbox_instances SET active_command_id=NULL,updated_at=now(),
        status=CASE WHEN $2 THEN 'destroyed' ELSE status END WHERE sandbox_id=$1`,
      [identity.podName, destroyed]);
    });
  }

  private async complete(runner: QueryRunner, request: ExecRequest, result: ExecResult): Promise<void> {
    await this.transaction(runner, async () => {
      await runner.query(`UPDATE sandbox_executions SET status='completed',stdout=$2,stderr=$3,exit_code=$4,
        timed_out=$5,truncated=$6,finished_at=now(),quiesced_at=now() WHERE command_id=$1 AND status='running'`,
      [request.commandId, result.stdout, result.stderr, result.exitCode, result.timedOut, result.truncated]);
      await runner.query('UPDATE sandbox_instances SET active_command_id=NULL,updated_at=now() WHERE sandbox_id=$1',
        [request.podName]);
    });
  }

  private async transaction(runner: QueryRunner, work: () => Promise<void>): Promise<void> {
    await runner.startTransaction();
    try { await work(); await runner.commitTransaction(); }
    catch (error) { if (runner.isTransactionActive) await runner.rollbackTransaction(); throw error; }
  }

  private failure(error: unknown): SandboxExecutionError {
    if (error instanceof SandboxExecutionError) return error;
    this.logger.error('Sandbox execution failed: persistenceFailure');
    return new SandboxExecutionError('persistenceFailure');
  }
}
