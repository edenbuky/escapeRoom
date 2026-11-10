import { Injectable, Logger } from '@nestjs/common';
import { RetryingHandler } from '@team5/messaging';
import { ProjectionDatabase } from './projection-database';
import { ProjectionRepository } from './projection.repository';
import { integer, object, reduceProjection, text, timestamp, uuid } from './projection.reducer';

const supported = new Set(['SessionStarted', 'PuzzleOpened', 'CommandEvaluated', 'PuzzleSolved', 'RoomEntered', 'DoorOpened', 'PuzzleReset', 'SessionAbandoned', 'SessionExpired', 'SessionEscaped']);
const deferred = new Set(['HintRevealed']);

@Injectable()
export class ProjectionConsumer {
  private readonly logger = new Logger(ProjectionConsumer.name);
  constructor(private readonly database: ProjectionDatabase, private readonly repository: ProjectionRepository) {}
  async handle(input: unknown): Promise<void> {
    let messageId: string, sessionId: string;
    try {
      const event = object(input);
      messageId = uuid(event.messageId);
      uuid(event.eventId);
      sessionId = uuid(event.sessionId);
      if (event.messageId !== event.eventId) throw new Error('Projection event identity mismatch');
    } catch {
      this.logger.warn('Invalid projection envelope identity');
      throw new Error('Invalid projection envelope identity');
    }
    const outcome = await new RetryingHandler(this.database.source).handle('projection', messageId, async manager => {
      const event = object(input);
      const type = text(event.type);
      const version = integer(event.sessionVersion, 1);
      timestamp(event.occurredAt);
      if (deferred.has(type)) {
        this.logger.warn(`Projection event outside scope: ${type}`);
        return;
      }
      if (!supported.has(type)) throw new Error('Unknown projection event type');
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('team5-projection:' || $1::text, 0))", [sessionId]);
      const previous = await this.repository.read(sessionId, manager);
      if (previous && version < previous.version) return;
      const next = reduceProjection(previous, input);
      await this.repository.save(manager, next.ownerId, next.view);
      await manager.query("SELECT pg_notify('team5_session_projection_changed', $1)", [sessionId]);
    });
    if (outcome.status === 'dead-lettered') this.logger.warn('Projection event dead-lettered after five attempts');
  }
}
