import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { KubernetesDriver } from '../src/modules/sandbox/kubernetes-driver';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import type { ProvisionJob, SandboxOutcome } from '../src/modules/sandbox/sandbox.contracts';
import { SandboxHarness } from './helpers/sandbox-harness';
import { decodeSqlRows, validateHelperResult } from '../src/modules/sandbox/sql-result';
import { ROOM1 } from '../src/modules/script-catalog/room1';
import type { INestApplication } from '@nestjs/common';
import type { PlayerCommand, PuzzleInput } from '@team5/contracts';
import { createEngineApp } from '../src/bootstrap';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { publishSqlRoom1 } from '../src/modules/script-catalog/publish-sql-room1';
import { EngineService } from '../src/modules/sessions/engine.service';
import { EngineRepository } from '../src/modules/sessions/engine.repository';
import { SandboxExecutorService } from '../src/modules/sandbox/sandbox-executor';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { HealthController } from '../src/health/health.controller';
import { SandboxWorker } from '../src/modules/sandbox/sandbox-worker';

const runtimeTests = process.env.RUN_SANDBOX_RUNTIME_TESTS === '1' ? describe : describe.skip;
runtimeTests('real SQL image, Kubernetes isolation and query boundaries', () => {
  const harness = new SandboxHarness();
  const driver = new KubernetesDriver({ runtimeClass: 'runc', kubeContext: 'kind-skillbreak-local',
    imageAllowlist: ['localhost:5001/room1-sql'] });
  let first: ProvisionJob;
  let second: ProvisionJob;
  beforeAll(() => {
    harness.requireLocalRuntime();
    const imageDigest = process.env.SANDBOX_SQL_IMAGE
      ?? readFileSync(resolve(__dirname, '../../../.local/sql-sandbox-image-ref'), 'utf8').trim();
    const make = (): ProvisionJob => ({ ...sandboxIdentity(randomUUID(), 'idan-db', 1), operation: 'provision',
      jobId: randomUUID(), imageDigest, seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2' });
    first = make();
    second = make();
  });

  runtimeTests('complete engine with real SQL pods and disposable persistence', () => {
    const harness = new SandboxHarness();
    let app: INestApplication;
    let engine: EngineService;
    let repository: EngineRepository;
    let driver: KubernetesDriver;
    let duplicate: Extract<PlayerCommand, { type: 'SubmitInput' }>;
    let first: Extract<PlayerCommand, { type: 'StartSession' }>;
    let second: Extract<PlayerCommand, { type: 'StartSession' }>;
    let retained: unknown;

    async function boot() {
      app = await createEngineApp({ database: harness.database!, config: { ...harness.config,
        runtimeClass: 'runc', sandbox: { enabled: true, kubeContext: 'kind-skillbreak-local',
          imageAllowlist: ['localhost:5001/room1-sql'], workerConcurrency: 2 } } });
      engine = app.get(EngineService);
      repository = app.get(EngineRepository);
      driver = app.get(KubernetesDriver);
      const ensure = driver.ensure.bind(driver);
      jest.spyOn(driver, 'ensure').mockImplementation(async (job, runId) => {
        const pod = await ensure(job, runId ?? harness.runId);
        if (!runId) harness.ownPod(job.podName);
        return pod;
      });
    }

    async function waitFor(check: () => Promise<boolean>, milliseconds = 15000) {
      const deadline = Date.now() + milliseconds;
      while (!await check()) {
        if (Date.now() >= deadline) throw new Error('Actual engine runtime condition did not converge');
        await delay(50);
      }
    }

    const load = (id: string) => repository.load(harness.database!.manager, id);
    function input(session: typeof first, puzzleKey: string, value: PuzzleInput): Extract<PlayerCommand, { type: 'SubmitInput' }> {
      return { type: 'SubmitInput', messageId: randomUUID(), sessionId: session.sessionId,
        payload: { userId: session.payload.userId, puzzleKey, input: value } };
    }
    async function start() {
      const message: typeof first = { type: 'StartSession', messageId: randomUUID(), sessionId: randomUUID(),
        payload: { userId: randomUUID(), scriptSlug: 'escape-room' } };
      const started = Date.now();
      await engine.handle(message);
      await waitFor(async () => (await load(message.sessionId))!.puzzles.find(p => p.key === 'idan-db')!.sandbox.status === 'ready', 60000);
      expect(Date.now() - started).toBeLessThan(60000);
      return message;
    }

    beforeAll(async () => {
      harness.requireLocalRuntime();
      await harness.start();
      await new CatalogRepository(harness.database!).seed();
      const image = process.env.SANDBOX_SQL_IMAGE
        ?? readFileSync(resolve(__dirname, '../../../.local/sql-sandbox-image-ref'), 'utf8').trim();
      await publishSqlRoom1(harness.database!, image, new KubernetesDriver({ runtimeClass: 'runc',
        kubeContext: 'kind-skillbreak-local', imageAllowlist: ['localhost:5001/room1-sql'] }));
      await boot();
      first = await start();
      second = await start();
    }, 180000);
    afterAll(async () => { try { await app?.close(); } finally { await harness.close(); } }, 90000);

    test('ten concurrent submissions admit one actual remote query, with ten exact replays across engine restart', async () => {
      duplicate = input(first, 'idan-db', { kind: 'command', command: 'SELECT 1 AS v' });
      const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => engine.handle(duplicate)));
      expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: expect.stringMatching(/^(busy|inProgress)$/) });
      }
      const fingerprint = createHash('sha256').update(duplicate.messageId).update('\0').update('SELECT 1 AS v').digest('hex');
      const pod = sandboxIdentity(first.sessionId, 'idan-db', 1).podName;
      expect(harness.executionCount(pod, fingerprint)).toBe(1);
      retained = await harness.database!.query('SELECT * FROM sandbox_executions WHERE command_id=$1', [duplicate.messageId]);
      await app.close();
      await boot();
      for (let replay = 0; replay < 10; replay++) await engine.handle(duplicate);
      expect(await harness.database!.query('SELECT * FROM sandbox_executions WHERE command_id=$1', [duplicate.messageId])).toEqual(retained);
      expect(harness.executionCount(pod, fingerprint)).toBe(1);
      const executor = app.get(SandboxExecutorService);
      await expect(executor.execute({ ...sandboxIdentity(first.sessionId, 'idan-db', 1),
        commandId: duplicate.messageId, command: 'SELECT 1 AS v ' })).rejects.toMatchObject({ code: 'commandConflict' });
      await expect(executor.execute({ ...sandboxIdentity(second.sessionId, 'idan-db', 1),
        commandId: duplicate.messageId, command: 'SELECT 1 AS v' })).rejects.toMatchObject({ code: 'commandConflict' });
    }, 90000);

    test('rejects empty/comment/multiple statements and stale identity without admission while accepting quoted subqueries', async () => {
      for (const command of ['', '-- comment ;', '/* comment ; */', 'SELECT 1; SELECT 2']) {
        const message = input(second, 'idan-db', { kind: 'command', command });
        await engine.handle(message);
        expect(await harness.database!.query('SELECT command_id FROM sandbox_executions WHERE command_id=$1',
          [message.messageId])).toEqual([]);
        expect((await load(second.sessionId))!.puzzles.find(puzzle => puzzle.key === 'idan-db')!.latestResult)
          .toMatchObject({ verdict: 'rejected', reason: 'policyBlocked' });
      }
      const stale = { ...sandboxIdentity(second.sessionId, 'idan-db', 2), commandId: randomUUID(), command: 'SELECT 1' };
      await expect(app.get(SandboxExecutorService).execute(stale)).rejects.toMatchObject({ code: 'staleGeneration' });
      expect(await harness.database!.query('SELECT command_id FROM sandbox_executions WHERE command_id=$1',
        [stale.commandId])).toEqual([]);
      const valid = input(second, 'idan-db', { kind: 'command', command: "SELECT v FROM (SELECT ';' AS v) q /* ; */; -- ;" });
      await engine.handle(valid);
      const [saved] = await harness.database!.query('SELECT status,stdout FROM sandbox_executions WHERE command_id=$1', [valid.messageId]);
      expect(saved.status).toBe('completed');
      expect(decodeSqlRows(saved.stdout)).toEqual([[';']]);
    }, 15000);

    test('busy does not consume identity or renew lease; another sandbox progresses and the original ID later succeeds', async () => {
      const slow = input(first, 'idan-db', { kind: 'command', command: 'SELECT pg_sleep(2)' });
      const active = engine.handle(slow);
      const next = input(first, 'idan-db', { kind: 'command', command: 'SELECT 2 AS v' });
      try {
        await waitFor(async () => (await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
          [slow.messageId]))[0]?.status === 'running');
        const pod = sandboxIdentity(first.sessionId, 'idan-db', 1).podName;
        const lease = await harness.database!.query('SELECT lease_expires_at FROM sandbox_instances WHERE sandbox_id=$1', [pod]);
        await expect(engine.handle(next)).rejects.toMatchObject({ code: 'busy' });
        expect(await harness.database!.query('SELECT command_id FROM sandbox_executions WHERE command_id=$1', [next.messageId])).toEqual([]);
        expect(await harness.database!.query('SELECT lease_expires_at FROM sandbox_instances WHERE sandbox_id=$1', [pod])).toEqual(lease);
        const started = Date.now();
        await engine.handle(input(second, 'idan-db', { kind: 'command', command: 'SELECT 3 AS v' }));
        expect(Date.now() - started).toBeLessThan(1500);
      } finally { await active; }
      await engine.handle(next);
      expect(await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
        [next.messageId])).toEqual([{ status: 'completed' }]);
    }, 15000);

    test('a lost execution reply is not redispatched; cancellation or owned absence proves quiescence', async () => {
      const isolated = await start();
      const identity = sandboxIdentity(isolated.sessionId, 'idan-db', 1);
      const message = input(isolated, 'idan-db', { kind: 'command', command: 'SELECT pg_sleep(30)' });
      const helper = driver.helper.bind(driver);
      const remote: Promise<PromiseSettledResult<unknown>>[] = [];
      const fingerprint = createHash('sha256').update(message.messageId).update('\0').update('SELECT pg_sleep(30)').digest('hex');
      const interception = jest.spyOn(driver, 'helper').mockImplementation(async (job, uid, mode, payload, timeout) => {
        if (mode === 'query' && payload?.commandId === message.messageId) {
          remote.push(helper(job, uid, mode, payload, timeout).then(
            value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason })));
          await delay(200);
          expect(harness.executionCount(identity.podName, fingerprint)).toBe(1);
          throw new SandboxExecutionError('runtimeUnavailable');
        }
        return helper(job, uid, mode, payload, timeout);
      });
      try {
        await engine.handle(message);
        await Promise.all(remote);
        expect(await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
          [message.messageId])).toEqual([{ status: 'interrupted' }]);
        await engine.handle(message);
        expect(remote).toHaveLength(1);
      } finally { interception.mockRestore(); }
      const [instance] = await harness.database!.query('SELECT status FROM sandbox_instances WHERE sandbox_id=$1', [identity.podName]);
      if (instance.status === 'destroyed') expect(await driver.confirmAbsent(identity)).toBe(true);
      else {
        expect(harness.executionCount(identity.podName, fingerprint)).toBe(1);
        const next = input(isolated, 'idan-db', { kind: 'command', command: 'SELECT 4 AS v' });
        await engine.handle(next);
        expect(await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
          [next.messageId])).toEqual([{ status: 'completed' }]);
      }
    }, 15000);

    test('plays the actual SQL clue through hash and login into the non-final second room', async () => {
      await engine.handle(input(first, 'idan-db', { kind: 'command',
        command: "SELECT e.username,l.password_hash FROM employees e JOIN logs l ON l.employee_id=e.id WHERE l.event='auth'" }));
      await engine.handle(input(first, 'hash-cracker', { kind: 'answer', answer: ROOM1.danaPasswordSha256 }));
      await engine.handle(input(first, 'dana-login', { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword }));
      expect(await load(first.sessionId)).toMatchObject({ roomKey: 'room-2', status: 'Active',
        visitedRooms: ['room-1', 'room-2'], scriptVersion: 2 });
    }, 15000);

    test('observed expiry destroys only the owned pod while preserving terminal execution replay', async () => {
      const identity = sandboxIdentity(second.sessionId, 'idan-db', 1);
      const replay = input(second, 'idan-db', { kind: 'command', command: 'SELECT 5 AS v' });
      await engine.handle(replay);
      const [before] = await harness.database!.query('SELECT * FROM sandbox_executions WHERE command_id=$1', [replay.messageId]);
      await harness.database!.query('UPDATE sandbox_instances SET lease_expires_at=created_at WHERE sandbox_id=$1', [identity.podName]);
      await engine.handle(input(second, 'idan-db', { kind: 'command', command: 'SELECT 6 AS v' }));
      await waitFor(async () => (await harness.database!.query('SELECT status FROM sandbox_instances WHERE sandbox_id=$1',
        [identity.podName]))[0]?.status === 'destroyed');
      expect(await driver.confirmAbsent(identity)).toBe(true);
      expect(await app.get(SandboxExecutorService).execute({ ...identity, commandId: replay.messageId, command: 'SELECT 5 AS v' }))
        .toEqual({ commandId: replay.messageId, stdout: before.stdout, stderr: before.stderr, exitCode: before.exit_code,
          timedOut: before.timed_out, truncated: before.truncated });
    }, 20000);

    test('concurrent execution/destruction, unavailable deletion and repeated absent destruction preserve exact cleanup obligations', async () => {
      const isolated = await start();
      const identity = sandboxIdentity(isolated.sessionId, 'idan-db', 1);
      const slow = input(isolated, 'idan-db', { kind: 'command', command: 'SELECT pg_sleep(1)' });
      const running = engine.handle(slow);
      const remove = driver.remove.bind(driver);
      let unavailable = true;
      const interception = jest.spyOn(driver, 'remove').mockImplementation(async (job, uid) => {
        if (unavailable) throw new SandboxExecutionError('runtimeUnavailable');
        await remove(job, uid);
      });
      try {
        await waitFor(async () => (await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
          [slow.messageId]))[0]?.status === 'running');
        await engine.handle({ type: 'AbandonSession', messageId: randomUUID(), sessionId: isolated.sessionId,
          payload: { userId: isolated.payload.userId } });
        const rejected = { ...identity, commandId: randomUUID(), command: 'SELECT 1' };
        await expect(app.get(SandboxExecutorService).execute(rejected)).rejects.toMatchObject({ code: 'busy' });
        await running;
        await expect(app.get(SandboxExecutorService).execute(rejected)).rejects.toMatchObject({ code: 'notReady' });
        expect(await harness.database!.query('SELECT command_id FROM sandbox_executions WHERE command_id=$1',
          [rejected.commandId])).toEqual([]);
        await waitFor(async () => (await harness.database!.query(`SELECT status FROM engine_sandbox_requests
          WHERE session_id=$1 AND request->>'operation'='destroy' AND last_error_code='runtimeUnavailable'`,
        [isolated.sessionId]))[0]?.status === 'pending');
        expect(await driver.read({ ...identity, jobId: randomUUID(), operation: 'provision',
          imageDigest: (await harness.database!.query('SELECT image_digest FROM sandbox_instances WHERE sandbox_id=$1',
            [identity.podName]))[0].image_digest, policyRef: 'idan-db-sql@2', seedRef: 'room1-sql-v1' })).not.toBeNull();
        expect(await harness.database!.query(`SELECT o.kind FROM sandbox_outcomes o JOIN engine_sandbox_requests j USING(job_id)
          WHERE j.session_id=$1 AND o.kind='destroyed'`, [isolated.sessionId])).toEqual([]);
        unavailable = false;
        await waitFor(async () => (await harness.database!.query('SELECT status FROM sandbox_instances WHERE sandbox_id=$1',
          [identity.podName]))[0]?.status === 'destroyed');
        expect(await driver.confirmAbsent(identity)).toBe(true);
        const repeated = { ...identity, operation: 'destroy', jobId: randomUUID() };
        await harness.database!.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
          [repeated.jobId, repeated.sessionId, repeated]);
        await waitFor(async () => (await harness.database!.query('SELECT status FROM engine_sandbox_requests WHERE job_id=$1',
          [repeated.jobId]))[0]?.status === 'completed');
        expect(await driver.confirmAbsent(identity)).toBe(true);
      } finally { unavailable = false; interception.mockRestore(); await running; }
    }, 30000);

    test('runtime loss makes health unavailable until the actual enforcement preflight is reverified', async () => {
      expect(await app.get(HealthController).check()).toMatchObject({ status: 'ok', sandboxWorker: 'ready',
        schemas: { sandbox: 'present' }, sandboxRuntime: { developmentOnly: true } });
      const interception = jest.spyOn(driver, 'checkAvailable').mockRejectedValueOnce(new SandboxExecutionError('runtimeUnavailable'));
      try { await expect(app.get(HealthController).check()).rejects.toMatchObject({ status: 503 }); }
      finally { interception.mockRestore(); }
      const preflight = jest.spyOn(driver, 'preflight');
      try {
        await waitFor(async () => app.get(SandboxWorker).status === 'ready', 30000);
        expect(preflight).toHaveBeenCalledTimes(1);
      } finally { preflight.mockRestore(); }
      expect(await app.get(HealthController).check()).toMatchObject({ status: 'ok', sandboxWorker: 'ready' });
    }, 40000);

    test('loss of the owned database lock never permits overlap or redispatch and recovers after engine restart', async () => {
      const isolated = await start();
      const identity = sandboxIdentity(isolated.sessionId, 'idan-db', 1);
      const message = input(isolated, 'idan-db', { kind: 'command', command: 'SELECT pg_sleep(2)' });
      const fingerprint = createHash('sha256').update(message.messageId).update('\0').update('SELECT pg_sleep(2)').digest('hex');
      const running = engine.handle(message);
      try {
        await waitFor(async () => (await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
          [message.messageId]))[0]?.status === 'running');
        await delay(250);
        expect(harness.executionCount(identity.podName, fingerprint)).toBe(1);
        const locks: { pid: number }[] = await harness.database!.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted");
        expect(locks).toHaveLength(1);
        await harness.database!.query('SELECT pg_terminate_backend($1)', [locks[0].pid]);
      } finally { await running; }
      await app.close();
      await boot();
      await waitFor(async () => (await harness.database!.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
        [message.messageId]))[0]?.status === 'interrupted');
      await expect(app.get(SandboxExecutorService).execute({ ...identity, commandId: message.messageId,
        command: 'SELECT pg_sleep(2)' })).rejects.toMatchObject({ code: 'interrupted' });
      const [instance] = await harness.database!.query('SELECT status FROM sandbox_instances WHERE sandbox_id=$1', [identity.podName]);
      if (instance.status === 'destroyed') expect(await driver.confirmAbsent(identity)).toBe(true);
      else expect(harness.executionCount(identity.podName, fingerprint)).toBe(1);
    }, 60000);

    test('restarts after real create/seed with the original UID and deadline, then rejects the delayed stale ready outcome', async () => {
      const message: typeof first = { type: 'StartSession', messageId: randomUUID(), sessionId: randomUUID(),
        payload: { userId: randomUUID(), scriptSlug: 'escape-room' } };
      let seeded = false;
      const helper = driver.helper.bind(driver);
      const interrupted = jest.spyOn(driver, 'helper').mockImplementation(async (job, uid, mode, payload, timeout) => {
        const value = await helper(job, uid, mode, payload, timeout);
        if (job.sessionId === message.sessionId && mode === 'status' && payload?.probeSeed) {
          seeded = value !== null && typeof value === 'object' && Reflect.get(value, 'seeded') === true;
          throw new SandboxExecutionError('runtimeUnavailable');
        }
        return value;
      });
      const claimed = async () => {
        const [row]: { first_attempt_at: Date; deadline_at: Date; readiness_checks: number; pod_uid: string }[] =
          await harness.database!.query(`SELECT j.first_attempt_at,j.deadline_at,j.readiness_checks,i.pod_uid
            FROM engine_sandbox_requests j JOIN sandbox_instances i ON i.sandbox_id=j.request->>'podName'
            WHERE j.session_id=$1 AND j.request->>'operation'='provision'`, [message.sessionId]);
        return row;
      };
      let original: Awaited<ReturnType<typeof claimed>>;
      try {
        await engine.handle(message);
        await waitFor(async () => seeded, 20000);
        await app.get(SandboxWorker).stop();
        const unready = { ...sandboxIdentity(message.sessionId, 'idan-db', 1), commandId: randomUUID(), command: 'SELECT 1' };
        await expect(app.get(SandboxExecutorService).execute(unready)).rejects.toMatchObject({ code: 'notReady' });
        expect(await harness.database!.query('SELECT command_id FROM sandbox_executions WHERE command_id=$1',
          [unready.commandId])).toEqual([]);
        await app.close();
        original = await claimed();
        expect(original.readiness_checks).toBe(0);
      } finally { interrupted.mockRestore(); }
      await boot();
      const record = engine.record.bind(engine);
      const blocked = jest.spyOn(engine, 'record').mockImplementation(async outcome => {
        if (outcome.sessionId === message.sessionId) throw new Error('injected outcome transport loss');
        await record(outcome);
      });
      try {
        await waitFor(async () => (await harness.database!.query(`SELECT attempt_count FROM sandbox_outcomes
          WHERE payload->>'sessionId'=$1 AND kind='ready'`, [message.sessionId]))[0]?.attempt_count > 0);
        expect(await claimed()).toEqual({ ...original, readiness_checks: 1 });
        expect(Date.now()).toBeLessThan(original.deadline_at.getTime());
        expect(driver.ensure).not.toHaveBeenCalled();
        const [stored]: { payload: SandboxOutcome }[] = await harness.database!.query(
          "SELECT payload FROM sandbox_outcomes WHERE payload->>'sessionId'=$1 AND kind='ready'", [message.sessionId]);
        await harness.database!.transaction(async manager => {
          await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [message.sessionId]);
          const current = (await repository.load(manager, message.sessionId))!;
          const next = structuredClone(current);
          next.version++;
          next.puzzles.find(puzzle => puzzle.key === 'idan-db')!.sandbox.generation++;
          await repository.save(manager, next, current.version, new Date());
        });
        const newer = await load(message.sessionId);
        blocked.mockRestore();
        await engine.record(stored.payload);
        await engine.record(stored.payload);
        expect(await load(message.sessionId)).toEqual(newer);
        expect((await load(message.sessionId))!.puzzles.find(puzzle => puzzle.key === 'idan-db')!.sandbox)
          .toMatchObject({ generation: 2, status: 'provisioning' });
        expect((await claimed()).pod_uid).toBe(original.pod_uid);
      } finally { blocked.mockRestore(); }
    }, 60000);
  });
  afterAll(() => harness.close(), 90000);

  test('loads the official Kubernetes ESM client without a CommonJS fallback', async () => {
    const client = await import('@kubernetes/client-node');
    expect(typeof client.KubeConfig).toBe('function');
  });

  test('proves network denial against reachable controls and actual cgroup/storage/security limits', async () => {
    const report = await driver.preflight(first.imageDigest);
    expect(report).toMatchObject({ verified: true, developmentOnly: true, pids: 64, outputLimit: 65536 });
  }, 90000);

  test('creates two distinct owned pods and verifies real read-only fixture readiness within sixty seconds', async () => {
    for (const job of [first, second]) {
      const deadline = Date.now() + 60000;
      const pod = await driver.ensure(job, harness.runId);
      harness.ownPod(job.podName);
      const uid = pod.metadata!.uid!;
      let running = pod.status?.phase === 'Running';
      while (!running) {
        if (Date.now() >= deadline) throw new Error('Real sandbox startup exceeded sixty seconds');
        const current = await driver.read(job, uid);
        if (!current || ['Failed', 'Succeeded'].includes(current.status?.phase ?? '')) {
          throw new Error('Real sandbox failed before readiness');
        }
        running = current.status?.phase === 'Running';
        if (!running) await delay(200);
      }
      let ready: unknown;
      for (let probe = 0; probe < 3; probe++) {
        try { ready = await driver.helper(job, uid, 'ready'); break; }
        catch (error) {
          if (probe === 2 || Date.now() >= deadline) throw error;
          await delay(1000);
        }
      }
      expect(Date.now()).toBeLessThan(deadline);
      expect(ready).toEqual({ version: 1, ready: true, seedRef: 'room1-sql-v1' });
      expect((await driver.ensure(job, harness.runId)).metadata!.uid).toBe(uid);
    }
    expect(first.podName).not.toBe(second.podName);
  }, 130000);

  async function query(command: string) {
    const pod = await driver.read(first);
    if (!pod?.metadata?.uid) throw new Error('Owned SQL fixture pod missing');
    const commandId = randomUUID();
    const value = await driver.helper(first, pod.metadata.uid, 'query',
      { executionToken: randomUUID(), commandId, command }, 6000);
    return validateHelperResult(value, commandId);
  }

  test('returns the real join clue and positional escaped null/empty/literal/Unicode cells', async () => {
    const clue = await query(`SELECT e.username,l.password_hash FROM employees e
      JOIN logs l ON l.employee_id=e.id WHERE l.event='auth'`);
    expect(clue).toMatchObject({ exitCode: 0, timedOut: false, truncated: false, stderr: '' });
    expect(decodeSqlRows(clue.stdout)).toEqual([[ROOM1.danaUsername, ROOM1.danaPasswordSha256]]);
    const cells = await query(`SELECT NULL::text AS x,''::text AS x,E'\\\\N' AS x,
      E'a\\tb\\nc\\rd\\\\e' AS x,'é😀' AS x`);
    expect(decodeSqlRows(cells.stdout)).toEqual([[null, '', '\\N', 'a\tb\nc\rd\\e', 'é😀']]);
    expect(decodeSqlRows((await query("SELECT v FROM (SELECT ';' AS v) q /* ; */; -- ;")).stdout)).toEqual([[';']]);
  }, 20000);

  test('wrong UIDs and conflicting pinned ownership cannot delete or adopt the real owned pod', async () => {
    const pod = await driver.read(first);
    const uid = pod!.metadata!.uid!;
    await expect(driver.remove(first, randomUUID())).rejects.toMatchObject({ code: 'ownershipConflict' });
    await expect(driver.ensure({ ...first, policyRef: 'idan-db-sql@3' })).rejects.toMatchObject({ code: 'ownershipConflict' });
    expect((await driver.read(first, uid))!.metadata!.uid).toBe(uid);
  });

  test('database permissions independently reject writes, DDL, temp, elevation and dangerous reads without changing the fixture', async () => {
    for (const command of [
      "UPDATE employees SET username='changed'", 'DELETE FROM employees', 'DROP TABLE logs',
      'CREATE TABLE nope(id int)', 'CREATE TEMP TABLE nope(id int)', 'SET ROLE sandbox_owner',
      "SELECT pg_read_file('/etc/passwd')", 'SELECT 1; SELECT 2',
    ]) {
      expect(await query(command)).toMatchObject({ exitCode: 1, timedOut: false, truncated: false });
    }
    expect(decodeSqlRows((await query("SELECT username FROM employees WHERE id=1")).stdout)).toEqual([[ROOM1.danaUsername]]);
  }, 30000);

  test.each([65535, 65536, 65537])('enforces exact combined UTF-8 output at %i bytes without a partial first row', async bytes => {
    const length = bytes - 3;
    const response = await query(`SELECT repeat('é',${Math.floor(length / 2)}) || '${length % 2 ? 'x' : ''}' AS v`);
    const size = Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr);
    expect(size).toBeLessThanOrEqual(65536);
    expect(response.truncated).toBe(bytes > 65536);
    if (bytes <= 65536) {
      expect(size).toBe(bytes);
      expect(decodeSqlRows(response.stdout)).toHaveLength(1);
    } else {
      expect(response.stdout).toBe('v\n');
      expect(decodeSqlRows(response.stdout)).toEqual([]);
    }
  }, 15000);

  test('stops within six seconds even after SQL disables statement_timeout, then accepts a fresh query', async () => {
    const started = Date.now();
    const response = await query("SELECT pg_sleep(30) FROM set_config('statement_timeout','0',false)");
    expect(Date.now() - started).toBeLessThanOrEqual(6000);
    expect(response).toMatchObject({ exitCode: null, timedOut: true, truncated: false });
    expect(decodeSqlRows((await query('SELECT 1 AS v')).stdout)).toEqual([['1']]);
  }, 15000);
});
