import type { MessageProducer, StreamMessages } from '@team5/contracts/server';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { OutboxMessage, type MessageStream, type OutgoingPayload } from '../entities/outbox-message.entity';

export async function enqueueOutboxMessage<S extends keyof StreamMessages>(
  manager: EntityManager,
  stream: S,
  message: StreamMessages[S],
): Promise<void> {
  const repository = manager.getRepository(OutboxMessage);
  const row = repository.create({
    messageId: message.messageId,
    stream,
    sessionId: message.sessionId,
    payload: message as OutgoingPayload,
    publishedAt: null,
  });
  await repository.insert(row);
}

export class OutboxRelay {
  constructor(
    private readonly dataSource: DataSource,
    private readonly producer: MessageProducer,
    private readonly batchSize = 100,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('Outbox batch size must be a positive integer');
    }
  }

  async relayPending(): Promise<number> {
    const repository = this.dataSource.getRepository(OutboxMessage);
    const pending = await repository.find({
      where: { publishedAt: IsNull() },
      order: { createdAt: 'ASC', messageId: 'ASC' },
      take: this.batchSize,
    });

    let publishedCount = 0;
    for (const row of pending) {
      await this.publish(row.stream, row.payload);
      await repository.update(
        { messageId: row.messageId, publishedAt: IsNull() },
        { publishedAt: new Date() },
      );
      publishedCount += 1;
    }
    return publishedCount;
  }

  private publish(stream: MessageStream, payload: OutgoingPayload): Promise<void> {
    if (stream === 'game-events' && 'eventId' in payload) {
      return this.producer.publish(stream, payload);
    }
    if (stream === 'player-commands' && !('eventId' in payload)) {
      return this.producer.publish(stream, payload);
    }
    throw new TypeError(`Outbox message payload does not match stream "${stream}"`);
  }
}
