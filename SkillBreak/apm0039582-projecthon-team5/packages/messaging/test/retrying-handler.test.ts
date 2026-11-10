import { QueryFailedError, type DataSource, type EntityManager, type ObjectLiteral, type Repository } from 'typeorm';
import { InboxReceipt } from '../src/entities/inbox-receipt.entity';
import { ConsumerAttempt } from '../src/entities/consumer-attempt.entity';
import { DeadLetter } from '../src/entities/dead-letter.entity';
import { describeFailure, RetryingHandler } from '../src/handlers/retrying-handler';

interface AttemptState {
  attemptCount: number;
  lastFailure: string | null;
}

interface TestState {
  attempts: Map<string, AttemptState>;
  deadLetters: Map<string, Partial<DeadLetter>>;
  receipts: Set<string>;
  failAttemptUpdateAt?: number;
  failedAttemptUpdate: boolean;
}

function key(consumer: string, messageId: string): string {
  return `${consumer}:${messageId}`;
}

function cloneState(state: TestState): TestState {
  return {
    attempts: new Map([...state.attempts].map(([id, attempt]) => [id, { ...attempt }])),
    deadLetters: new Map([...state.deadLetters].map(([id, deadLetter]) => [id, { ...deadLetter }])),
    receipts: new Set(state.receipts),
    failAttemptUpdateAt: state.failAttemptUpdateAt,
    failedAttemptUpdate: state.failedAttemptUpdate,
  };
}

function replaceState(target: TestState, source: TestState): void {
  target.attempts = source.attempts;
  target.deadLetters = source.deadLetters;
  target.receipts = source.receipts;
  target.failedAttemptUpdate = source.failedAttemptUpdate;
}

function createHarness(initialState?: Partial<TestState>) {
  const state: TestState = {
    attempts: new Map(),
    deadLetters: new Map(),
    receipts: new Set(),
    failedAttemptUpdate: false,
    ...initialState,
  };

  function repositoryFor<T extends ObjectLiteral>(entity: Function, current: TestState): Repository<T> {
    const queryBuilderState: { values?: Record<string, unknown> } = {};
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
    queryBuilder.values.mockImplementation((value: Record<string, unknown>) => {
        queryBuilderState.values = value;
        return queryBuilder;
      });
    queryBuilder.orIgnore.mockReturnValue(queryBuilder);
      queryBuilder.returning.mockReturnValue(queryBuilder);
      queryBuilder.execute.mockImplementation(async () => {
          const values = queryBuilderState.values ?? {};
          const id = key(String(values.consumer), String(values.messageId));
          if (entity === InboxReceipt) {
            if (current.receipts.has(id)) {
              return {
                identifiers: [{ consumer: values.consumer, messageId: values.messageId }],
                generatedMaps: [],
                raw: [],
              };
            }
            current.receipts.add(id);
            return {
              identifiers: [{ consumer: values.consumer, messageId: values.messageId }],
              generatedMaps: [],
              raw: [{ consumer: values.consumer, messageId: values.messageId }],
          };
        }
        if (entity === DeadLetter) {
          if (!current.deadLetters.has(id)) current.deadLetters.set(id, { ...values });
          return { identifiers: [{ consumer: values.consumer, messageId: values.messageId }], generatedMaps: [], raw: [] };
        }
        throw new Error('Unsupported test query builder entity');
      });

    return {
      findOneBy: jest.fn(async (criteria: { consumer: string; messageId: string }) => {
        const id = key(criteria.consumer, criteria.messageId);
        if (entity === DeadLetter) return current.deadLetters.get(id) ?? null;
        if (entity === ConsumerAttempt) {
          const attempt = current.attempts.get(id);
          return attempt ? { ...criteria, ...attempt } : null;
        }
        if (entity === InboxReceipt) return current.receipts.has(id) ? criteria : null;
        return null;
      }),
      create: jest.fn((value: Record<string, unknown>) => value),
      createQueryBuilder: jest.fn(() => queryBuilder),
      update: jest.fn(async (criteria: { consumer: string; messageId: string }, values: Partial<AttemptState>) => {
        const id = key(criteria.consumer, criteria.messageId);
        const attempt = current.attempts.get(id);
        if (current.failAttemptUpdateAt === attempt?.attemptCount && !current.failedAttemptUpdate) {
          current.failedAttemptUpdate = true;
          throw new Error('attempt persistence unavailable');
        }
        if (attempt) current.attempts.set(id, { ...attempt, ...values });
        return { affected: attempt ? 1 : 0 };
      }),
      delete: jest.fn(async (criteria: { consumer: string; messageId: string }) => {
        const id = key(criteria.consumer, criteria.messageId);
        const existed = current.attempts.delete(id);
        return { affected: existed ? 1 : 0 };
      }),
    } as unknown as Repository<T>;
  }

  const getRepository = jest.fn((entity: Function) => repositoryFor(entity, state));
  const query = jest.fn(async (_sql: string, parameters: [string, string, number]) => {
    const [consumer, messageId, maxAttempts] = parameters;
    const id = key(consumer, messageId);
    const previous = state.attempts.get(id);
    if (previous?.attemptCount === maxAttempts) return [];
    const attemptCount = (previous?.attemptCount ?? 0) + 1;
    state.attempts.set(id, { attemptCount, lastFailure: previous?.lastFailure ?? null });
    return [{ attempt_count: attemptCount }];
  });
  const transaction = jest.fn(async (callback: (manager: EntityManager) => Promise<unknown>) => {
    const draft = cloneState(state);
    const manager = {
      getRepository: (entity: Function) => repositoryFor(entity, draft),
    } as unknown as EntityManager;
    const result = await callback(manager);
    replaceState(state, draft);
    return result;
  });
  const dataSource = { getRepository, query, transaction,
    getMetadata: jest.fn(() => ({ schema: 'team5', tableName: 'projection_messaging_consumer_attempt' })),
    driver: { escape: (name: string) => `"${name}"` } } as unknown as DataSource;
  return { dataSource, state, query, transaction };
}

