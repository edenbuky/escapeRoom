import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
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
import { isSandboxEngine } from '../sandbox/sandbox-seeds';

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

  async resume(userId: string): Promise<{ sessionId: string | null }> {
    await this.expireDue(userId);
    const rows: { id: string }[] = await this.database.query(`SELECT id FROM sessions WHERE owner_id=$1
      ORDER BY (state->>'status'='Active') DESC,
        CASE WHEN state->>'status'='Active' THEN state->>'startedAt' END,
        (state->>'startedAt') DESC, id LIMIT 1`, [userId]);
    if (rows[0]) this.logger.log(`Game resumed sessionId=${rows[0].id}`);
    return { sessionId: rows[0]?.id ?? null };
  }

  async startOrResume(userId: string, scriptSlug: string, requestId: string): Promise<{ sessionId: string }> {
    return this.database.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`owner:${userId}`]);
      const active: { id: string; deadline: string }[] = await manager.query(`SELECT id,state->>'deadlineAt' AS deadline
        FROM sessions WHERE owner_id=$1 AND state->>'status'='Active' ORDER BY state->>'startedAt',id`, [userId]);
      const checkedAt = this.clock().getTime();
      for (const row of active) {
        if (Date.parse(row.deadline) <= checkedAt) {
          await this.apply(manager, { type: 'PlayerReconnected', sessionId: row.id,
            messageId: uuidV5(`expire:${row.id}`), payload: { userId } });
        }
      }
      const remaining = active.filter(row => Date.parse(row.deadline) > checkedAt);
      const existing = remaining[0];
      for (const duplicate of remaining.slice(1)) {
        await this.apply(manager, { type: 'AbandonSession', sessionId: duplicate.id,
          messageId: uuidV5(`duplicate:${duplicate.id}`), payload: { userId } });
      }
      if (existing) return { sessionId: existing.id };
      const sessionId = uuidV5(`${userId}:${requestId}`);
      if (!await this.catalog.bySlug(scriptSlug)) throw new NotFoundException('Unknown game');
      await this.apply(manager, { type: 'StartSession', sessionId, messageId: uuidV5(`start:${sessionId}`),
        payload: { userId, scriptSlug } });
      return { sessionId };
    });
  }

  async expireDue(userId?: string): Promise<void> {
    const rows: { id: string; owner_id: string }[] = await this.database.query(`SELECT id,owner_id FROM sessions
      WHERE state->>'status'='Active' AND (state->>'deadlineAt')::timestamptz <= $1
        AND ($2::uuid IS NULL OR owner_id=$2) ORDER BY state->>'deadlineAt' LIMIT 100`, [this.clock(), userId ?? null]);
    for (const row of rows) {
      await this.database.transaction(manager => this.apply(manager, { type: 'PlayerReconnected', sessionId: row.id,
        messageId: uuidV5(`expire:${row.id}`), payload: { userId: row.owner_id } }));
    }
  }

  private async handlePrepared(message: PlayerCommand): Promise<void> {
    const prepared = await this.prepareSandbox(message);
    await this.retries.handle('engine', message.messageId, manager => this.apply(manager, message, prepared));
  }

  private async prepareSandbox(message: PlayerCommand): Promise<PreparedSql | undefined> {
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
    if (!template || !isSandboxEngine(template.engine)) return undefined;
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
    if (message.type === 'StartSession') {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`owner:${message.payload.userId}`]);
      const active = await manager.query(`SELECT id FROM sessions WHERE owner_id=$1 AND state->>'status'='Active' AND id<>$2`,
        [message.payload.userId, message.sessionId]);
      if (active.length) return;
    }
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
      if (isSandboxEngine(template.engine)) {
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
    for (const event of result.gameEvents) {
      if (event.type === 'SessionStarted') {
        this.logger.log(`Game started sessionId=${message.sessionId} roomKey=${event.payload.room.key}`);
      } else if (event.type === 'CommandEvaluated') {
        this.logger.log(`Answer evaluated action=${message.type} commandId=${message.messageId} sessionId=${message.sessionId} roomKey=${event.payload.roomKey} `
          + `puzzleKey=${event.payload.puzzleKey ?? 'none'} verdict=${event.payload.result.verdict} reason=${event.payload.result.reason ?? 'none'}`);
        if (process.env.GAMEPLAY_DEBUG_LOGS === 'true' && process.env.NODE_ENV !== 'production' && message.type === 'SubmitInput') {
          const { puzzleKey, input } = message.payload;
          const details = puzzleKey === 'hash-cracker' && input.kind === 'answer'
            ? `Hash check submittedHash=${JSON.stringify(input.answer)}`
            : puzzleKey === 'dana-login' && input.kind === 'credentials'
              ? `Dana login username=${JSON.stringify(input.username)} password=${JSON.stringify(input.password)}`
              : puzzleKey === 'idan-db' && input.kind === 'command'
                ? `SQL puzzle sql=${JSON.stringify(input.command)}` : undefined;
          if (details) {
            const { verdict, reason } = event.payload.result;
            const outcome = verdict === 'solved' ? (puzzleKey === 'idan-db' ? 'solved' : 'correct')
              : reason === 'wrongAnswer' ? 'incorrect' : verdict === 'progress' ? 'progress' : 'not-evaluated';
            this.logger.log(`${details} outcome=${outcome} verdict=${verdict} reason=${reason ?? 'none'} `
              + `sessionId=${message.sessionId} commandId=${message.messageId}`);
          }
        }
      } else if (event.type === 'PuzzleReset') {
        const puzzle = event.payload.puzzle;
        this.logger.warn(`Puzzle ruined, sandbox reset sessionId=${message.sessionId} puzzleKey=${puzzle.key} `
          + `oldGeneration=${puzzle.sandbox.generation - 1} newGeneration=${puzzle.sandbox.generation} `
          + `invariant=${evaluation?.invariant ?? 'unknown'} commandId=${message.messageId}`);
      } else if (event.type === 'DoorOpened') {
        this.logger.log(`Door opened roomKey=${event.payload.roomKey} sessionId=${message.sessionId} commandId=${message.messageId}`);
      } else if (event.type === 'SessionEscaped') {
        this.logger.log(`Game escaped sessionId=${message.sessionId} elapsedSeconds=${Math.max(0,
          Math.floor((Date.parse(event.payload.endedAt) - Date.parse(result.next!.startedAt)) / 1000))}`);
      } else if (['RoomEntered', 'SessionExpired', 'SessionAbandoned'].includes(event.type)) {
        this.logger.log(`${event.type} sessionId=${message.sessionId} commandId=${message.messageId}`);
      }
    }
  }
}