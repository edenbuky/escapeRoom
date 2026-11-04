import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PlayerCommand } from '@team5/contracts';
import { DeadLetter, enqueueOutboxMessage, handleInboxMessage, InboxReceipt, RetryingHandler } from '@team5/messaging';
import { DataSource, EntityManager } from 'typeorm';
import { ComponentFactory } from '../components/components';
import type { SandboxOutcome, SandboxOutcomeSink, SandboxJobRequest } from '../sandbox/sandbox.contracts';
import { CatalogResolver } from './catalog-resolver';
import { commandRejection } from './core/eligibility';
import { uuidV5 } from './core/ids';
import type { Evaluation } from './core/state';
import { EngineMessage, transition } from './core/transition';
import { EngineRepository } from './engine.repository';

export const ENGINE_CLOCK = Symbol('ENGINE_CLOCK');

interface PreparedSql {
  ownerId: string;
  scriptId: string;
  scriptVersion: number;
  templateRef: string;
  generation: number;
  evaluation: Evaluation;
}

@Injectable()
export class EngineService implements SandboxOutcomeSink {
  private readonly logger = new Logger(EngineService.name);
  private readonly retries: RetryingHandler;
  private readonly clock: () => Date;
  private readonly inFlightInputs = new Map<string, Promise<void>>();
  constructor(private readonly database: DataSource, private readonly catalog: CatalogResolver,
    private readonly components: ComponentFactory, private readonly repository: EngineRepository,
    @Optional() @Inject(ENGINE_CLOCK) clock?: () => Date) {
    this.retries = new RetryingHandler(database);
    this.clock = clock ?? (() => new Date());
  }

  async handle(message: PlayerCommand): Promise<void> {
    if (message.type !== 'SubmitInput') return this.handlePrepared(message);
    const key = JSON.stringify(message);
    let handling = this.inFlightInputs.get(key);
    if (!handling) {
      handling = this.handlePrepared(message);
      this.inFlightInputs.set(key, handling);
    }
    try { await handling; }
    finally { if (this.inFlightInputs.get(key) === handling) this.inFlightInputs.delete(key); }
  }

  private async handlePrepared(message: PlayerCommand): Promise<void> {
    const prepared = await this.prepareSql(message);
    await this.retries.handle('engine', message.messageId, manager => this.apply(manager, message, prepared));
  }

  private async prepareSql(message: PlayerCommand): Promise<PreparedSql | undefined> {
    if (message.type !== 'SubmitInput') return undefined;
    const known = await Promise.all([
      this.database.getRepository(InboxReceipt).existsBy({ consumer: 'engine', messageId: message.messageId }),
      this.database.getRepository(DeadLetter).existsBy({ consumer: 'engine', messageId: message.messageId }),
    ]);
    if (known.some(Boolean)) return undefined;
    const snapshot = await this.repository.load(this.database.manager, message.sessionId);
    if (!snapshot || snapshot.ownerId !== message.payload.userId
      || commandRejection(snapshot, message.payload.puzzleKey, this.clock())) return undefined;
    const puzzle = snapshot.puzzles.find(candidate => candidate.key === message.payload.puzzleKey)!;
    const content = await this.catalog.version(snapshot.scriptId, snapshot.scriptVersion);
    const template = content?.templates[puzzle.templateRef];
    if (template?.engine !== 'sql') return undefined;
    const evaluation = await this.components.evaluate(template, snapshot, puzzle, message.messageId, message.payload.input);
    return { ownerId: snapshot.ownerId, scriptId: snapshot.scriptId, scriptVersion: snapshot.scriptVersion,
      templateRef: puzzle.templateRef, generation: puzzle.sandbox.generation, evaluation };
  }
  async record(outcome: SandboxOutcome): Promise<void> {
    const rows: { request: SandboxJobRequest }[] = await this.database.query(
      'SELECT request FROM engine_sandbox_requests WHERE job_id = $1 AND session_id = $2', [outcome.jobId, outcome.sessionId]);
    const job = rows[0]?.request;
    if (!job || job.puzzleKey !== outcome.puzzleKey || job.generation !== outcome.generation
      || job.podName !== outcome.podName || job.namespace !== outcome.namespace
      || (outcome.kind === 'ready' && job.operation !== 'provision')
      || (outcome.kind === 'destroyed' && job.operation !== 'destroy')
      || (outcome.kind === 'failed' && job.operation !== outcome.operation)) return;
    const message: EngineMessage = { type: 'SandboxOutcome', sessionId: outcome.sessionId,
      messageId: uuidV5(`${outcome.jobId}:${outcome.kind}`), payload: outcome };
    await handleInboxMessage(this.database, 'engine-sandbox', message.messageId, async manager => {
      await this.apply(manager, message);
    });
  }

