import type { GameEvent } from '@team5/contracts';
import type { DataSource, EntityManager } from 'typeorm';
import { InMemoryTransport } from '../src/transport/in-memory-transport';
import { RetryingHandler } from '../src/handlers/retrying-handler';

function sessionEscaped(messageId: string, sessionId: string): GameEvent {
  return {
    eventId: messageId,
    messageId,
    sessionId,
    sessionVersion: 1,
    occurredAt: '2026-11-02T00:00:00.000Z',
    type: 'SessionEscaped',
    payload: { endedAt: '2026-11-02T00:00:00.000Z' },
  };
}

function createRetryDataSource(): DataSource {
  const attempts = new Map<string, number>();
  const receipts = new Set<string>();

  function manager(transactionReceipts: Set<string>): EntityManager {
    const queryBuilderState: { values?: { consumer: string; messageId: string } } = {};
    const queryBuilder = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn(),
    };
    queryBuilder.insert.mockReturnValue(queryBuilder);
    queryBuilder.into.mockReturnValue(queryBuilder);
    queryBuilder.values.mockImplementation((value: { consumer: string; messageId: string }) => {
        queryBuilderState.values = value;
        return queryBuilder;
      });
    queryBuilder.orIgnore.mockReturnValue(queryBuilder);
      queryBuilder.returning.mockReturnValue(queryBuilder);
      queryBuilder.execute.mockImplementation(async () => {
          const values = queryBuilderState.values;
          if (!values) throw new Error('Inbox receipt values were not supplied');
          const id = `${values.consumer}:${values.messageId}`;
          if (transactionReceipts.has(id)) return { identifiers: [values], generatedMaps: [], raw: [] };
          transactionReceipts.add(id);
          return { identifiers: [values], generatedMaps: [], raw: [values] };
        });
    const repository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      delete: jest.fn(async (criteria: { consumer: string; messageId: string }) => {
        attempts.delete(`${criteria.consumer}:${criteria.messageId}`);
        return { affected: 1 };
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return {
      getRepository: jest.fn().mockReturnValue(repository),
    } as unknown as EntityManager;
  }

  const dataSource = {
    getRepository: jest.fn(() => ({ findOneBy: jest.fn().mockResolvedValue(null) })),
    transaction: jest.fn(async (callback: (transactionManager: EntityManager) => Promise<unknown>) => {
      const stagedReceipts = new Set(receipts);
      const result = await callback(manager(stagedReceipts));
      receipts.clear();
      stagedReceipts.forEach((receipt) => receipts.add(receipt));
      return result;
    }),
    query: jest.fn(async (_sql: string, [consumer, messageId, maxAttempts]: [string, string, number]) => {
      const id = `${consumer}:${messageId}`;
      const count = attempts.get(id) ?? 0;
      if (count >= maxAttempts) return [];
      attempts.set(id, count + 1);
      return [{ attempt_count: count + 1 }];
    }),
  };
  return dataSource as unknown as DataSource;
}

describe('retry and in-memory session ordering', () => {
  it('pauses later same-session messages while allowing other sessions to proceed', async () => {
    const transport = new InMemoryTransport();
    const retryingHandler = new RetryingHandler(createRetryDataSource());
    const handled: string[] = [];
    let releaseFirstAttempt!: () => void;
    let markFirstAttemptStarted!: () => void;
    let markOtherSessionHandled!: () => void;
    const firstAttemptGate = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const firstAttemptStarted = new Promise<void>((resolve) => {
      markFirstAttemptStarted = resolve;
    });
    const otherSessionHandled = new Promise<void>((resolve) => {
      markOtherSessionHandled = resolve;
    });
    let blockedAttempts = 0;
    const subscription = await transport.subscribe('game-events', 'projection', async (message) => {
      await retryingHandler.handle('projection', message.messageId, async () => {
        if (message.messageId === 'blocked-event' && blockedAttempts === 0) {
          blockedAttempts += 1;
          markFirstAttemptStarted();
          await firstAttemptGate;
          throw new Error('temporary failure');
        }
        handled.push(message.messageId);
        if (message.sessionId === 'other-session') markOtherSessionHandled();
      });
    });

    await transport.publish('game-events', sessionEscaped('blocked-event', 'session-1'));
    await firstAttemptStarted;
    await transport.publish('game-events', sessionEscaped('later-event', 'session-1'));
    await transport.publish('game-events', sessionEscaped('other-event', 'other-session'));
    await otherSessionHandled;

    expect(handled).toEqual(['other-event']);
    releaseFirstAttempt();
    await subscription.close();

    expect(handled).toEqual(['other-event', 'blocked-event', 'later-event']);
  });
});
