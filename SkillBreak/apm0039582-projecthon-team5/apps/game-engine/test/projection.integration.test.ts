import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GameEvent, PlayerCommand, PuzzleInput } from '@team5/contracts';
import { ConsumerAttempt, DeadLetter, InboxReceipt, OutboxMessage, RetryingHandler } from '@team5/messaging';
import { ProjectionDatabase } from '../src/modules/projection/projection-database';
import { ProjectionRepository } from '../src/modules/projection/projection.repository';
import { ProjectionListener } from '../src/modules/projection/projection.listener';
import { ProjectionConsumer } from '../src/modules/projection/projection.consumer';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { ROOM1 } from '../src/modules/script-catalog/room1';
import { EngineService } from '../src/modules/sessions/engine.service';
import { EngineRuntime } from '../src/modules/sessions/engine-runtime';
import { HealthController } from '../src/health/health.controller';
import type { SandboxJobRequest } from '../src/modules/sandbox/sandbox.contracts';
import { changed, fixtureView, ProjectionHarness, started, StreamReader, until } from './helpers/projection-harness';

const integration = process.env.RUN_PROJECTION_DB_TESTS === '1' ? describe : describe.skip;
integration('projection', () => {
  const harness = new ProjectionHarness();
  let database: ProjectionDatabase;
  let repository: ProjectionRepository;
  beforeAll(async () => {
    await harness.openDatabase();
    database = new ProjectionDatabase(harness.config);
    await database.start();
    repository = new ProjectionRepository(database);
  }, 90000);
  afterAll(async () => {
    try { await database?.onApplicationShutdown(); }
    finally { await harness.close(); }
  }, 40000);

  describe('foundation', () => {
    test('upgrades the prior schema without changing existing records or migration identities', async () => {
      await harness.database.undoLastMigration();
      const previous = await harness.database.query('SELECT name FROM migrations ORDER BY timestamp');
      const messageId = randomUUID();
      await harness.database.getRepository(InboxReceipt).insert({ consumer: 'upgrade-test', messageId });
      expect(await harness.database.runMigrations()).toHaveLength(1);
      expect(await harness.database.query('SELECT name FROM migrations ORDER BY timestamp LIMIT 4')).toEqual(previous);
      expect(await harness.database.getRepository(InboxReceipt).existsBy({ consumer: 'upgrade-test', messageId })).toBe(true);
    });
    test('migrates once, preserves engine identities and isolates reused helpers', async () => {
      expect(await harness.database.runMigrations()).toEqual([]);
      expect(await database.tablesReady()).toBe(true);
      const messageId = randomUUID();
      await harness.database.getRepository(InboxReceipt).insert({ consumer: 'projection', messageId });
      let called = 0;
      const retries = new RetryingHandler(database.source);
      expect(await retries.handle('projection', messageId, async () => { called++; })).toMatchObject({ status: 'handled' });
      expect(called).toBe(1);
      expect(await retries.handle('projection', messageId, async () => { called++; })).toMatchObject({ status: 'duplicate' });
      expect(called).toBe(1);
      const failedId = randomUUID();
      await database.source.getRepository(ConsumerAttempt).insert({ consumer: 'projection', messageId: failedId, attemptCount: 4 });
      expect(await new RetryingHandler(database.source).handle('projection', failedId, async () => { throw new Error('private payload'); }))
        .toMatchObject({ status: 'dead-lettered' });
      expect(await database.source.getRepository(DeadLetter).findOneByOrFail({ consumer: 'projection', messageId: failedId }))
        .toMatchObject({ attemptCount: 5, failureDetails: 'Error' });
      expect(await harness.database.getRepository(DeadLetter).count()).toBe(0);
    });

    test('keeps large revisions lossless and never falls back to public tables', async () => {
      const event = started();
      await database.source.transaction(manager => repository.save(manager, event.payload.ownerId, {
        sessionId: event.sessionId, version: 1, status: 'Active', currentRoom: event.payload.room,
        deadlineAt: event.payload.deadlineAt, endedAt: null, latestResult: null, revealedHints: [],
      }));
      await database.source.query('UPDATE projection.session_view SET revision=9007199254740993 WHERE session_id=$1', [event.sessionId]);
      expect((await repository.read(event.sessionId))?.revision).toBe('9007199254740993');
      await database.source.query('ALTER TABLE projection.messaging_consumer_attempt RENAME TO isolated_attempt');
      try {
        await expect(new RetryingHandler(database.source).handle('projection', randomUUID(), async () => undefined))
          .rejects.toThrow();
        expect(await harness.database.getRepository(ConsumerAttempt).count()).toBe(0);
      } finally { await database.source.query('ALTER TABLE projection.isolated_attempt RENAME TO messaging_consumer_attempt'); }
    });

  });
    describe('US1', () => {
      beforeAll(async () => { await harness.startApp(); });
      test('returns an exact allowlisted full snapshot and CORS headers', async () => {
        const event = started();
        const view = fixtureView(event);
        view.latestResult = { commandId: randomUUID(), verdict: 'progress', reason: null, output: 'name\nfictional clue\n' };
        view.currentRoom.puzzles[0].latestResult = view.latestResult;
        view.currentRoom.files = [{ name: 'clue.txt', content: 'visible' }];
        await database.source.transaction(manager => repository.save(manager, event.payload.ownerId, view));
        const injected = { ...view, ownerId: 'private', revision: 'private', latestResult: { ...view.latestResult, input: 'private' },
          currentRoom: { ...view.currentRoom, answer: 'private',
            puzzles: view.currentRoom.puzzles.map(puzzle => ({ ...puzzle, template: 'private',
              sandbox: { ...puzzle.sandbox, jobId: 'private' }, latestResult: { ...view.latestResult, input: 'private' } })),
            files: view.currentRoom.files.map(file => ({ ...file, secret: 'private' })) } };
        await database.source.query('UPDATE projection.session_view SET view=$2::jsonb WHERE session_id=$1', [event.sessionId, JSON.stringify(injected)]);
        const reader = new StreamReader();
        try {
          const response = await reader.open(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, harness.token(event.payload.ownerId));
          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toContain('text/event-stream');
          expect(response.headers.get('cache-control')).toBe('no-cache, no-store, no-transform');
          expect(response.headers.get('x-accel-buffering')).toBe('no');
          await until(() => reader.frames.length === 1);
          expect(reader.frames[0].view).toEqual(view);
          expect(JSON.stringify(reader.frames)).not.toContain('private');
        } finally { await reader.close(); }
        const preflight = await fetch(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, { method: 'OPTIONS',
          headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization,last-event-id' } });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
        expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
      });
      test('rejects unauthorized and unavailable requests before streaming', async () => {
        const event = started();
        await database.source.transaction(manager => repository.save(manager, event.payload.ownerId, fixtureView(event)));
        const path = `/sessions/${event.sessionId}/stream`;
        const owner = harness.token(event.payload.ownerId);
        const cases: { path?: string; token?: string; headers?: Record<string, string>; status: number }[] = [
          { status: 401 }, { token: 'bad', status: 401 }, { token: harness.token(event.payload.ownerId, -1), status: 401 },
          { token: harness.token(randomUUID()), status: 403 }, { token: owner, headers: { Origin: 'https://evil.example' }, status: 403 },
          { token: owner, path: '/sessions/bad/stream', status: 400 },
          { token: owner, headers: { 'Last-Event-ID': '-1' }, status: 400 },
          { token: owner, path: `/sessions/${randomUUID()}/stream`, status: 503 },
        ];
        for (const item of cases) {
          const response = await fetch(harness.baseUrl + (item.path ?? path), {
            headers: { ...(item.token ? { Authorization: `Bearer ${item.token}` } : {}), ...item.headers },
          });
          expect(response.status).toBe(item.status);
          expect(response.headers.get('content-type')).toContain('application/json');
          const body = await response.text();
          expect(body).not.toContain(event.payload.ownerId);
          if (item.status === 503) {
            expect(body).toContain('projection_not_ready');
            expect(response.headers.get('retry-after')).toBe('1');
          }
        }
        const listener = harness.app!.get(ProjectionListener);
        listener.ready = false;
        try {
          const response = await fetch(harness.baseUrl + path, { headers: { Authorization: `Bearer ${owner}` } });
          expect(response.status).toBe(503);
          expect(await response.text()).toContain('projection_unavailable');
        } finally { listener.ready = true; }
        const jwt = harness.config.jwt;
        harness.config.jwt = undefined;
        try {
          const response = await fetch(harness.baseUrl + path, { headers: { Authorization: `Bearer ${owner}` } });
          expect(response.status).toBe(503);
          expect(await response.text()).toContain('projection_unavailable');
        } finally { harness.config.jwt = jwt; }
    });
  });

  async function ensureApp() { if (!harness.app) await harness.startApp(); }
  async function applied(event: GameEvent) {
  await until(() => database.source.getRepository(InboxReceipt).existsBy({ consumer: 'projection', messageId: event.messageId }));
  return (await repository.read(event.sessionId))!;
  }
  async function readersFor(event: ReturnType<typeof started>) {
  await harness.transport.publish('game-events', event);
  await applied(event);
  const readers = [new StreamReader(), new StreamReader()];
  try {
    await Promise.all(readers.map(reader => reader.open(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, harness.token(event.payload.ownerId))));
    await until(() => readers.every(reader => reader.frames.length === 1));
    return readers;
  } catch (error) {
    await Promise.all(readers.map(reader => reader.close()));
    throw error;
  }
  }

  describe('US2 persistence', () => {
  beforeAll(ensureApp);
  test('commits door and expiry notifications, deduplicates identities, and ignores stale events', async () => {
    const consumer = new ProjectionConsumer(database, repository);
    const event = started();
    const notifications: string[] = [];
    const notified = (id: string) => { notifications.push(id); };
    const listener = harness.app!.get(ProjectionListener);
    listener.changes.add(notified);
    try {
      await consumer.handle(event);
      await until(() => notifications.length === 1);
      expect(notifications).toEqual([event.sessionId]);
      const update = changed(event.sessionId, 'PuzzleOpened', {
        roomKey: 'room-1', openedAt: event.occurredAt, puzzle: { ...event.payload.room.puzzles[0], status: 'open' },
      }, 2);
      await consumer.handle(update);
      await until(() => notifications.length === 2);
      await consumer.handle(update);
      await consumer.handle(changed(event.sessionId, 'SessionAbandoned', { endedAt: event.occurredAt }, 1));
      await consumer.handle(changed(event.sessionId, 'DoorOpened', { roomKey: 'room-1', openedAt: event.occurredAt }, 3));
      expect((await repository.read(event.sessionId))?.view.currentRoom.doorOpenedAt).toBe(event.occurredAt);
      await consumer.handle(changed(event.sessionId, 'SessionExpired', { endedAt: event.occurredAt }, 10));
      expect((await repository.read(event.sessionId))).toMatchObject({ version: 10, revision: '4', view: { status: 'Expired' } });
      await database.source.query('SELECT 1');
      await until(() => notifications.length === 4);
      expect(notifications).toHaveLength(4);
      expect(await harness.database.getRepository(InboxReceipt).existsBy({ consumer: 'projection', messageId: event.messageId })).toBe(false);
      await expect(consumer.handle({ ...event, eventId: randomUUID() })).rejects.toThrow('identity');
    } finally { listener.changes.delete(notified); }
  });

  test('rolls back view/receipt/notification and records only generic failures across persisted attempts', async () => {
    const consumer = new ProjectionConsumer(database, repository);
    const event = started();
    const listener = harness.app!.get(ProjectionListener);
    const notified = jest.fn();
    listener.changes.add(notified);
    await database.source.getRepository(ConsumerAttempt).insert({ consumer: 'projection', messageId: event.messageId, attemptCount: 3 });
    const originalSave = repository.save.bind(repository);
    const save = jest.spyOn(repository, 'save').mockImplementation(async (...args) => {
      await originalSave(...args);
      await args[0].query("SELECT pg_notify('session_projection_changed', $1)", [event.sessionId]);
      throw new Error('private input or answer');
    });
    try {
      await consumer.handle(event);
      expect(save).toHaveBeenCalledTimes(2);
      expect(await repository.read(event.sessionId)).toBeNull();
      expect(await database.source.getRepository(InboxReceipt).existsBy({ consumer: 'projection', messageId: event.messageId })).toBe(false);
      expect(await database.source.getRepository(DeadLetter).findOneByOrFail({ consumer: 'projection', messageId: event.messageId }))
        .toMatchObject({ attemptCount: 5, failureDetails: 'Error' });
      expect(notified).not.toHaveBeenCalled();
      await new ProjectionConsumer(database, repository).handle(event);
      expect(save).toHaveBeenCalledTimes(2);
    } finally { save.mockRestore(); listener.changes.delete(notified); }
  });

  test('a locked session does not block unrelated sessions', async () => {
    const consumer = new ProjectionConsumer(database, repository);
    const first = started(), other = started();
    const runner = database.source.createQueryRunner();
    await runner.startTransaction();
    let blocked: Promise<void> | undefined;
    try {
      await runner.query("SELECT pg_advisory_xact_lock(hashtextextended('team5-projection:' || $1::text, 0))", [first.sessionId]);
      blocked = consumer.handle(first);
      await consumer.handle(other);
      expect(await repository.read(other.sessionId)).not.toBeNull();
      expect(await repository.read(first.sessionId)).toBeNull();
      await runner.commitTransaction();
      await blocked;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await blocked;
    }
  });

  test('restarts with durable views/receipts and subscribes before relaying pending outbox', async () => {
    const previous = started();
    await harness.transport.publish('game-events', previous);
    const saved = await applied(previous);
    await harness.app!.close();
    harness.app = undefined;
    const pending = started();
    await harness.database.getRepository(OutboxMessage).insert({ messageId: pending.messageId, sessionId: pending.sessionId,
      stream: 'game-events', payload: pending });
    await harness.startApp();
    await applied(pending);
    await harness.transport.publish('game-events', previous);
    expect(await applied(previous)).toEqual(saved);
    expect(await repository.read(pending.sessionId)).toMatchObject({ revision: '1' });
  });
  });

  describe('US2 delivery', () => {
  beforeAll(ensureApp);
  test('two real readers converge through all six event types including same-version updates', async () => {
    const event = started();
    const readers = await readersFor(event);
    const result = { commandId: randomUUID(), verdict: 'solved' as const, reason: null, output: 'authorized\nclue' };
    const events: GameEvent[] = [
      changed(event.sessionId, 'PuzzleOpened', { roomKey: 'room-1', openedAt: event.occurredAt,
        puzzle: { ...event.payload.room.puzzles[0], status: 'open', sandbox: { generation: 1, status: 'provisioning' } } }),
      changed(event.sessionId, 'PuzzleOpened', { roomKey: 'room-1', openedAt: event.occurredAt,
        puzzle: { ...event.payload.room.puzzles[0], status: 'open', sandbox: { generation: 1, status: 'ready' } } }),
      changed(event.sessionId, 'CommandEvaluated', { roomKey: 'room-1', puzzleKey: 'sql', commandId: result.commandId, result }),
      changed(event.sessionId, 'PuzzleSolved', { roomKey: 'room-1', puzzleKey: 'sql', solvedAt: event.occurredAt, solveSeconds: 1,
        files: [{ name: 'clue', content: 'fictional' }] }),
      changed(event.sessionId, 'RoomEntered', { room: { key: 'room-2', puzzles: [], files: [] }, enteredAt: event.occurredAt }),
      changed(event.sessionId, 'SessionAbandoned', { endedAt: event.occurredAt }),
    ];
    try {
      for (const update of events) {
        await harness.transport.publish('game-events', update);
        const expected = (await applied(update)).view;
        await until(() => readers.every(reader => isDeepStrictEqual(reader.frames.at(-1)?.view, expected)));
        expect(readers[0].frames.at(-1)?.view).toEqual(readers[1].frames.at(-1)?.view);
      }
      expect(readers[0].frames).toHaveLength(events.length + 1);
      expect(readers[0].frames.every(frame => frame.id === '1')).toBe(true);
      expect(readers[0].frames.at(-1)!.view).toEqual({ ...fixtureView(event), status: 'Abandoned', endedAt: event.occurredAt,
        currentRoom: { key: 'room-2', puzzles: [], files: [] }, latestResult: result });
    } finally { await Promise.all(readers.map(reader => reader.close())); }
  });

  test('projects the real engine start-to-room-2 path using the fake SQL executor', async () => {
    await new CatalogRepository(harness.database).seed();
    const engine = harness.app!.get(EngineService);
    const runtime = harness.app!.get(EngineRuntime);
    const start: Extract<PlayerCommand, { type: 'StartSession' }> = { type: 'StartSession',
      messageId: randomUUID(), sessionId: randomUUID(), payload: { userId: randomUUID(), scriptSlug: 'escape-room' } };
    await engine.handle(start);
    await runtime.flush();
    await until(async () => !!await repository.read(start.sessionId));
    const reader = new StreamReader();
    try {
      await reader.open(`${harness.baseUrl}/sessions/${start.sessionId}/stream`, harness.token(start.payload.userId));
      const requests: { request: SandboxJobRequest }[] = await harness.database.query(
        "SELECT request FROM engine_sandbox_requests WHERE session_id=$1", [start.sessionId]);
      await engine.record({ ...requests.find(row => row.request.operation === 'provision')!.request,
        kind: 'ready', occurredAt: new Date().toISOString() });
      const inputs: [string, PuzzleInput][] = [
        ['idan-db', { kind: 'command', command: 'SELECT * FROM logs' }],
        ['hash-cracker', { kind: 'answer', answer: ROOM1.danaPasswordSha256 }],
        ['dana-login', { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword }],
      ];
      for (const [puzzleKey, input] of inputs) {
        await engine.handle({ type: 'SubmitInput', messageId: randomUUID(), sessionId: start.sessionId,
          payload: { userId: start.payload.userId, puzzleKey, input } });
      }
      await runtime.flush();
      await until(() => reader.frames.at(-1)?.view.currentRoom.key === 'room-2');
      const record = (await repository.read(start.sessionId))!;
      expect(reader.frames.at(-1)!.view).toEqual(record.view);
      expect(record.view).toMatchObject({ version: 5, status: 'Active', endedAt: null, revealedHints: [],
        currentRoom: { key: 'room-2', puzzles: [], files: [] }, latestResult: { verdict: 'solved', reason: null } });
    } finally { await reader.close(); }
  });
  });

  describe('US3', () => {
    beforeAll(ensureApp);
    test('Nest health wiring reports independent projection readiness', async () => {
      expect(await harness.app!.get(HealthController).check()).toMatchObject({
        projection: { tables: 'ready', listener: 'ready', consumer: 'connected', auth: 'configured', live: true },
      });
    });
    test('resnapshots missed same-version changes and abandonment for every valid cursor without gameplay side effects', async () => {
      const event = started();
      const before = await harness.database.query(`SELECT
        (SELECT count(*) FROM sessions) AS sessions,
        (SELECT count(*) FROM command_log) AS commands,
        (SELECT count(*) FROM engine_sandbox_requests) AS jobs,
        (SELECT count(*) FROM messaging_outbox) AS outbox`);
      const readers = await readersFor(event);
      await Promise.all(readers.map(reader => reader.close()));
      await harness.transport.publish('game-events', changed(event.sessionId, 'CommandEvaluated', {
        commandId: event.messageId, roomKey: 'room-1', puzzleKey: null,
        result: { commandId: event.messageId, verdict: 'progress', reason: null, output: 'missed' },
      }, 3));
      const abandoned = changed(event.sessionId, 'SessionAbandoned', { endedAt: new Date().toISOString() }, 3);
      await harness.transport.publish('game-events', abandoned);
      const snapshot = (await applied(abandoned)).view;
      for (const cursor of [undefined, '1', '3', '9999']) {
        const reader = new StreamReader();
        try {
          expect((await reader.open(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, harness.token(event.payload.ownerId), cursor)).status).toBe(200);
          await until(() => reader.frames.length === 1);
          expect(reader.frames[0].view).toEqual(snapshot);
        } finally { await reader.close(); }
      }
      expect(await harness.database.query(`SELECT
        (SELECT count(*) FROM sessions) AS sessions,
        (SELECT count(*) FROM command_log) AS commands,
        (SELECT count(*) FROM engine_sandbox_requests) AS jobs,
        (SELECT count(*) FROM messaging_outbox) AS outbox`)).toEqual(before);
      expect((await repository.read(event.sessionId))!.revision).toBe('3');
    });

    test('closes strictly on expiry and accepts a freshly authorized reconnect', async () => {
      const event = started();
      await harness.transport.publish('game-events', event);
      await applied(event);
      const reader = new StreamReader(), fresh = new StreamReader();
      try {
        expect((await reader.open(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, harness.token(event.payload.ownerId, 2))).status).toBe(200);
        await until(() => reader.frames.length === 1);
        await until(() => reader.ended, 2200);
        expect((await fresh.open(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, harness.token(event.payload.ownerId), '1')).status).toBe(200);
        await until(() => fresh.frames.length === 1);
        expect(fresh.frames[0].view).toEqual(reader.frames[0].view);
      } finally { await reader.close(); await fresh.close(); }
    });

    test('closes streams on listener loss and resnapshots after committed LISTEN recovery', async () => {
      const event = started();
      const readers = await readersFor(event);
      const listener = harness.app!.get(ProjectionListener);
      const oldPid = listener.backendPid!;
      const fresh = new StreamReader();
      try {
        expect((await harness.database.query('SELECT pg_terminate_backend($1) AS terminated', [oldPid]))[0].terminated).toBe(true);
        await until(() => readers.every(reader => reader.ended));
        const abandoned = changed(event.sessionId, 'SessionAbandoned', { endedAt: new Date().toISOString() });
        await harness.transport.publish('game-events', abandoned);
        const expected = (await applied(abandoned)).view;
        await until(() => listener.ready && listener.backendPid !== oldPid, 6000);
        expect((await fresh.open(`${harness.baseUrl}/sessions/${event.sessionId}/stream`, harness.token(event.payload.ownerId))).status).toBe(200);
        await until(() => fresh.frames.length === 1);
        expect(fresh.frames[0].view).toEqual(expected);
        const feedback = changed(event.sessionId, 'CommandEvaluated', { commandId: randomUUID(), roomKey: 'room-1', puzzleKey: null,
          result: { commandId: event.messageId, verdict: 'rejected', reason: 'sessionEnded', output: '' } });
        feedback.payload.commandId = feedback.payload.result.commandId;
        await harness.transport.publish('game-events', feedback);
        await applied(feedback);
        await until(() => fresh.frames.length === 2);
        expect(fresh.frames[1].view.status).toBe('Abandoned');
        expect(fresh.frames[1].id).toBe('1');
      } finally { await Promise.all(readers.map(reader => reader.close())); await fresh.close(); }
    });
    test('shutdown cancels pending listener reconnect and releases the owned connection', async () => {
      const listener = new ProjectionListener(harness.config);
      await listener.onModuleInit();
      const pid = listener.backendPid!;
      try {
        await harness.database.query('SELECT pg_terminate_backend($1)', [pid]);
        await until(() => !listener.ready);
      } finally { await listener.onModuleDestroy(); }
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(listener.ready).toBe(false);
      expect(listener.backendPid).toBeUndefined();
      expect(await harness.database.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid])).toEqual([]);
    });
  });

  describe('US2 performance', () => {
  beforeAll(ensureApp);
  test('at least 95/100 updates reach both readers within 1000ms, followed by bounded burst convergence', async () => {
    const event = started();
    const readers = await readersFor(event);
    const durations: number[] = [];
    const update = (index: number) => changed(event.sessionId, 'CommandEvaluated', { commandId: event.messageId,
      roomKey: 'room-1', puzzleKey: null, result: { commandId: event.messageId, verdict: 'progress', reason: null, output: `output ${index}` } });
    try {
      for (let index = 0; index < 100; index++) {
        const message = update(index), submitted = Date.now();
        await harness.transport.publish('game-events', message);
        await until(() => readers.every(reader => reader.frames.at(-1)?.view.latestResult?.output === message.payload.result.output));
        durations.push(Math.max(...readers.map(reader => reader.frames.at(-1)!.receivedAt)) - submitted);
        const expected = (await repository.read(event.sessionId))!.view;
        for (const reader of readers) expect(reader.frames.at(-1)!.view).toEqual(expected);
      }
      const passing = durations.filter(duration => duration <= 1000).length;
      if (passing < 95) throw new Error(`Only ${passing}/100 timely samples: ${durations.join(',')}`);
      let last = update(100);
      let submitted = 0;
      for (let index = 100; index < 120; index++) {
        last = update(index);
        submitted = Date.now();
        await harness.transport.publish('game-events', last);
      }
      await until(() => readers.every(reader => reader.frames.at(-1)?.view.latestResult?.output === last.payload.result.output), 1000);
      const burstMs = Math.max(...readers.map(reader => reader.frames.at(-1)!.receivedAt)) - submitted;
      expect(burstMs).toBeLessThanOrEqual(1000);
      const expected = (await applied(last)).view;
      for (const reader of readers) expect(reader.frames.at(-1)!.view).toEqual(expected);
      expect((await repository.read(event.sessionId))!.revision).toBe('121');
      console.info(`Projection delivery: ${passing}/100 <=1000ms; max=${Math.max(...durations)}ms; burst=${burstMs}ms`);
    } finally { await Promise.all(readers.map(reader => reader.close())); }
  }, 30000);
  });
});
