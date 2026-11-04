import type { GameEvent } from '@team5/contracts';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { OutboxMessage } from '../src/entities/outbox-message.entity';
import { enqueueOutboxMessage, OutboxRelay } from '../src/outbox/outbox-relay';

function sessionEscaped(messageId: string): GameEvent {
  return {
    eventId: messageId,
    messageId,
    sessionId: 'session-1',
    sessionVersion: 1,
    occurredAt: '2026-11-02T00:00:00.000Z',
    type: 'SessionEscaped',
    payload: { endedAt: '2026-11-02T00:00:00.000Z' },
  };
}

describe('outbox relay', () => {
  it('does not relay an outbox row from a rolled-back producer transaction', async () => {
    const committedRows: OutboxMessage[] = [];
    let stagedRows: OutboxMessage[] = [];
    const repository = {
      create: jest.fn((value: Partial<OutboxMessage>) => Object.assign(new OutboxMessage(), value)),
      insert: jest.fn(async (row: OutboxMessage) => {
        stagedRows.push(row);
        return undefined;
      }),
      find: jest.fn(async () => committedRows),
      update: jest.fn(),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
    } as unknown as EntityManager;
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(repository),
      transaction: jest.fn(async (callback: (transactionManager: EntityManager) => Promise<unknown>) => {
        stagedRows = [];
        try {
          const result = await callback(manager);
          committedRows.push(...stagedRows);
          return result;
        } finally {
          stagedRows = [];
        }
      }),
    } as unknown as DataSource;
    const message = sessionEscaped('event-1');

    await expect(dataSource.transaction(async (transactionManager) => {
      await enqueueOutboxMessage(transactionManager, 'game-events', message);
      throw new Error('producer transaction failed');
    })).rejects.toThrow('producer transaction failed');

    expect(manager.getRepository).toHaveBeenCalledWith(OutboxMessage);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'event-1',
      sessionId: 'session-1',
      stream: 'game-events',
      payload: message,
      publishedAt: null,
    }));
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'event-1' }));

    const producer = { publish: jest.fn().mockResolvedValue(undefined) };
    const relay = new OutboxRelay(dataSource, producer);
    await expect(relay.relayPending()).resolves.toBe(0);
    expect(producer.publish).not.toHaveBeenCalled();
  });

  it('relays pending committed rows and marks each accepted message as published', async () => {
    const message = sessionEscaped('event-1');
    const row = Object.assign(new OutboxMessage(), {
      messageId: message.messageId,
      stream: 'game-events' as const,
      sessionId: message.sessionId,
      payload: message,
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
      publishedAt: null,
    });
    const repository = {
      find: jest.fn().mockResolvedValue([row]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as Repository<OutboxMessage>;
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(repository),
    } as unknown as DataSource;
    const producer = { publish: jest.fn().mockResolvedValue(undefined) };
    const relay = new OutboxRelay(dataSource, producer);

    const count = await relay.relayPending();

    expect(count).toBe(1);
    expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ publishedAt: expect.any(Object) }),
      order: { createdAt: 'ASC', messageId: 'ASC' },
    }));
    expect(producer.publish).toHaveBeenCalledWith('game-events', message);
    expect(repository.update).toHaveBeenCalledWith(
      { messageId: 'event-1', publishedAt: expect.any(Object) },
      { publishedAt: expect.any(Date) },
    );
  });

  it('retries the same message identity if publish succeeds but handoff marking fails', async () => {
    const message = sessionEscaped('event-1');
    const row = Object.assign(new OutboxMessage(), {
      messageId: message.messageId,
      stream: 'game-events' as const,
      sessionId: message.sessionId,
      payload: message,
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
      publishedAt: null,
    });
    const repository = {
      find: jest.fn().mockResolvedValue([row]),
      update: jest.fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce({ affected: 1 }),
    } as unknown as Repository<OutboxMessage>;
    const dataSource = { getRepository: jest.fn().mockReturnValue(repository) } as unknown as DataSource;
    const producer = { publish: jest.fn().mockResolvedValue(undefined) };
    const relay = new OutboxRelay(dataSource, producer);

    await expect(relay.relayPending()).rejects.toThrow('database unavailable');
    await expect(relay.relayPending()).resolves.toBe(1);

    expect(producer.publish).toHaveBeenNthCalledWith(1, 'game-events', message);
    expect(producer.publish).toHaveBeenNthCalledWith(2, 'game-events', message);
  });

  it('surfaces producer failures and leaves the row pending', async () => {
    const message = sessionEscaped('event-1');
    const row = Object.assign(new OutboxMessage(), {
      messageId: message.messageId,
      stream: 'game-events' as const,
      sessionId: message.sessionId,
      payload: message,
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
      publishedAt: null,
    });
    const repository = {
      find: jest.fn().mockResolvedValue([row]),
      update: jest.fn(),
    } as unknown as Repository<OutboxMessage>;
    const dataSource = { getRepository: jest.fn().mockReturnValue(repository) } as unknown as DataSource;
    const producer = { publish: jest.fn().mockRejectedValue(new Error('transport unavailable')) };
    const relay = new OutboxRelay(dataSource, producer);

    await expect(relay.relayPending()).rejects.toThrow('transport unavailable');

    expect(repository.update).not.toHaveBeenCalled();
  });
});