describe('RetryingHandler', () => {
  it('makes five total attempts and dead-letters without retaining the payload', async () => {
    const { dataSource, state, query } = createHarness();
    const retryingHandler = new RetryingHandler(dataSource);
    const handle = jest.fn().mockRejectedValue(new Error('input rejected by handler'));

    const result = await retryingHandler.handle('projection', 'event-1', handle);

    expect(query.mock.calls[0][0]).toContain('INSERT INTO "team5"."projection_messaging_consumer_attempt" AS attempt');
    expect(handle).toHaveBeenCalledTimes(5);
    expect(result).toEqual({ status: 'dead-lettered', messageId: 'event-1' });
    expect(state.deadLetters.get(key('projection', 'event-1'))).toEqual(expect.objectContaining({
      consumer: 'projection',
      messageId: 'event-1',
      attemptCount: 5,
      failureDetails: 'Error',
    }));
    expect(state.deadLetters.get(key('projection', 'event-1'))?.failureDetails)
      .not.toContain('input rejected by handler');
    expect(state.deadLetters.get(key('projection', 'event-1'))).not.toHaveProperty('payload');
  });

  it('continues persisted attempt counts when a new coordinator resumes handling', async () => {
    const { dataSource, state, query } = createHarness({ failAttemptUpdateAt: 2 });
    const firstCoordinator = new RetryingHandler(dataSource);
    const fail = jest.fn().mockRejectedValue(new Error('transient failure'));

    await expect(firstCoordinator.handle('projection', 'event-1', fail))
      .rejects.toThrow('attempt persistence unavailable');
    expect(state.attempts.get(key('projection', 'event-1'))?.attemptCount).toBe(2);

    const restartedCoordinator = new RetryingHandler(dataSource);
    const succeed = jest.fn().mockResolvedValue('done');
    const result = await restartedCoordinator.handle('projection', 'event-1', succeed);

    expect(result).toEqual({ status: 'handled', value: 'done' });
    expect(query).toHaveBeenCalledTimes(3);
    expect(succeed).toHaveBeenCalledTimes(1);
    expect(state.deadLetters.has(key('projection', 'event-1'))).toBe(false);
  });

  it('tracks attempts independently for different consumers', async () => {
    const { dataSource, state } = createHarness();
    const retryingHandler = new RetryingHandler(dataSource);
    const fail = jest.fn().mockRejectedValue(new Error('projection failed'));

    await retryingHandler.handle('projection', 'event-1', fail);
    const analytics = await retryingHandler.handle('analytics', 'event-1', async () => 'ok');

    expect(analytics).toEqual({ status: 'handled', value: 'ok' });
    expect(state.deadLetters.has(key('projection', 'event-1'))).toBe(true);
    expect(state.deadLetters.has(key('analytics', 'event-1'))).toBe(false);
  });

  it('commits a successful receipt and skips duplicate effects', async () => {
    const { dataSource, state } = createHarness();
    const retryingHandler = new RetryingHandler(dataSource);
    const handle = jest.fn().mockResolvedValue('updated');

    const first = await retryingHandler.handle('projection', 'event-1', handle);
    const duplicate = await retryingHandler.handle('projection', 'event-1', handle);

    expect(first).toEqual({ status: 'handled', value: 'updated' });
    expect(duplicate).toEqual({ status: 'duplicate' });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(state.receipts.has(key('projection', 'event-1'))).toBe(true);
  });
});

