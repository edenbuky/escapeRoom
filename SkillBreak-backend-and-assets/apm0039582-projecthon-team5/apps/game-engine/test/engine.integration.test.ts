import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import type { GameEvent, PlayerCommand, PuzzleInput } from '@team5/contracts';
import { InMemoryTransport } from '@team5/messaging';
import { DataSource } from 'typeorm';
import { createEngineApp } from '../src/bootstrap';
import { databaseOptions, loadConfig } from '../src/config/config';
import { FoundationSchemas1793570400000 } from '../src/database/migrations/1793570400000-FoundationSchemas';
import { CatalogSchema1793570401000 } from '../src/database/migrations/1793570401000-CatalogSchema';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { ROOM1 } from '../src/modules/script-catalog/room1';
import { EngineService } from '../src/modules/sessions/engine.service';
import { EngineRepository, VersionConflict } from '../src/modules/sessions/engine.repository';
import { EngineRuntime } from '../src/modules/sessions/engine-runtime';
import type { SandboxJobRequest } from '../src/modules/sandbox/sandbox.contracts';

const databaseTests = process.env.RUN_ENGINE_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('engine PostgreSQL integration (disposable database, fake SQL executor)', () => {
  let container: string | undefined;
  let database: DataSource;
  let app: INestApplication;
  let engine: EngineService;
  let repository: EngineRepository;
  let baseUrl: string;
  const token = randomBytes(32).toString('base64');
  const now = new Date('2026-11-02T10:00:00Z');
  const config = loadConfig({ DATABASE_URL: 'postgres://postgres:temporary@127.0.0.1/engine_test',
    REDIS_URL: 'redis://127.0.0.1:1', INTERNAL_API_TOKEN: token });
  const execute = jest.fn(async (request: { commandId: string }) => ({ commandId: request.commandId,
    stdout: `hash\n${ROOM1.danaPasswordSha256}\n`, stderr: '', exitCode: 0, timedOut: false, truncated: false }));

  beforeAll(async () => {
    const password = randomBytes(32).toString('hex');
    container = execFileSync('docker', ['run', '--detach', '--rm', '--label', 'team5.test=engine-1.4',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=engine_test',
      '--publish', '127.0.0.1::5432', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', 'postgres:16-alpine'],
    { encoding: 'utf8', timeout: 60000 }).trim();
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop());
    if (!Number.isInteger(port) || port < 1) throw new Error('Temporary database port unavailable');
    config.databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/engine_test`;
    database = new DataSource({ ...databaseOptions(config), migrations: [FoundationSchemas1793570400000, CatalogSchema1793570401000] });
    const deadline = Date.now() + 30000;
    while (!database.isInitialized) {
      try { await database.initialize(); }
      catch { if (Date.now() >= deadline) throw new Error('Temporary PostgreSQL not ready'); await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    await database.runMigrations();
    await new CatalogRepository(database).seed();
    await database.destroy();
    database = new DataSource(databaseOptions(config));
    await database.initialize();
    await database.runMigrations();
    app = await createEngineApp({ config, database, executor: { execute }, clock: () => now });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    engine = app.get(EngineService);
    repository = app.get(EngineRepository);
  }, 90000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      try { if (database?.isInitialized) await database.destroy(); }
      finally { if (container) execFileSync('docker', ['stop', '--time', '1', container], { stdio: 'ignore', timeout: 30000 }); }
    }
  }, 40000);
  afterEach(() => { jest.restoreAllMocks(); execute.mockClear(); });

  function start(): Extract<PlayerCommand, { type: 'StartSession' }> {
    return { type: 'StartSession', messageId: randomUUID(), sessionId: randomUUID(), payload: { userId: randomUUID(), scriptSlug: 'escape-room' } };
  }
  function input(session: ReturnType<typeof start>, puzzleKey: string, value: PuzzleInput): PlayerCommand {
    return { type: 'SubmitInput', messageId: randomUUID(), sessionId: session.sessionId,
      payload: { userId: session.payload.userId, puzzleKey, input: value } };
  }
  async function load(sessionId: string) { return repository.load(database.manager, sessionId); }
  async function events(sessionId: string): Promise<GameEvent[]> {
    const rows: { payload: GameEvent }[] = await database.query(
      'SELECT payload FROM messaging_outbox WHERE session_id = $1 ORDER BY created_at, message_id', [sessionId]);
    return rows.map(row => row.payload);
  }
  async function ready(sessionId: string) {
    const rows: { request: SandboxJobRequest }[] = await database.query(
      'SELECT request FROM engine_sandbox_requests WHERE session_id = $1 ORDER BY created_at', [sessionId]);
    const request = rows.find(row => row.request.operation === 'provision')!.request;
    const outcome = { ...request, kind: 'ready' as const, occurredAt: now.toISOString() };
    await engine.record(outcome);
    return outcome;
  }

  test('upgrades the seeded catalog without changing existing migration identities or content', async () => {
    expect(await database.query('SELECT name FROM migrations ORDER BY timestamp')).toEqual([
      { name: 'FoundationSchemas1793570400000' }, { name: 'CatalogSchema1793570401000' }, { name: 'EngineSchema1793570402000' },
      { name: 'SqlSandbox1793570403000' },
      { name: 'SessionProjection1793570404000' },
    ]);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.runMigrations()).toEqual([]);
    expect(await new CatalogRepository(database).current('escape-room')).toEqual({ scriptId: 'escape-room', version: 1 });
    expect(await database.query("SELECT tablename FROM pg_tables WHERE schemaname='projection' ORDER BY tablename")).toEqual([
      { tablename: 'messaging_consumer_attempt' }, { tablename: 'messaging_dead_letter' },
      { tablename: 'messaging_inbox_receipt' }, { tablename: 'session_view' },
    ]);
  });

  test('also migrates an entirely fresh disposable database', async () => {
    await database.query('CREATE DATABASE engine_fresh');
    const url = new URL(config.databaseUrl);
    url.pathname = '/engine_fresh';
    const fresh = new DataSource(databaseOptions({ ...config, databaseUrl: url.toString() }));
    try {
      await fresh.initialize();
      expect(await fresh.runMigrations()).toHaveLength(5);
      await new CatalogRepository(fresh).seed();
      expect(await fresh.query('SELECT count(*)::int AS count FROM sessions')).toEqual([{ count: 0 }]);
    } finally { if (fresh.isInitialized) await fresh.destroy(); }
  });

  test('plays StartSession through room 2 with real components and fake sandbox execution', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const session = start();
    await engine.handle(session);
    const initial = await load(session.sessionId);
    expect(initial).toMatchObject({ version: 1, scriptVersion: 1, deadlineAt: '2026-11-02T10:45:00.000Z' });
    const outcome = await ready(session.sessionId);
    await engine.record(outcome);
    expect((await load(session.sessionId))!.version).toBe(2);
    await engine.handle(input(session, 'idan-db', { kind: 'command', command: 'SELECT * FROM logs' }));
    await engine.handle(input(session, 'hash-cracker', { kind: 'answer', answer: ROOM1.danaPasswordSha256 }));
    await engine.handle(input(session, 'dana-login', { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword }));
    expect(await load(session.sessionId)).toMatchObject({ roomKey: 'room-2', status: 'Active', version: 5,
      visitedRooms: ['room-1', 'room-2'], deadlineAt: initial!.deadlineAt });
    expect((await events(session.sessionId)).at(-1)?.type).toBe('RoomEntered');
    await engine.handle(input(session, 'idan-db', { kind: 'command', command: 'SELECT * FROM logs' }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await events(session.sessionId)).at(-1)?.type).toBe('CommandEvaluated');
    expect(await database.query('SELECT DISTINCT input_redacted FROM command_log WHERE session_id=$1', [session.sessionId]))
      .toEqual([{ input_redacted: '[redacted]' }]);
    const gameLines = log.mock.calls.map(call => String(call[0])).filter(line => line.includes(`sessionId=${session.sessionId}`));
    expect(gameLines).toEqual(expect.arrayContaining([`Game started sessionId=${session.sessionId} roomKey=room-1`,
      `Answer evaluated sessionId=${session.sessionId} roomKey=room-1 puzzleKey=hash-cracker verdict=solved reason=none`,
      `Answer evaluated sessionId=${session.sessionId} roomKey=room-1 puzzleKey=dana-login verdict=solved reason=none`]));
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of [ROOM1.danaPassword, ROOM1.danaPasswordSha256, 'SELECT', session.payload.userId, token]) expect(logged).not.toContain(secret);
  });

  test('duplicate delivery and repeated StartSession do not double-apply', async () => {
    const session = start();
    await Promise.all([engine.handle(session), engine.handle(session)]);
    await engine.handle({ ...session, messageId: randomUUID() });
    expect((await load(session.sessionId))!.version).toBe(1);
    expect(await events(session.sessionId)).toHaveLength(2);
    await ready(session.sessionId);
    const command = input(session, 'idan-db', { kind: 'command', command: 'SELECT 1' });
    await Promise.all([engine.handle(command), engine.handle(command)]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await load(session.sessionId))!.version).toBe(3);
  });

  test('version conflicts retry the engine transaction while reusing the prepared SQL result', async () => {
    const session = start();
    await engine.handle(session);
    await ready(session.sessionId);
    const save = jest.spyOn(repository, 'save').mockRejectedValueOnce(new VersionConflict('test conflict'));
    const command = input(session, 'idan-db', { kind: 'command', command: 'SELECT 1' });
    await engine.handle(command);
    expect(save).toHaveBeenCalledTimes(2);
    expect((await load(session.sessionId))!.version).toBe(3);
    expect((await events(session.sessionId)).filter(event => event.type === 'CommandEvaluated')).toHaveLength(1);
    expect(execute.mock.calls.map(call => call[0].commandId)).toEqual([command.messageId]);
  });

  test('concurrent writers preserve all command effects and reject stale repository versions', async () => {
    const session = start();
    await engine.handle(session);
    await ready(session.sessionId);
    await Promise.all([engine.handle(input(session, 'idan-db', { kind: 'command', command: 'SELECT 1' })),
      engine.handle(input(session, 'idan-db', { kind: 'command', command: 'SELECT 2' }))]);
    const snapshot = (await load(session.sessionId))!;
    expect(snapshot.version).toBe(4);
    expect(snapshot.puzzles.find(puzzle => puzzle.key === 'idan-db')!.attempts).toBe(2);
    await expect(database.transaction(manager => repository.save(manager, { ...snapshot, version: 5 }, 1, now)))
      .rejects.toBeInstanceOf(VersionConflict);
  });

  test('rollback removes state, jobs, logs and inbox before dead-lettering after five attempts', async () => {
    const session = start();
    const originalSave = repository.save.bind(repository);
    const save = jest.spyOn(repository, 'save').mockImplementation(async (...args) => {
      await originalSave(...args);
      throw new Error(`private ${ROOM1.danaPassword}`);
    });
    await engine.handle(session);
    expect(save).toHaveBeenCalledTimes(5);
    expect(await load(session.sessionId)).toBeNull();
    expect(await events(session.sessionId)).toEqual([]);
    expect(await database.query('SELECT * FROM engine_sandbox_requests WHERE session_id=$1', [session.sessionId])).toEqual([]);
    expect(await database.query('SELECT * FROM messaging_inbox_receipt WHERE message_id=$1', [session.messageId])).toEqual([]);
    const dead = await database.query('SELECT attempt_count, failure_details FROM messaging_dead_letter WHERE message_id=$1', [session.messageId]);
    expect(dead).toEqual([{ attempt_count: 5, failure_details: 'Error' }]);
    await engine.handle(session);
    expect(save).toHaveBeenCalledTimes(5);
  });

  test('unknown scripts and wrong owners produce no session changes', async () => {
    const unknown = start();
    unknown.payload.scriptSlug = 'missing';
    await engine.handle(unknown);
    expect(await load(unknown.sessionId)).toBeNull();
    const session = start();
    await engine.handle(session);
    await engine.handle({ type: 'AbandonSession', messageId: randomUUID(), sessionId: session.sessionId, payload: { userId: randomUUID() } });
    expect((await load(session.sessionId))!.version).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test('unrecognized and obsolete sandbox outcomes cannot mark a puzzle ready', async () => {
    const session = start();
    await engine.handle(session);
    const rows: { request: SandboxJobRequest }[] = await database.query('SELECT request FROM engine_sandbox_requests WHERE session_id=$1', [session.sessionId]);
    const job = rows[0].request;
    await engine.record({ ...job, kind: 'ready', jobId: randomUUID(), occurredAt: now.toISOString() });
    await engine.record({ ...job, kind: 'ready', generation: 0, occurredAt: now.toISOString() });
    expect((await load(session.sessionId))!.version).toBe(1);
    await engine.record({ ...job, kind: 'ready', occurredAt: now.toISOString() });
    expect((await load(session.sessionId))!.version).toBe(2);
  });

  test('outbox insert failure rolls back preceding session and sandbox-request writes', async () => {
    const session = start();
    await database.query(`CREATE FUNCTION fail_engine_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = '${session.sessionId}' THEN RAISE EXCEPTION 'test outbox failure'; END IF; RETURN NEW; END; $$`);
    await database.query('CREATE TRIGGER fail_engine_outbox_test BEFORE INSERT ON messaging_outbox FOR EACH ROW EXECUTE FUNCTION fail_engine_outbox_test()');
    try {
      await engine.handle(session);
      expect(await load(session.sessionId)).toBeNull();
      expect(await database.query('SELECT * FROM engine_sandbox_requests WHERE session_id=$1', [session.sessionId])).toEqual([]);
      expect(await database.query('SELECT * FROM messaging_inbox_receipt WHERE message_id=$1', [session.messageId])).toEqual([]);
      expect(await events(session.sessionId)).toEqual([]);
    } finally {
      await database.query('DROP TRIGGER fail_engine_outbox_test ON messaging_outbox');
      await database.query('DROP FUNCTION fail_engine_outbox_test()');
    }
  });

  test('owner lookup authenticates before SQL and returns only ownership', async () => {
    const session = start();
    await engine.handle(session);
    const query = jest.spyOn(database, 'query');
    for (const headers of [{}, { 'x-internal-token': 'wrong' }] as Record<string, string>[]) {
      const response = await fetch(`${baseUrl}/internal/sessions/${session.sessionId}/owner`, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(query).not.toHaveBeenCalled();
    const request = (id: string) => fetch(`${baseUrl}/internal/sessions/${id}/owner`, { headers: { 'x-internal-token': token } });
    expect(await (await request(session.sessionId)).json()).toEqual({ ownerId: session.payload.userId });
    expect((await request(randomUUID())).status).toBe(404);
    expect((await request('invalid')).status).toBe(400);
  });

  test('Eden relay preserves sibling-event order and retries failed delivery without changing identity', async () => {
    const session = start();
    await engine.handle(session);
    const transport = new InMemoryTransport();
    const received: GameEvent[] = [];
    const subscription = await transport.subscribe('game-events', 'test-projection', async event => { received.push(event); });
    const publish = jest.spyOn(transport, 'publish').mockRejectedValueOnce(new Error('offline'));
    const runtime = new EngineRuntime(database, engine, { producer: transport });
    try {
      await expect(runtime.flush()).rejects.toThrow('offline');
      await runtime.flush();
    } finally { await runtime.onModuleDestroy(); await subscription.close(); }
    expect(publish).toHaveBeenCalled();
    expect(received.filter(event => event.sessionId === session.sessionId).map(event => event.type)).toEqual(['SessionStarted', 'PuzzleOpened']);
    expect(received.filter(event => event.sessionId === session.sessionId).map(event => event.eventId))
      .toEqual((await events(session.sessionId)).map(event => event.eventId));
  });

  test('factory subscribes before returning and drains delivery on close without closing injected DB', async () => {
    const transport = new InMemoryTransport();
    const injected = await createEngineApp({ config, database, consumer: transport, producer: transport, executor: { execute }, clock: () => now });
    expect(injected.get(EngineRuntime).connected).toBe(true);
    const session = start();
    await transport.publish('player-commands', session);
    await injected.close();
    expect(database.isInitialized).toBe(true);
    expect((await load(session.sessionId))!.version).toBe(1);
    const ignored = start();
    await transport.publish('player-commands', ignored);
    expect(await load(ignored.sessionId)).toBeNull();
  });

  test('factory closes its owned database and leaves standalone messaging disconnected', async () => {
    const owned = await createEngineApp({ config });
    const connection = owned.get(DataSource);
    expect(connection.isInitialized).toBe(true);
    expect(owned.get(EngineRuntime).connected).toBe(false);
    await owned.close();
    expect(connection.isInitialized).toBe(false);
  });
});