  private async apply(manager: EntityManager, message: EngineMessage, prepared?: PreparedSql): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [message.sessionId]);
    const snapshot = await this.repository.load(manager, message.sessionId);
    if (message.type === 'StartSession' && snapshot) return;
    if (message.type !== 'StartSession' && !snapshot) return;
    if (snapshot && message.type !== 'SandboxOutcome' && message.payload.userId !== snapshot.ownerId) return;
    if (message.type === 'SandboxOutcome' && message.payload.kind === 'ready') {
      const blocked = await manager.query(`SELECT 1 FROM sandbox_instances WHERE sandbox_id=$1
        AND (desired_state='destroyed' OR status<>'ready')
        UNION ALL SELECT 1 FROM engine_sandbox_requests WHERE session_id=$2 AND request->>'puzzleKey'=$3
          AND (request->>'generation')::int=$4 AND request->>'operation'='destroy' LIMIT 1`,
      [message.payload.podName, message.sessionId, message.payload.puzzleKey, message.payload.generation]);
      if (blocked.length) return;
    }
    const content = message.type === 'StartSession' ? await this.catalog.bySlug(message.payload.scriptSlug)
      : await this.catalog.version(snapshot!.scriptId, snapshot!.scriptVersion);
    if (!content) return;
    let evaluation: Evaluation | undefined;
    if (message.type === 'SubmitInput' && snapshot && !commandRejection(snapshot, message.payload.puzzleKey, this.clock())) {
      const puzzle = snapshot.puzzles.find(candidate => candidate.key === message.payload.puzzleKey)!;
      const template = content.templates[puzzle.templateRef];
      if (template.engine === 'sql') {
        evaluation = prepared && prepared.ownerId === snapshot.ownerId && prepared.scriptId === snapshot.scriptId
          && prepared.scriptVersion === snapshot.scriptVersion && prepared.templateRef === puzzle.templateRef
          && prepared.generation === puzzle.sandbox.generation ? prepared.evaluation
          : { verdict: 'rejected', reason: 'sandboxRestarting', output: 'Sandbox state changed. Retry with a new command.' };
      } else {
        evaluation = await this.components.evaluate(template, snapshot, puzzle, message.messageId, message.payload.input);
      }
    }
    const now = this.clock();
    const result = transition(snapshot, message, content, now, evaluation);
    if (!result.changed || !result.next) return;
    await this.repository.save(manager, result.next, snapshot?.version, now);
    for (const event of result.gameEvents) {
      if (event.type === 'CommandEvaluated') {
        await manager.query(`INSERT INTO command_log(command_id,session_id,puzzle_key,input_redacted,verdict)
          VALUES ($1,$2,$3,'[redacted]',$4)`, [message.messageId, message.sessionId, event.payload.puzzleKey, event.payload.result.verdict]);
      }
    }
    for (const job of result.sandboxJobs) {
      await manager.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
        [job.jobId, job.sessionId, JSON.stringify(job)]);
    }
    const last: { time: Date | null }[] = await manager.query(
      'SELECT max(created_at) AS time FROM messaging_outbox WHERE session_id = $1', [message.sessionId]);
    let orderTime = Math.max(now.getTime(), (last[0]?.time?.getTime() ?? 0) + 1);
    for (const event of result.gameEvents) {
      await enqueueOutboxMessage(manager, 'game-events', event);
      await manager.query('UPDATE messaging_outbox SET created_at = $2 WHERE message_id = $1', [event.messageId, new Date(orderTime++)]);
    }
    // After every write of this attempt: a retried attempt that failed earlier has logged nothing.
    // Keys, verdict and reason only; never the input, the output or the owner.
    for (const event of result.gameEvents) {
      if (event.type === 'SessionStarted') {
        this.logger.log(`Game started sessionId=${message.sessionId} roomKey=${event.payload.room.key}`);
      } else if (event.type === 'CommandEvaluated') {
        this.logger.log(`Answer evaluated sessionId=${message.sessionId} roomKey=${event.payload.roomKey} `
          + `puzzleKey=${event.payload.puzzleKey ?? 'none'} verdict=${event.payload.result.verdict} reason=${event.payload.result.reason ?? 'none'}`);
      }
    }
  }
}