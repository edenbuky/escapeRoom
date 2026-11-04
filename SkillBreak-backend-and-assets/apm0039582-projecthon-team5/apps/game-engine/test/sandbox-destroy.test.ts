import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { KubernetesDriver, sqlPod } from '../src/modules/sandbox/kubernetes-driver';
import type { ExecRequest, ProvisionJob, SandboxOutcomeSink } from '../src/modules/sandbox/sandbox.contracts';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { SandboxRepository } from '../src/modules/sandbox/sandbox.repository';
import { SandboxExecutorService } from '../src/modules/sandbox/sandbox-executor';
import { SandboxWorker } from '../src/modules/sandbox/sandbox-worker';
import { SandboxHarness } from './helpers/sandbox-harness';

const databaseTests = process.env.RUN_SANDBOX_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('irreversible destroy, expiry and drain', () => {
  const harness = new SandboxHarness();
  const image = `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`;
  let database: DataSource;
  let repository: SandboxRepository;
  let driver: KubernetesDriver;
  let worker: SandboxWorker;
  let executor: SandboxExecutorService;
  let sink: SandboxOutcomeSink;
  let provision: ProvisionJob;
  let request: ExecRequest;
  beforeAll(async () => {
    await harness.start();
    database = harness.database!;
    await database.query(`INSERT INTO catalog.component_templates(key,version,family,engine,definition,status)
      VALUES ('idan-db-sql',2,'sandbox','sql',$1,'published')`,
    [{ imageDigest: image, seedRef: 'room1-sql-v1', policy: { maxQueryChars: 4096 } }]);
  }, 90000);
  afterAll(() => harness.close(), 90000);
  beforeEach(async () => {
    await database.query("UPDATE engine_sandbox_requests SET status='superseded' WHERE status IN ('pending','running','waiting_cleanup')");
    repository = new SandboxRepository(database);
    driver = new KubernetesDriver({ runtimeClass: 'runc', imageAllowlist: ['localhost:5001/room1-sql'] });
    jest.spyOn(driver, 'preflight').mockResolvedValue({ verified: true, developmentOnly: true, pids: 64, outputLimit: 65536 });
    jest.spyOn(driver, 'confirmAbsent').mockResolvedValue(true);
    jest.spyOn(driver, 'read').mockImplementation(async job => ({
      ...sqlPod(job, 'runc'), metadata: { ...sqlPod(job, 'runc').metadata, uid: job.podName }, status: { phase: 'Running' },
    }));
    jest.spyOn(driver, 'ensure').mockImplementation(job => driver.read(job).then(pod => pod!));
    jest.spyOn(driver, 'remove').mockResolvedValue();
    jest.spyOn(driver, 'helper').mockImplementation(async (_job, _uid, mode, input) => {
      if (mode === 'query') return { version: 1, commandId: input?.commandId, stdout: 'v\n1\n',
        stderr: '', exitCode: 0, timedOut: false, truncated: false };
      if (mode === 'status' && input?.probeSeed) return { version: 1, seeded: true, seedRef: 'room1-sql-v1' };
      if (mode === 'ready') return { version: 1, ready: true, seedRef: 'room1-sql-v1' };
      return { version: 1, executionToken: input?.executionToken, quiesced: true };
    });
    const identity = sandboxIdentity(randomUUID(), 'idan-db', 1);
    provision = { ...identity, jobId: randomUUID(), operation: 'provision', imageDigest: image,
      seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2' };
    request = { ...identity, commandId: randomUUID(), command: 'SELECT 1 AS v' };
    await database.query(`INSERT INTO sessions VALUES ($1,$2,'escape-room',2,1,$3,now())`,
      [identity.sessionId, randomUUID(), { status: 'Active', visitedRooms: ['r1'],
        deadlineAt: new Date(Date.now() + 900000).toISOString() }]);
    await database.query('INSERT INTO session_puzzles VALUES ($1,$2,$3)', [identity.sessionId, identity.puzzleKey,
      { key: 'idan-db', family: 'sql', status: 'open', roomKey: 'r1', templateRef: 'idan-db-sql@2',
        sandbox: { generation: 1, status: 'ready' } }]);
    await repository.createInstance(database.manager, { ...identity, templateRef: provision.policyRef,
      imageDigest: image, seedRef: 'room1-sql-v1', policyRef: provision.policyRef });
    await database.query("UPDATE sandbox_instances SET status='ready',pod_uid=$1 WHERE sandbox_id=$1", [identity.podName]);
    await database.query(`INSERT INTO engine_sandbox_requests(job_id,session_id,request,status)
      VALUES ($1,$2,$3,'completed')`, [provision.jobId, provision.sessionId, provision]);
    worker = new SandboxWorker(database, repository, driver, 2);
    executor = new SandboxExecutorService(database, repository, driver, () => true);
    sink = { record: jest.fn().mockResolvedValue(undefined) };
    await worker.initialize(image);
  });
  afterEach(async () => { await executor?.stop(); await worker?.stop(); await repository?.close(); });

  async function destroy() {
    const job = { ...sandboxIdentity(request.sessionId, request.puzzleKey, request.generation),
      jobId: randomUUID(), operation: 'destroy' };
    await database.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
      [job.jobId, job.sessionId, job]);
    return job;
  }

  test('committed destruction blocks fresh commands, persists intent before deletion, and only stages confirmed success', async () => {
    const job = await destroy();
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'notReady' });
    jest.mocked(driver.remove).mockImplementationOnce(async () => {
      expect(await database.query('SELECT desired_state,status FROM sandbox_instances WHERE sandbox_id=$1',
        [request.podName])).toEqual([{ desired_state: 'destroyed', status: 'destroying' }]);
      expect(await database.query("SELECT kind FROM sandbox_outcomes WHERE job_id=$1 AND kind='destroyed'", [job.jobId])).toEqual([]);
    });
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.jobId, kind: 'destroyed' }));
    await expect(database.query("UPDATE sandbox_instances SET desired_state='ready' WHERE sandbox_id=$1",
      [request.podName])).rejects.toThrow();
  });

  test('API/ownership failure preserves cleanup, never deletes a mismatched UID, and retries without abandonment', async () => {
    const job = await destroy();
    jest.mocked(driver.read).mockRejectedValueOnce(new SandboxExecutionError('ownershipConflict'));
    await worker.runOnce(sink);
    expect(driver.remove).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 6; attempt++) {
      jest.mocked(driver.remove).mockRejectedValueOnce(new SandboxExecutionError('runtimeUnavailable'));
      await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [job.jobId]);
      await worker.runOnce(sink);
    }
    expect(await database.query('SELECT status,attempt_count FROM engine_sandbox_requests WHERE job_id=$1',
      [job.jobId])).toEqual([{ status: 'pending', attempt_count: 7 }]);
    expect(sink.record).not.toHaveBeenCalled();
    await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [job.jobId]);
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'destroyed' }));
  });

  test('already absent resources complete idempotently without inventing an owned UID', async () => {
    jest.mocked(driver.read).mockResolvedValue(null);
    await destroy();
    await worker.runOnce(sink);
    await destroy();
    await worker.runOnce(sink);
    expect(driver.remove).not.toHaveBeenCalled();
    expect(jest.mocked(sink.record).mock.calls.filter(([outcome]) => outcome.kind === 'destroyed')).toHaveLength(2);
  });

  test('destroy waits for accepted work to quiesce rather than clearing its active marker', async () => {
    await database.transaction(async manager => {
      await manager.query(`INSERT INTO sandbox_executions(command_id,sandbox_id,input_hash,execution_token)
        VALUES ($1,$2,encode(sha256(convert_to($3,'UTF8')),'hex'),$4)`,
      [request.commandId, request.podName, request.command, randomUUID()]);
      await manager.query('UPDATE sandbox_instances SET active_command_id=$2 WHERE sandbox_id=$1',
        [request.podName, request.commandId]);
    });
    const job = await destroy();
    await worker.runOnce(sink);
    expect(driver.remove).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
    await executor.recover();
    await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [job.jobId]);
    jest.mocked(driver.remove).mockImplementationOnce(async () => {
      expect(await database.query('SELECT status FROM sandbox_executions WHERE command_id=$1',
        [request.commandId])).toEqual([{ status: 'interrupted' }]);
    });
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'destroyed' }));
  });

  test('destroy committed during readiness supersedes the late provision result', async () => {
    await database.query("UPDATE sandbox_instances SET status='provisioning' WHERE sandbox_id=$1", [request.podName]);
    await database.query("UPDATE engine_sandbox_requests SET status='pending' WHERE job_id=$1", [provision.jobId]);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const checking = new Promise<void>(resolve => { started = resolve; });
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode) => {
      if (mode === 'status') return { version: 1, seeded: true, seedRef: 'room1-sql-v1' };
      started(); await waiting;
      return { version: 1, ready: true, seedRef: 'room1-sql-v1' };
    });
    const pending = worker.runOnce(sink);
    await checking;
    try { await destroy(); } finally { release(); await pending; }
    expect(sink.record).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'destroyed' }));
    expect(await database.query('SELECT status FROM engine_sandbox_requests WHERE job_id=$1',
      [provision.jobId])).toEqual([{ status: 'superseded' }]);
  });

  test('the original two-hour boundary is expired and an admitted near-boundary lease is capped', async () => {
    for (const [generation, age, lifetime, idle] of [[2, 120, 0, 0], [3, 115, 5, 1]]) {
      const identity = sandboxIdentity(request.sessionId, request.puzzleKey, generation);
      await database.query(`UPDATE session_puzzles SET state=jsonb_set(state,'{sandbox,generation}',$2::jsonb)
        WHERE session_id=$1`, [request.sessionId, String(generation)]);
      await database.query(`INSERT INTO sandbox_instances(sandbox_id,session_id,puzzle_key,generation,namespace,pod_name,
        pod_uid,template_ref,image_digest,seed_ref,policy_ref,status,created_at,max_expires_at,lease_expires_at)
        VALUES ($1,$2,$3,$4,$5,$1,$1,'idan-db-sql@2',$6,'room1-sql-v1','idan-db-sql@2','ready',
          now()-make_interval(mins=>$7),now()+make_interval(mins=>$8),now()+make_interval(mins=>$9))`,
      [identity.podName, identity.sessionId, identity.puzzleKey, generation, identity.namespace, image, age, lifetime, idle]);
      const command = { ...identity, commandId: randomUUID(), command: request.command };
      if (lifetime === 0) {
        await expect(executor.execute(command)).rejects.toMatchObject({ code: 'expired' });
        await expect(executor.execute(command)).rejects.toMatchObject({ code: 'expired' });
        expect(await database.query(`SELECT count(*)::int AS count FROM engine_sandbox_requests WHERE
          session_id=$1 AND request->>'generation'='2' AND request->>'operation'='destroy'`, [request.sessionId]))
          .toEqual([{ count: 1 }]);
      } else {
        await executor.execute(command);
        const [row] = await database.query('SELECT lease_expires_at,max_expires_at FROM sandbox_instances WHERE sandbox_id=$1',
          [identity.podName]);
        expect(row.lease_expires_at).toEqual(row.max_expires_at);
      }
    }
  });

  test('stop rejects new admission, drains owned execution, and leaves no session lock in the shared pool', async () => {
    let release!: () => void;
    let dispatch!: () => void;
    const started = new Promise<void>(resolve => { dispatch = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode, input) => {
      if (mode !== 'query') return { version: 1, executionToken: input?.executionToken, quiesced: true };
      dispatch(); await waiting;
      return { version: 1, commandId: input?.commandId, stdout: 'v\n1\n', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    });
    const pending = executor.execute(request);
    await started;
    const stopping = executor.stop();
    try {
      await expect(executor.execute({ ...request, commandId: randomUUID() })).rejects.toMatchObject({ code: 'runtimeUnavailable' });
    } finally { release(); await pending; await stopping; }
    expect(await database.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted")).toEqual([]);
  });
});
