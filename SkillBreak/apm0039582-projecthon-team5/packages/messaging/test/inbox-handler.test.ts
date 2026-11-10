import type { DataSource, EntityManager, InsertResult, Repository } from 'typeorm';
import { InboxReceipt } from '../src/entities/inbox-receipt.entity';
import { handleInboxMessage } from '../src/handlers/inbox-handler';

describe('inbox handler', () => {
  function makeDataSource(affected: number) {
    const insertResult: InsertResult = {
      identifiers: affected === 1 ? [{ consumer: 'projection', messageId: 'event-1' }] : [],
      generatedMaps: [],
      raw: [],
    };
    const queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({
        ...insertResult,
        raw: affected === 1 ? [{ consumer: 'projection', messageId: 'event-1' }] : [],
      }),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as Repository<InboxReceipt>;
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn((callback: (transactionManager: EntityManager) => Promise<unknown>) => callback(manager)),
    } as unknown as DataSource;
    return { dataSource, manager, repository, queryBuilder };
  }

  it('commits a new receipt and callback changes in the same transaction', async () => {
    const { dataSource, manager, queryBuilder } = makeDataSource(1);
    const changeState = jest.fn().mockResolvedValue('updated');

    const result = await handleInboxMessage(dataSource, 'projection', 'event-1', changeState);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.getRepository).toHaveBeenCalledWith(InboxReceipt);
    expect(queryBuilder.orIgnore).toHaveBeenCalled();
    expect(queryBuilder.returning).toHaveBeenCalledWith(['consumer', 'messageId']);
    expect(changeState).toHaveBeenCalledWith(manager);
    expect(result).toEqual({ duplicate: false, value: 'updated' });
  });

  it('skips callback changes when this consumer already has a receipt', async () => {
    const { dataSource, queryBuilder } = makeDataSource(0);
    const changeState = jest.fn();

    const result = await handleInboxMessage(dataSource, 'projection', 'event-1', changeState);

    expect(queryBuilder.execute).toHaveBeenCalled();
    expect(changeState).not.toHaveBeenCalled();
    expect(result).toEqual({ duplicate: true });
  });

  it('uses returned inserted rows rather than attempted-insert identifiers', async () => {
    const { dataSource, queryBuilder } = makeDataSource(0);
    queryBuilder.execute.mockResolvedValue({
      identifiers: [{ consumer: 'projection', messageId: 'event-1' }],
      generatedMaps: [],
      raw: [],
    });
    const changeState = jest.fn();

    const result = await handleInboxMessage(dataSource, 'projection', 'event-1', changeState);

    expect(changeState).not.toHaveBeenCalled();
    expect(result).toEqual({ duplicate: true });
  });

  it('uses separate receipt identities for different consumers', async () => {
    const { dataSource, queryBuilder } = makeDataSource(1);
    const changeState = jest.fn().mockResolvedValue(undefined);

    await handleInboxMessage(dataSource, 'projection', 'event-1', changeState);
    await handleInboxMessage(dataSource, 'analytics', 'event-1', changeState);

    expect(queryBuilder.values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      consumer: 'projection',
      messageId: 'event-1',
    }));
    expect(queryBuilder.values).toHaveBeenNthCalledWith(2, expect.objectContaining({
      consumer: 'analytics',
      messageId: 'event-1',
    }));
    expect(changeState).toHaveBeenCalledTimes(2);
  });

  it('propagates callback failures so the receipt transaction can roll back', async () => {
    const { dataSource } = makeDataSource(1);
    const changeState = jest.fn().mockRejectedValue(new Error('state update failed'));

    await expect(handleInboxMessage(dataSource, 'projection', 'event-1', changeState))
      .rejects.toThrow('state update failed');
  });
});
