import type { DataSource, EntityManager } from 'typeorm';
import { handleInboxMessage, type InboxHandlingResult } from './inbox-handler';
import { InboxReceipt } from '../entities/inbox-receipt.entity';
import { ConsumerAttempt } from '../entities/consumer-attempt.entity';
import { DeadLetter } from '../entities/dead-letter.entity';

const MAX_ATTEMPTS = 5;
const MAX_FAILURE_LENGTH = 1024;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,128}$/;

type FailureFields = { name?: unknown; code?: unknown; constraint?: unknown; cause?: unknown; driverError?: { code?: unknown } };

// Errors from another realm (jest sandboxes, DOMException) fail instanceof Error but still carry a name.
function isFailure(value: unknown): value is FailureFields {
  return value instanceof Error || (typeof value === 'object' && value !== null && typeof (value as FailureFields).name === 'string');
}

function safeToken(value: unknown): string | undefined {
  return (typeof value === 'string' || typeof value === 'number') && SAFE_TOKEN.test(String(value)) ? String(value) : undefined;
}

/**
 * Names a failure for logs and dead letters: error name, code, constraint and cause names.
 * Never the message, SQL, parameters or payload. At most 1024 characters (varchar(1024) columns).
 */
export function describeFailure(error: unknown): string {
  if (!isFailure(error)) return `Rejected with ${typeof error}`;
  const parts = [safeToken(error.name) ?? 'Error'];
  const code = safeToken(error.driverError?.code ?? error.code);
  if (code) parts.push(`code=${code}`);
  const constraint = typeof error.constraint === 'string' ? safeToken(error.constraint) : undefined;
  if (constraint) parts.push(`constraint=${constraint}`);
  const causes: string[] = [];
  const seen = new Set<unknown>([error]);
  let length = 0;
  for (let cause = error.cause; cause !== undefined && !seen.has(cause) && length < MAX_FAILURE_LENGTH;
    cause = isFailure(cause) ? cause.cause : undefined) {
    seen.add(cause);
    const causeName = (isFailure(cause) ? safeToken(cause.name) : undefined) ?? typeof cause;
    causes.push(causeName);
    length += causeName.length + 1;
  }
  if (causes.length) parts.push(`cause=${causes.join('>')}`);
  return parts.join(' ').slice(0, MAX_FAILURE_LENGTH);
}

export type RetryHandlingResult<T> =
  | { status: 'handled'; value: T }
  | { status: 'duplicate' }
  | { status: 'dead-lettered'; messageId: string };

export class RetryingHandler {
  constructor(private readonly dataSource: DataSource) {}

  async handle<T>(
    consumer: string,
    messageId: string,
    handler: (manager: EntityManager) => Promise<T>,
  ): Promise<RetryHandlingResult<T>> {
    if (await this.dataSource.getRepository(DeadLetter).findOneBy({ consumer, messageId })) {
      return { status: 'dead-lettered', messageId };
    }

    if (await this.dataSource.getRepository(InboxReceipt).findOneBy({ consumer, messageId })) {
      await this.dataSource.getRepository(ConsumerAttempt).delete({ consumer, messageId });
      return { status: 'duplicate' };
    }

    while (true) {
      const attemptCount = await this.beginAttempt(consumer, messageId);
      if (attemptCount === null) {
        return { status: 'dead-lettered', messageId };
      }

      try {
        const result: InboxHandlingResult<T> = await handleInboxMessage(
          this.dataSource,
          consumer,
          messageId,
          async (manager) => {
            const value = await handler(manager);
            await manager.getRepository(ConsumerAttempt).delete({ consumer, messageId });
            return value;
          },
        );
        if (result.duplicate) {
          await this.dataSource.getRepository(ConsumerAttempt).delete({ consumer, messageId });
          return { status: 'duplicate' };
        }
        return { status: 'handled', value: result.value };
      } catch (error) {
        await this.recordFailure(consumer, messageId, attemptCount, describeFailure(error));
        if (attemptCount === MAX_ATTEMPTS) {
          return { status: 'dead-lettered', messageId };
        }
      }
    }
  }

  private async beginAttempt(consumer: string, messageId: string): Promise<number | null> {
    const metadata = this.dataSource.getMetadata(ConsumerAttempt);
    const table = [metadata.schema, metadata.tableName].filter((part): part is string => !!part)
      .map(part => this.dataSource.driver.escape(part)).join('.');
    const rows = await this.dataSource.query<Array<{ attempt_count: number | string }>>(
      `INSERT INTO ${table} AS attempt
        ("consumer", "message_id", "attempt_count", "last_failure", "updated_at")
       VALUES ($1, $2, 1, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT ("consumer", "message_id") DO UPDATE
       SET "attempt_count" = attempt."attempt_count" + 1,
           "updated_at" = CURRENT_TIMESTAMP
       WHERE attempt."attempt_count" < $3
       RETURNING "attempt_count"`,
      [consumer, messageId, MAX_ATTEMPTS],
    );
    if (rows.length > 0) {
      return Number(rows[0].attempt_count);
    }

    await this.deadLetterInterruptedAttempt(consumer, messageId);
    return null;
  }

  private async recordFailure(
    consumer: string,
    messageId: string,
    attemptCount: number,
    failureDetails: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const attempts = manager.getRepository(ConsumerAttempt);
      await attempts.update(
        { consumer, messageId },
        { lastFailure: failureDetails, updatedAt: new Date() },
      );
      if (attemptCount < MAX_ATTEMPTS) {
        return;
      }

      const deadLetters = manager.getRepository(DeadLetter);
      await deadLetters
        .createQueryBuilder()
        .insert()
        .into(DeadLetter)
        .values({
          consumer,
          messageId,
          attemptCount: MAX_ATTEMPTS,
          failureDetails,
          failedAt: new Date(),
        })
        .orIgnore()
        .execute();
      await attempts.delete({ consumer, messageId });
    });
  }

  private async deadLetterInterruptedAttempt(consumer: string, messageId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const attempts = manager.getRepository(ConsumerAttempt);
      const attempt = await attempts.findOneBy({ consumer, messageId });
      if (!attempt) {
        return;
      }

      await manager
        .getRepository(DeadLetter)
        .createQueryBuilder()
        .insert()
        .into(DeadLetter)
        .values({
          consumer,
          messageId,
          attemptCount: MAX_ATTEMPTS,
          failureDetails: attempt.lastFailure ?? 'Attempt limit reached after an interrupted handler invocation',
          failedAt: new Date(),
        })
        .orIgnore()
        .execute();
      await attempts.delete({ consumer, messageId });
    });
  }

}
