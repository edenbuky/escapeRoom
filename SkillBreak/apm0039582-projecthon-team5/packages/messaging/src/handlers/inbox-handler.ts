import type { DataSource, EntityManager } from 'typeorm';
import { InboxReceipt } from '../entities/inbox-receipt.entity';

export type InboxHandlingResult<T> =
  | { duplicate: true }
  | { duplicate: false; value: T };

export async function handleInboxMessage<T>(
  dataSource: DataSource,
  consumer: string,
  messageId: string,
  handle: (manager: EntityManager) => Promise<T>,
): Promise<InboxHandlingResult<T>> {
  return dataSource.transaction(async (manager) => {
    const result = await manager
      .getRepository(InboxReceipt)
      .createQueryBuilder()
      .insert()
      .into(InboxReceipt)
      .values({ consumer, messageId, processedAt: new Date() })
      .orIgnore()
      .returning(['consumer', 'messageId'])
      .execute();

    if (!Array.isArray(result.raw)) {
      throw new TypeError('PostgreSQL receipt insert did not return inserted rows');
    }

    if (result.raw.length === 0) {
      return { duplicate: true };
    }

    const value = await handle(manager);
    return { duplicate: false, value };
  });
}
