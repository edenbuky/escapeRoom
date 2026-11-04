import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { KubernetesDriver } from '../src/modules/sandbox/kubernetes-driver';
import type { ExecRequest } from '../src/modules/sandbox/sandbox.contracts';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { SandboxRepository } from '../src/modules/sandbox/sandbox.repository';
import { SandboxExecutorService } from '../src/modules/sandbox/sandbox-executor';
import { SandboxHarness } from './helpers/sandbox-harness';

const databaseTests = process.env.RUN_SANDBOX_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('durable SQL admission, replay and recovery', () => {
  const harness = new SandboxHarness();
  const image = `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`;
  let database: DataSource;
  let repository: SandboxRepository;
  let driver: KubernetesDriver;
  let executor: SandboxExecutorService;
  let request: ExecRequest;
  const result = (commandId: string) => ({ version: 1, commandId, stdout: 'value\none\n', stderr: '',
    exitCode: 0, timedOut: false, truncated: false });

  beforeAll(async () => {
    await harness.start();
    database = harness.database!;
    await database.query(`INSERT INTO catalog.component_templates(key,version,family,engine,definition,status)
      VALUES ('idan-db-sql',2,'sandbox','sql',$1,'published')`,
    [{ imageDigest: image, seedRef: 'room1-sql-v1', policy: { maxQueryChars: 4096 } }]);
  }, 90000);
  afterAll(() => harness.close(), 90000);
  beforeEach(async () => {
    repository = new SandboxRepository(database);
    driver = new KubernetesDriver({ runtimeClass: 'runc', imageAllowlist: ['localhost:5001/room1-sql'] });
    jest.spyOn(driver, 'helper').mockImplementation(async (_job, _uid, mode, input) => mode === 'query'
      ? result(String(input?.commandId))
      : { version: 1, executionToken: input?.executionToken, quiesced: true });
    jest.spyOn(driver, 'remove').mockResolvedValue();
    executor = new SandboxExecutorService(database, repository, driver, () => true);
    const identity = sandboxIdentity(randomUUID(), 'idan-db', 1);
    request = { ...identity, commandId: randomUUID(), command: 'SELECT 1' };
    await database.query(`INSERT INTO sessions VALUES ($1,$2,'escape-room',2,1,$3,now())`,
      [identity.sessionId, randomUUID(), { status: 'Active', visitedRooms: ['r1'],
        deadlineAt: new Date(Date.now() + 900000).toISOString() }]);
    await database.query('INSERT INTO session_puzzles VALUES ($1,$2,$3)', [identity.sessionId, identity.puzzleKey,
      { key: identity.puzzleKey, family: 'sql', status: 'open', roomKey: 'r1', templateRef: 'idan-db-sql@2',
        sandbox: { generation: 1, status: 'ready' } }]);
    await repository.createInstance(database.manager, { ...identity, templateRef: 'idan-db-sql@2',
      imageDigest: image, seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2' });
    await database.query("UPDATE sandbox_instances SET status='ready',pod_uid=$1 WHERE sandbox_id=$1", [request.podName]);
  });
  afterEach(async () => { await executor?.stop(); await repository?.close(); jest.restoreAllMocks(); });

  test('commits admission before dispatch and replays unchanged without renewing the lease', async () => {
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode, input) => {
      if (mode !== 'query') return { version: 1, executionToken: input?.executionToken, quiesced: true };
      expect(await database.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
        [request.commandId])).toEqual([{ status: 'running' }]);
      return result(request.commandId);
    });
    const first = await executor.execute(request);
    const [lease] = await database.query('SELECT lease_expires_at FROM sandbox_instances WHERE sandbox_id=$1', [request.podName]);
    expect(await executor.execute(request)).toEqual(first);
    expect(await database.query('SELECT lease_expires_at FROM sandbox_instances WHERE sandbox_id=$1',
      [request.podName])).toEqual([lease]);
    expect(jest.mocked(driver.helper).mock.calls.filter(call => call[2] === 'query')).toHaveLength(1);
    await expect(executor.execute({ ...request, command: `${request.command} ` })).rejects.toMatchObject({ code: 'commandConflict' });
  });

  test('busy and in-progress never reserve the next identity or renew its lease', async () => {
    let release!: () => void;
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode, input) => {
      if (mode !== 'query') return { version: 1, executionToken: input?.executionToken, quiesced: true };
      dispatched(); await waiting; return result(String(input?.commandId));
    });
    const first = executor.execute(request);
    await started;
    const other = { ...request, commandId: randomUUID() };
    try {
      await expect(executor.execute(other)).rejects.toMatchObject({ code: 'busy' });
      await expect(executor.execute(request)).rejects.toMatchObject({ code: 'inProgress' });
      expect(await database.query('SELECT command_id FROM sandbox_executions WHERE command_id=$1', [other.commandId])).toEqual([]);
    } finally { release(); await first; }
    await expect(executor.execute(other)).resolves.toMatchObject({ commandId: other.commandId });
  });

  test('replay survives expiry, while a new identity durably requests irreversible destruction', async () => {
    const first = await executor.execute(request);
    await database.query('UPDATE sandbox_instances SET lease_expires_at=created_at WHERE sandbox_id=$1', [request.podName]);
    expect(await executor.execute(request)).toEqual(first);
    await expect(executor.execute({ ...request, commandId: randomUUID() })).rejects.toMatchObject({ code: 'expired' });
    expect(await database.query('SELECT desired_state FROM sandbox_instances WHERE sandbox_id=$1',
      [request.podName])).toEqual([{ desired_state: 'destroyed' }]);
    expect(await database.query(`SELECT count(*)::int AS count FROM engine_sandbox_requests
      WHERE session_id=$1 AND request->>'operation'='destroy'`, [request.sessionId])).toEqual([{ count: 1 }]);
  });

  test('does not consume invalid statements, stale generations, or unready requests', async () => {
    await expect(executor.execute({ ...request, command: 'SELECT 1; SELECT 2' })).rejects.toMatchObject({ code: 'policyBlocked' });
    const stale = { ...request, ...sandboxIdentity(request.sessionId, request.puzzleKey, 2) };
    await expect(executor.execute(stale)).rejects.toMatchObject({ code: 'staleGeneration' });
    await database.query("UPDATE sandbox_instances SET status='unavailable' WHERE sandbox_id=$1", [request.podName]);
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'notReady' });
    expect(await database.query('SELECT command_id FROM sandbox_executions WHERE sandbox_id=$1', [request.podName])).toEqual([]);
    expect(driver.helper).not.toHaveBeenCalled();
  });

  test('consumes an uncertain dispatch once, confirms token cancellation and retains interruption', async () => {
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode, input) => {
      if (mode === 'query') throw new SandboxExecutionError('runtimeUnavailable');
      return { version: 1, executionToken: input?.executionToken, quiesced: mode === 'cancel' };
    });
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'interrupted' });
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'interrupted' });
    expect(jest.mocked(driver.helper).mock.calls.filter(call => call[2] === 'query')).toHaveLength(1);
    expect(await database.query('SELECT status,active_command_id FROM sandbox_instances WHERE sandbox_id=$1',
      [request.podName])).toEqual([{ status: 'ready', active_command_id: null }]);
  });

  test('fences and removes the owned pod when token-specific quiescence is unavailable', async () => {
    jest.mocked(driver.helper).mockRejectedValue(new SandboxExecutionError('runtimeUnavailable'));
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'interrupted' });
    expect(driver.remove).toHaveBeenCalledWith(expect.objectContaining({ podName: request.podName }), request.podName);
    expect(await database.query('SELECT desired_state,status FROM sandbox_instances WHERE sandbox_id=$1',
      [request.podName])).toEqual([{ desired_state: 'destroyed', status: 'destroyed' }]);
    expect(await database.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
      [request.commandId])).toEqual([{ status: 'interrupted' }]);
  });

  test('ten concurrent duplicates and ten post-restart replays dispatch once and preserve the exact terminal row', async () => {
    const helper = driver.helper.bind(driver);
    jest.mocked(driver.helper).mockImplementationOnce(async (job, uid, mode, input, timeout) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return mode === 'query' ? result(String(input?.commandId)) : helper(job, uid, mode, input, timeout);
    });
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => executor.execute(request)));
    expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: expect.stringMatching(/^(busy|inProgress)$/) });
    }
    const before = await database.query('SELECT * FROM sandbox_executions WHERE command_id=$1', [request.commandId]);
    await executor.stop();
    await repository.close();
    repository = new SandboxRepository(database);
    executor = new SandboxExecutorService(database, repository, driver, () => true);
    for (let replay = 0; replay < 10; replay++) await expect(executor.execute(request)).resolves.toMatchObject({ stdout: 'value\none\n' });
    expect(await database.query('SELECT * FROM sandbox_executions WHERE command_id=$1', [request.commandId])).toEqual(before);
    expect(jest.mocked(driver.helper).mock.calls.filter(call => call[2] === 'query')).toHaveLength(1);
    await expect(executor.execute({ ...request, ...sandboxIdentity(request.sessionId, request.puzzleKey, 2) }))
      .rejects.toMatchObject({ code: 'commandConflict' });
  });

  test.each([false, true])('terminal commit fault after server commit=%s never redispatches or overwrites durable completion', async afterCommit => {
    const create = database.createQueryRunner.bind(database);
    let commits = 0;
    jest.spyOn(database, 'createQueryRunner').mockImplementation(mode => {
      const runner = create(mode);
      const commit = runner.commitTransaction.bind(runner);
      jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
        commits++;
        if (commits !== 2) { await commit(); return; }
        if (afterCommit) await commit();
        throw new Error('injected terminal commit transport failure');
      });
      return runner;
    });
    if (afterCommit) {
      const saved = await executor.execute(request);
      expect(await executor.execute(request)).toEqual(saved);
      expect(saved.exitCode).toBe(0);
    } else {
      await expect(executor.execute(request)).rejects.toMatchObject({ code: 'interrupted' });
      await expect(executor.execute(request)).rejects.toMatchObject({ code: 'interrupted' });
    }
    expect(jest.mocked(driver.helper).mock.calls.filter(call => call[2] === 'query')).toHaveLength(1);
    expect(await database.query('SELECT status FROM sandbox_executions WHERE command_id=$1', [request.commandId]))
      .toEqual([{ status: afterCommit ? 'completed' : 'interrupted' }]);
  });

  test('two occupied sandbox connections leave reserved database capacity for unrelated work', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const locks = [repository.withLock(request, () => waiting),
      repository.withLock(sandboxIdentity(randomUUID(), 'idan-db', 1), () => waiting)];
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      const started = Date.now();
      expect(await database.query('SELECT 42 AS value')).toEqual([{ value: 42 }]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally { release(); await Promise.all(locks); }
  });

  test('restart recovery never redispatches a committed running identity', async () => {
    const token = randomUUID();
    await database.transaction(async manager => {
      await manager.query(`INSERT INTO sandbox_executions(command_id,sandbox_id,input_hash,execution_token)
        VALUES ($1,$2,encode(sha256(convert_to($3,'UTF8')),'hex'),$4)`,
      [request.commandId, request.podName, request.command, token]);
      await manager.query('UPDATE sandbox_instances SET active_command_id=$2 WHERE sandbox_id=$1',
        [request.podName, request.commandId]);
    });
    await executor.recover();
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'interrupted' });
    expect(jest.mocked(driver.helper).mock.calls.some(call => call[2] === 'query')).toBe(false);
  });
});
