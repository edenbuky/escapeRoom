import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PlayerCommand } from '@team5/contracts';
import { DataSource } from 'typeorm';
import { createEngineApp } from '../src/bootstrap';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { ROOM1 } from '../src/modules/script-catalog/room1';
import { EngineService } from '../src/modules/sessions/engine.service';
import { EngineRepository } from '../src/modules/sessions/engine.repository';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { SandboxHarness } from './helpers/sandbox-harness';
import type { ProvisionJob } from '../src/modules/sandbox/sandbox.contracts';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { SandboxWorker } from '../src/modules/sandbox/sandbox-worker';

const databaseTests = process.env.RUN_SANDBOX_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('SQL preparation outside engine inbox transactions', () => {
  const harness = new SandboxHarness();
  const execute = jest.fn();
  let database: DataSource;
  let app: INestApplication;
  let engine: EngineService;
  let repository: EngineRepository;
  beforeAll(async () => {
    await harness.start();
    database = harness.database!;
    await new CatalogRepository(database).seed();
    app = await createEngineApp({ config: harness.config, database, executor: { execute } });
    engine = app.get(EngineService);
    repository = app.get(EngineRepository);
  }, 90000);
  afterAll(async () => { try { await app?.close(); } finally { await harness.close(); } }, 90000);
  beforeEach(() => {
    execute.mockReset().mockImplementation(async ({ commandId }: { commandId: string }) =>
      ({ commandId, stdout: `hash\n${ROOM1.danaPasswordSha256}\n`, stderr: '', exitCode: 0,
        timedOut: false, truncated: false }));
  });

  async function session() {
    const start: Extract<PlayerCommand, { type: 'StartSession' }> = { type: 'StartSession',
      messageId: randomUUID(), sessionId: randomUUID(), payload: { userId: randomUUID(), scriptSlug: 'escape-room' } };
    await engine.handle(start);
    const [{ request }] = await database.query('SELECT request FROM engine_sandbox_requests WHERE session_id=$1', [start.sessionId]);
    await engine.record({ ...request, kind: 'ready', occurredAt: new Date().toISOString() });
    const input: Extract<PlayerCommand, { type: 'SubmitInput' }> = { type: 'SubmitInput',
      messageId: randomUUID(), sessionId: start.sessionId,
      payload: { userId: start.payload.userId, puzzleKey: 'idan-db', input: { kind: 'command', command: 'SELECT 1' } } };
    return input;
  }

  test('six busy/in-progress retries consume no inbox, retry budget, command log or outbox; original ID then succeeds', async () => {
    const input = await session();
    const before = await database.query('SELECT count(*)::int AS count FROM messaging_outbox WHERE session_id=$1', [input.sessionId]);
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = attempt % 2 ? 'inProgress' : 'busy';
      execute.mockRejectedValueOnce(new SandboxExecutionError(code));
      await expect(engine.handle(input)).rejects.toMatchObject({ code });
    }
    for (const table of ['messaging_inbox_receipt', 'messaging_consumer_attempt', 'messaging_dead_letter']) {
      expect(await database.query(`SELECT message_id FROM ${table} WHERE consumer='engine' AND message_id=$1`,
        [input.messageId])).toEqual([]);
    }
    expect(await database.query('SELECT command_id FROM command_log WHERE command_id=$1', [input.messageId])).toEqual([]);
    expect(await database.query('SELECT count(*)::int AS count FROM messaging_outbox WHERE session_id=$1',
      [input.sessionId])).toEqual(before);
    await engine.handle(input);
    expect((await repository.load(database.manager, input.sessionId))!.puzzles.find(puzzle => puzzle.key === 'idan-db')!.status)
      .toBe('solved');
  });

  test('does not open a retry attempt before SQL, and retains the two-second engine statement timeout', async () => {
    const input = await session();
    execute.mockImplementationOnce(async ({ commandId }: { commandId: string }) => {
      expect(await database.query(`SELECT message_id FROM messaging_consumer_attempt WHERE consumer='engine'
        AND message_id=$1`, [input.messageId])).toEqual([]);
      expect(await database.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '2s' }]);
      return { commandId, stdout: 'x\n1\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    });
    await engine.handle(input);
    expect(execute).toHaveBeenCalledTimes(1);
    await engine.handle(input);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('an injected executor suppresses enabled real worker startup and leaves the caller database owned by the caller', async () => {
    const injected = await createEngineApp({ database, executor: { execute }, config: { ...harness.config,
      sandbox: { enabled: true, kubeContext: 'kind-skillbreak-local', imageAllowlist: ['localhost:5001/room1-sql'], workerConcurrency: 2 } } });
    try { expect(injected.get(SandboxWorker).status).toBe('disabled'); }
    finally { await injected.close(); }
    expect(database.isInitialized).toBe(true);
  });

  test('a delayed ready outcome cannot revive a generation after committed destruction', async () => {
    const input = await session();
    const [{ request: original }]: { request: ProvisionJob }[] = await database.query(
      'SELECT request FROM engine_sandbox_requests WHERE session_id=$1', [input.sessionId]);
    const delayed = { ...original, jobId: randomUUID() };
    const destroy = { ...sandboxIdentity(original.sessionId, original.puzzleKey, original.generation),
      jobId: randomUUID(), operation: 'destroy' as const };
    for (const job of [delayed, destroy]) {
      await database.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
        [job.jobId, job.sessionId, job]);
    }
    await engine.record({ ...destroy, kind: 'destroyed', occurredAt: new Date().toISOString() });
    await engine.record({ ...delayed, kind: 'ready', occurredAt: new Date().toISOString() });
    expect((await repository.load(database.manager, input.sessionId))!.puzzles.find(p => p.key === 'idan-db')!.sandbox.status)
      .toBe('none');
  });

  test('the real outcome sink recovers after more than five persistence failures without permanent dead-lettering', async () => {
    const sessionId = randomUUID();
    await engine.handle({ type: 'StartSession', messageId: randomUUID(), sessionId,
      payload: { userId: randomUUID(), scriptSlug: 'escape-room' } });
    const [{ request }]: { request: ProvisionJob }[] = await database.query(
      'SELECT request FROM engine_sandbox_requests WHERE session_id=$1', [sessionId]);
    const outcome = { ...request, kind: 'ready' as const, occurredAt: new Date().toISOString() };
    const failure = jest.spyOn(repository, 'save').mockRejectedValue(new Error('injected outcome persistence failure'));
    try {
      for (let attempt = 0; attempt < 6; attempt++) await expect(engine.record(outcome)).rejects.toThrow('injected');
    } finally { failure.mockRestore(); }
    await engine.record(outcome);
    expect((await repository.load(database.manager, sessionId))!.puzzles.find(p => p.key === 'idan-db')!.sandbox.status).toBe('ready');
    expect(await database.query("SELECT message_id FROM messaging_dead_letter WHERE consumer='engine-sandbox'")).toEqual([]);
  });

  test('does not apply an old prepared result to a newer generation', async () => {
    const input = await session();
    execute.mockImplementationOnce(async ({ commandId }: { commandId: string }) => {
      await database.transaction(async manager => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.sessionId]);
        const snapshot = (await repository.load(manager, input.sessionId))!;
        const next = structuredClone(snapshot);
        next.version++;
        next.puzzles.find(puzzle => puzzle.key === 'idan-db')!.sandbox.generation++;
        await repository.save(manager, next, snapshot.version, new Date());
      });
      return { commandId, stdout: `hash\n${ROOM1.danaPasswordSha256}\n`, stderr: '', exitCode: 0,
        timedOut: false, truncated: false };
    });
    await engine.handle(input);
    const puzzle = (await repository.load(database.manager, input.sessionId))!.puzzles.find(p => p.key === 'idan-db')!;
    expect(puzzle.sandbox.generation).toBe(2);
    expect(puzzle.status).toBe('open');
    expect(puzzle.latestResult).toMatchObject({ verdict: 'rejected', reason: 'sandboxRestarting' });
  });
});
