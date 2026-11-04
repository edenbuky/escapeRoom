import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { KubernetesDriver, sqlPod } from '../src/modules/sandbox/kubernetes-driver';
import type { ProvisionJob, SandboxOutcomeSink } from '../src/modules/sandbox/sandbox.contracts';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { SandboxRepository } from '../src/modules/sandbox/sandbox.repository';
import { SandboxWorker } from '../src/modules/sandbox/sandbox-worker';
import { SandboxHarness } from './helpers/sandbox-harness';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';

const databaseTests = process.env.RUN_SANDBOX_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('durable sandbox provisioning worker', () => {
  const harness = new SandboxHarness();
  const image = `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`;
  let database: DataSource;
  let repository: SandboxRepository;
  let driver: KubernetesDriver;
  let worker: SandboxWorker;
  let sink: SandboxOutcomeSink;

  beforeAll(async () => {
    await harness.start();
    database = harness.database!;
    await new CatalogRepository(database).seed();
    await database.query(`INSERT INTO catalog.component_templates(key,version,family,engine,definition,status)
      VALUES ('idan-db-sql',2,'sandbox','sql',$1,'published')`, [{
      imageDigest: image, seedRef: 'room1-sql-v1', policy: { maxQueryChars: 4096 },
    }]);
  }, 90000);
  afterAll(() => harness.close(), 90000);
  beforeEach(async () => {
    await database.query("UPDATE engine_sandbox_requests SET status='superseded' WHERE status IN ('pending','running','waiting_cleanup')");
    await database.query("UPDATE sandbox_outcomes SET delivery_status='superseded' WHERE delivery_status='pending'");
    repository = new SandboxRepository(database);
    driver = new KubernetesDriver({ runtimeClass: 'runc', imageAllowlist: ['localhost:5001/room1-sql'] });
    jest.spyOn(driver, 'preflight').mockResolvedValue({
      verified: true, developmentOnly: true, pids: 64, outputLimit: 65536,
    });
    jest.spyOn(driver, 'ensure').mockImplementation(async job => ({
      ...sqlPod(job, 'runc'), metadata: { ...sqlPod(job, 'runc').metadata, uid: job.podName },
      status: { phase: 'Running' },
    }));
    jest.spyOn(driver, 'read').mockImplementation(async job => ({
      ...sqlPod(job, 'runc'), metadata: { ...sqlPod(job, 'runc').metadata, uid: job.podName },
      status: { phase: 'Running' },
    }));
    jest.spyOn(driver, 'remove').mockResolvedValue();
    jest.spyOn(driver, 'confirmAbsent').mockResolvedValue(true);
    jest.spyOn(driver, 'helper').mockImplementation(async (_job, _uid, mode) => mode === 'status'
      ? { version: 1, seeded: true, seedRef: 'room1-sql-v1' }
      : { version: 1, ready: true, seedRef: 'room1-sql-v1' });
    sink = { record: jest.fn().mockResolvedValue(undefined) };
    worker = new SandboxWorker(database, repository, driver, 2);
    await worker.initialize(image);
  });
  afterEach(async () => { await worker?.stop(); await repository?.close(); });

  async function job(overrides: Partial<ProvisionJob> = {}): Promise<ProvisionJob> {
    const identity = sandboxIdentity(randomUUID(), 'idan-db', 1);
    const request: ProvisionJob = { ...identity, jobId: randomUUID(), operation: 'provision',
      imageDigest: image, seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2', ...overrides };
    const puzzle = { key: 'idan-db', templateRef: request.policyRef, family: 'sql', status: 'open',
      sandbox: { generation: 1, status: 'provisioning' } };
    await database.query(`INSERT INTO sessions VALUES ($1,$2,'escape-room',2,1,$3,now())`,
      [identity.sessionId, randomUUID(), { status: 'Active' }]);
    await database.query('INSERT INTO session_puzzles VALUES ($1,$2,$3)',
      [identity.sessionId, identity.puzzleKey, puzzle]);
    await database.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
      [request.jobId, request.sessionId, request]);
    return request;
  }

  test('stages readiness durably and releases the sandbox lock before delivering', async () => {
    const request = await job();
    sink.record = jest.fn(async () => {
      const acquired = await repository.withLock(request, async () => true);
      expect(acquired).toEqual({ acquired: true, value: true });
      expect(await database.query('SELECT status,readiness_checks FROM engine_sandbox_requests WHERE job_id=$1',
        [request.jobId])).toEqual([{ status: 'completed', readiness_checks: 1 }]);
    });
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ jobId: request.jobId, kind: 'ready' }));
    expect(await database.query('SELECT status,pod_uid FROM sandbox_instances WHERE sandbox_id=$1',
      [request.podName])).toEqual([{ status: 'ready', pod_uid: request.podName }]);
    await worker.runOnce(sink);
    expect(driver.ensure).toHaveBeenCalledTimes(1);
    expect(sink.record).toHaveBeenCalledTimes(1);
  });

  test('supersedes immutable pending readiness when its generation changes before delivery', async () => {
    const request = await job();
    sink.record = jest.fn().mockRejectedValue(new Error('injected delivery loss'));
    await worker.runOnce(sink);
    const [before] = await database.query('SELECT payload FROM sandbox_outcomes WHERE job_id=$1', [request.jobId]);
    await database.query(`UPDATE session_puzzles SET state=jsonb_set(state,'{sandbox,generation}','2')
      WHERE session_id=$1 AND puzzle_key=$2`, [request.sessionId, request.puzzleKey]);
    await database.query('UPDATE sandbox_outcomes SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
    await worker.runOnce(sink);
    expect(await database.query('SELECT payload,delivery_status,attempt_count FROM sandbox_outcomes WHERE job_id=$1',
      [request.jobId])).toEqual([{ payload: before.payload, delivery_status: 'superseded', attempt_count: 1 }]);
    expect(sink.record).toHaveBeenCalledTimes(1);
  });

  test('claims one pod for concurrent workers using a nonblocking cross-process lock', async () => {
    await job();
    const otherRepository = new SandboxRepository(database);
    const other = new SandboxWorker(database, otherRepository, driver, 2);
    try {
      await other.initialize(image);
      await Promise.all([worker.runOnce(sink), other.runOnce(sink)]);
      expect(driver.ensure).toHaveBeenCalledTimes(1);
    } finally { await other.stop(); await otherRepository.close(); }
  });

  test('does not count startup polling as a post-seed readiness check', async () => {
    const request = await job();
    jest.mocked(driver.helper).mockResolvedValueOnce({ version: 1, seeded: false });
    await worker.runOnce(sink);
    expect(await database.query('SELECT status,readiness_checks,readiness_started_at FROM engine_sandbox_requests WHERE job_id=$1',
      [request.jobId])).toEqual([{ status: 'pending', readiness_checks: 0, readiness_started_at: null }]);
    expect(sink.record).not.toHaveBeenCalled();
  });

  test('persists three readiness checks without resetting the original deadline on worker restart', async () => {
    const request = await job();
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode) => {
      if (mode === 'status') return { version: 1, seeded: true, seedRef: 'room1-sql-v1' };
      throw new SandboxExecutionError('notReady');
    });
    await worker.runOnce(sink);
    const [first] = await database.query('SELECT first_attempt_at,deadline_at FROM engine_sandbox_requests WHERE job_id=$1',
      [request.jobId]);
    worker = new SandboxWorker(database, repository, driver, 2);
    await worker.initialize(image);
    for (let attempt = 0; attempt < 2; attempt++) {
      await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
      await worker.runOnce(sink);
    }
    expect(await database.query('SELECT first_attempt_at,deadline_at,readiness_checks,status FROM engine_sandbox_requests WHERE job_id=$1',
      [request.jobId])).toEqual([{ ...first, readiness_checks: 3, status: 'waiting_cleanup' }]);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ jobId: request.jobId, kind: 'failed',
      errorCode: 'readinessFailed' }));
  });

  test('never creates or reports ready after an original persisted sixty-second deadline', async () => {
    const request = await job();
    await database.query(`UPDATE engine_sandbox_requests SET first_attempt_at=now()-interval '61 seconds',
      deadline_at=now()-interval '1 second' WHERE job_id=$1`, [request.jobId]);
    await worker.runOnce(sink);
    expect(driver.ensure).not.toHaveBeenCalled();
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ jobId: request.jobId, kind: 'failed',
      errorCode: 'provisionTimeout' }));
  });

  test('retains failed cleanup as selectable work until owned absence is confirmed', async () => {
    const request = await job();
    jest.mocked(driver.ensure).mockRejectedValue(new SandboxExecutionError('templateMismatch'));
    await worker.runOnce(sink);
    jest.mocked(driver.read).mockResolvedValue({ metadata: { uid: request.podName } });
    jest.mocked(driver.remove).mockRejectedValueOnce(new SandboxExecutionError('runtimeUnavailable'));
    await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
    await worker.runOnce(sink);
    expect(await database.query('SELECT status,last_error_code FROM engine_sandbox_requests WHERE job_id=$1',
      [request.jobId])).toEqual([{ status: 'waiting_cleanup', last_error_code: 'runtimeUnavailable' }]);
    await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
    await worker.runOnce(sink);
    expect(await database.query('SELECT status FROM engine_sandbox_requests WHERE job_id=$1',
      [request.jobId])).toEqual([{ status: 'failed' }]);
    expect(driver.remove).toHaveBeenCalledWith(request, request.podName);
  });

  test('retries the same immutable outcome beyond five delivery failures', async () => {
    const request = await job();
    jest.mocked(sink.record).mockRejectedValue(new Error('sink unavailable'));
    for (let attempt = 0; attempt < 7; attempt++) {
      await database.query('UPDATE sandbox_outcomes SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
      await worker.runOnce(sink);
    }
    const payloads = jest.mocked(sink.record).mock.calls.map(([payload]) => payload);
    expect(payloads).toHaveLength(7);
    expect(payloads.every(payload => JSON.stringify(payload) === JSON.stringify(payloads[0]))).toBe(true);
    expect(await database.query('SELECT delivery_status,attempt_count FROM sandbox_outcomes WHERE job_id=$1',
      [request.jobId])).toEqual([{ delivery_status: 'pending', attempt_count: 7 }]);
    jest.mocked(sink.record).mockResolvedValue(undefined);
    await database.query('UPDATE sandbox_outcomes SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
    await worker.runOnce(sink);
    expect(await database.query('SELECT delivery_status FROM sandbox_outcomes WHERE job_id=$1',
      [request.jobId])).toEqual([{ delivery_status: 'delivered' }]);
  });

  test('rejects legacy mutable image jobs visibly without remapping them to v2', async () => {
    const request = await job({ policyRef: 'idan-db-sql@1', imageDigest: 'local/room1-sql:dev' });
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', jobId: request.jobId, errorCode: 'imageNotPinned' }));
    expect(driver.ensure).not.toHaveBeenCalled();
  });

  test('resumes after create/seed interruption using the original UID without reseeding', async () => {
    const request = await job();
    jest.mocked(driver.helper).mockResolvedValueOnce({ version: 1, seeded: false });
    await worker.runOnce(sink);
    const [before] = await database.query('SELECT first_attempt_at,deadline_at FROM engine_sandbox_requests WHERE job_id=$1', [request.jobId]);
    worker = new SandboxWorker(database, repository, driver, 2);
    await worker.initialize(image);
    await database.query('UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE job_id=$1', [request.jobId]);
    await worker.runOnce(sink);
    expect(driver.ensure).toHaveBeenCalledTimes(1);
    expect(driver.read).toHaveBeenCalledWith(request, request.podName);
    expect(await database.query('SELECT first_attempt_at,deadline_at FROM engine_sandbox_requests WHERE job_id=$1',
      [request.jobId])).toEqual([before]);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  test('never reports ready when a successful readiness reply arrives after the original deadline', async () => {
    const request = await job();
    await database.query(`UPDATE engine_sandbox_requests SET first_attempt_at=now()-interval '59.8 seconds',
      deadline_at=now()+interval '200 milliseconds' WHERE job_id=$1`, [request.jobId]);
    jest.mocked(driver.helper).mockImplementation(async (_job, _uid, mode) => {
      if (mode === 'status') return { version: 1, seeded: true, seedRef: 'room1-sql-v1' };
      await new Promise(resolve => setTimeout(resolve, 350));
      return { version: 1, ready: true, seedRef: 'room1-sql-v1' };
    });
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', errorCode: 'provisionTimeout' }));
    expect(sink.record).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  test('does not restart an exhausted ten-second readiness window', async () => {
    const request = await job();
    await database.query(`UPDATE engine_sandbox_requests SET first_attempt_at=now()-interval '12 seconds',
      deadline_at=now()+interval '48 seconds',readiness_started_at=now()-interval '11 seconds',readiness_checks=1
      WHERE job_id=$1`, [request.jobId]);
    await worker.runOnce(sink);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', errorCode: 'readinessFailed' }));
    expect(driver.helper).not.toHaveBeenCalled();
  });

  test('missing persisted pod data fails rather than recreating the same environment', async () => {
    await job();
    jest.mocked(driver.helper).mockResolvedValueOnce({ version: 1, seeded: false });
    await worker.runOnce(sink);
    jest.mocked(driver.read).mockResolvedValue(null);
    await database.query("UPDATE engine_sandbox_requests SET next_attempt_at=now() WHERE status='pending'");
    worker = new SandboxWorker(database, repository, driver, 2);
    await worker.initialize(image);
    await worker.runOnce(sink);
    expect(driver.ensure).toHaveBeenCalledTimes(1);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', errorCode: 'readinessFailed' }));
  });

  test('supersedes stale generation or committed destroy intent without a late ready outcome', async () => {
    const request = await job();
    const destroyId = randomUUID();
    await database.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
      [destroyId, request.sessionId, { ...request, jobId: destroyId, operation: 'destroy' }]);
    await worker.runOnce(sink);
    expect(driver.ensure).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });
});