describe('describeFailure', () => {
  it('names a plain error without its message', () => {
    expect(describeFailure(new TypeError('secret danaZ22'))).toBe('TypeError');
  });

  it('adds the driver code and constraint of a query failure, never the SQL, parameters or message', () => {
    const driverError = Object.assign(new Error('duplicate key value danaZ22'), {
      code: '23505', constraint: 'users_username_key', detail: 'Key (username)=(dana) already exists.',
    });
    const failure = describeFailure(new QueryFailedError("INSERT INTO users VALUES ('danaZ22')", ['danaZ22'], driverError));
    expect(failure).toBe('QueryFailedError code=23505 constraint=users_username_key');
    expect(failure).not.toMatch(/danaZ22|INSERT|duplicate|Key/);
  });

  it('lists cause names only', () => {
    const error = new Error('outer secret', { cause: new RangeError('inner secret', { cause: 'raw secret' }) });
    expect(describeFailure(error)).toBe('Error cause=RangeError>string');
  });

  it('describes non-Error rejections by type', () => {
    expect(describeFailure('Bearer abc.def')).toBe('Rejected with string');
  });

  it('drops names and codes that are not plain identifiers', () => {
    const error = Object.assign(new Error('x'), { name: 'Bearer abc def', code: 'pw=danaZ22 x' });
    expect(describeFailure(error)).toBe('Error');
  });

  it('stays within 1024 characters for a long nested cause chain', () => {
    let error = new Error('leaf');
    for (let index = 0; index < 5000; index++) error = new Error(`level ${index}`, { cause: error });
    const failure = describeFailure(error);
    expect(failure.length).toBeLessThanOrEqual(1024);
    expect(failure).toMatch(/^Error cause=Error>Error/);
  });

  it('stops on a cause cycle', () => {
    const error = new Error('a');
    const cause = new Error('b', { cause: error });
    (error as Error & { cause?: unknown }).cause = cause;
    expect(describeFailure(error)).toBe('Error cause=Error');
  });

  it('stores the description as the dead-letter failure details', async () => {
    const { dataSource, state } = createHarness();
    const failure = Object.assign(new Error('private'), { code: 'ECONNRESET' });
    await new RetryingHandler(dataSource).handle('projection', 'event-9', jest.fn().mockRejectedValue(failure));
    expect(state.deadLetters.get(key('projection', 'event-9'))?.failureDetails).toBe('Error code=ECONNRESET');
  });
});
