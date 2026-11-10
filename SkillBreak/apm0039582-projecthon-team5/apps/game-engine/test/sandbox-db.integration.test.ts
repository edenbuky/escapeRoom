import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FoundationSchemas1793570400000 } from '../src/database/migrations/1793570400000-FoundationSchemas';
import { CatalogSchema1793570401000 } from '../src/database/migrations/1793570401000-CatalogSchema';
import { EngineSchema1793570402000 } from '../src/database/migrations/1793570402000-EngineSchema';
import { databaseOptions } from '../src/config/config';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';
import { SandboxRepository } from '../src/modules/sandbox/sandbox.repository';
import { SandboxHarness } from './helpers/sandbox-harness';

const databaseTests = process.env.RUN_SANDBOX_DB_TESTS === '1' ? describe : describe.skip;
databaseTests('sandbox durable schema (owned disposable PostgreSQL)', () => {
  const harness = new SandboxHarness();
  let database: DataSource;
  const sessionId = randomUUID();
  const identity = sandboxIdentity(sessionId, 'idan-db', 1);
  const jobId = randomUUID();
  const request = { ...identity, jobId, operation: 'provision', imageDigest: `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`,
    seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@1' };
  let sandboxId: string;

  beforeAll(async () => {
    await harness.start(false);
    await harness.database!.destroy();
    const old = new DataSource({ ...databaseOptions(harness.config),
      migrations: [FoundationSchemas1793570400000, CatalogSchema1793570401000, EngineSchema1793570402000] });
    try {
      await old.initialize();
      await old.runMigrations();
      await old.query(`INSERT INTO sessions VALUES ($1,$2,'escape-room',1,1,'{}',now())`, [sessionId, randomUUID()]);
      await old.query(`INSERT INTO session_puzzles VALUES ($1,'idan-db','{}')`, [sessionId]);
      await old.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
        [jobId, sessionId, request]);
    } finally { if (old.isInitialized) await old.destroy(); }
    database = new DataSource(databaseOptions(harness.config));
    harness.database = database;
    await database.initialize();
    await database.runMigrations();
  }, 90000);

  afterAll(() => harness.close(), 90000);

  test('a terminated owned lock connection is quarantined, verified absent, and never contaminates pool reuse', async () => {
    const repository = new SandboxRepository(database);
    await expect(repository.withLock(identity, async runner => {
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
      await database.query('SELECT pg_terminate_backend($1)', [pid]);
      await new Promise(resolve => setTimeout(resolve, 50));
    })).rejects.toMatchObject({ code: 'lockCleanupFailed' });
    await expect(repository.withLock(identity, async () => true)).rejects.toMatchObject({ code: 'lockCleanupFailed' });
    await repository.close();
    expect(await database.query('SELECT 42 AS value')).toEqual([{ value: 42 }]);
    const replacement = new SandboxRepository(database);
    try {
      expect(await replacement.withLock(identity, async () => true)).toEqual({ acquired: true, value: true });
    } finally { await replacement.close(); }
  });

  test('upgrades committed jobs without changing their identity or content', async () => {
    expect(await database.query('SELECT job_id,request,status,first_attempt_at FROM engine_sandbox_requests')).toEqual([
      { job_id: jobId, request, status: 'pending', first_attempt_at: null },
    ]);
    expect(await database.query('SELECT name FROM migrations ORDER BY timestamp')).toEqual([
      { name: 'FoundationSchemas1793570400000' }, { name: 'CatalogSchema1793570401000' },
      { name: 'EngineSchema1793570402000' }, { name: 'SqlSandbox1793570403000' },
      { name: 'SessionProjection1793570404000' },
    ]);
    expect(await database.runMigrations()).toEqual([]);
  });

  test('uncommitted and rolled-back requests never appear to other connections', async () => {
    const runner = database.createQueryRunner();
    const id = randomUUID();
    try {
      await runner.startTransaction();
      await runner.query('INSERT INTO engine_sandbox_requests(job_id,session_id,request) VALUES ($1,$2,$3)',
        [id, sessionId, { ...request, jobId: id }]);
      expect(await database.query('SELECT job_id FROM engine_sandbox_requests WHERE job_id=$1', [id])).toEqual([]);
      await runner.rollbackTransaction();
      expect(await database.query('SELECT job_id FROM engine_sandbox_requests WHERE job_id=$1', [id])).toEqual([]);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });

  test.each([
    "status='unknown'", 'readiness_checks=4', 'readiness_checks=-1', 'attempt_count=-1',
    "request='{}'", `last_error_code='SELECT password'`, 'job_id=gen_random_uuid()',
    "first_attempt_at=now(),deadline_at=now()+interval '61 seconds'",
  ])('rejects invalid job mutation %s', async mutation => {
    await expect(database.query(`UPDATE engine_sandbox_requests SET ${mutation} WHERE job_id=$1`, [jobId])).rejects.toThrow();
  });

  test('preserves first-attempt, deadline and readiness budget across restart', async () => {
    await database.query(`UPDATE engine_sandbox_requests SET status='running',first_attempt_at=now(),
      deadline_at=now()+interval '60 seconds',readiness_started_at=now(),readiness_checks=1 WHERE job_id=$1`, [jobId]);
    const [before] = await database.query('SELECT first_attempt_at,deadline_at FROM engine_sandbox_requests WHERE job_id=$1', [jobId]);
    await harness.restartDatabaseClient();
    database = harness.database!;
    expect(await database.query('SELECT first_attempt_at,deadline_at FROM engine_sandbox_requests WHERE job_id=$1', [jobId])).toEqual([before]);
    await expect(database.query(`UPDATE engine_sandbox_requests SET first_attempt_at=now(),
      deadline_at=now()+interval '60 seconds' WHERE job_id=$1`, [jobId])).rejects.toThrow();
    await expect(database.query('UPDATE engine_sandbox_requests SET readiness_checks=0 WHERE job_id=$1', [jobId])).rejects.toThrow();
  });

  async function instance(generation = 1): Promise<string> {
    const id = sandboxIdentity(sessionId, 'idan-db', generation);
    await database.query(`INSERT INTO sandbox_instances(sandbox_id,session_id,puzzle_key,generation,namespace,pod_name,
      template_ref,image_digest,seed_ref,policy_ref) VALUES ($1,$2,$3,$4,$5,$1,$6,$7,$8,$9)`,
    [id.podName, sessionId, id.puzzleKey, generation, id.namespace, 'idan-db-sql@2', request.imageDigest,
      request.seedRef, 'idan-db-sql@2']);
    return id.podName;
  }

  test('persists canonical unique sandbox identities and bounded immutable lifetime', async () => {
    sandboxId = await instance();
    await expect(instance()).rejects.toThrow();
    for (const mutation of ["generation=0", "namespace='default'", "pod_name='other'", "image_digest='local/sql:dev'",
      "template_ref=''", "desired_state='other'", "status='other'", "max_expires_at=now()+interval '3 hours'",
      "lease_expires_at=max_expires_at+interval '1 second'", "pod_uid=''"]) {
      await expect(database.query(`UPDATE sandbox_instances SET ${mutation} WHERE sandbox_id=$1`, [sandboxId])).rejects.toThrow();
    }
    const [row] = await database.query(`SELECT extract(epoch FROM (max_expires_at-created_at))::int AS max,
      extract(epoch FROM (lease_expires_at-created_at))::int AS idle FROM sandbox_instances WHERE sandbox_id=$1`, [sandboxId]);
    expect(row).toEqual({ max: 7200, idle: 900 });
    await database.query("UPDATE sandbox_instances SET pod_uid='owned-uid',status='ready' WHERE sandbox_id=$1", [sandboxId]);
    await expect(database.query("UPDATE sandbox_instances SET pod_uid='replaced' WHERE sandbox_id=$1", [sandboxId])).rejects.toThrow();
  });

  async function admit(commandId: string): Promise<void> {
    await database.transaction(async manager => {
      await manager.query(`INSERT INTO sandbox_executions(command_id,sandbox_id,input_hash,execution_token)
        VALUES ($1,$2,$3,$4)`, [commandId, sandboxId, 'f'.repeat(64), randomUUID()]);
      await manager.query('UPDATE sandbox_instances SET active_command_id=$1 WHERE sandbox_id=$2', [commandId, sandboxId]);
    });
  }

  test('requires atomic active-command admission and exactly one running command', async () => {
    await expect(database.query(`INSERT INTO sandbox_executions(command_id,sandbox_id,input_hash,execution_token)
      VALUES ($1,$2,$3,$4)`, [randomUUID(), sandboxId, 'f'.repeat(64), randomUUID()])).rejects.toThrow();
    const commandId = randomUUID();
    await admit(commandId);
    await expect(admit(randomUUID())).rejects.toThrow();
    await expect(database.query("UPDATE sandbox_executions SET input_hash=$1 WHERE command_id=$2", ['e'.repeat(64), commandId])).rejects.toThrow();
    await database.transaction(async manager => {
      await manager.query(`UPDATE sandbox_executions SET status='completed',stdout=$2,exit_code=0,
        finished_at=now(),quiesced_at=now() WHERE command_id=$1`, [commandId, 'é'.repeat(32768)]);
      await manager.query('UPDATE sandbox_instances SET active_command_id=NULL WHERE sandbox_id=$1', [sandboxId]);
    });
    expect(await database.query('SELECT octet_length(stdout) AS bytes FROM sandbox_executions WHERE command_id=$1', [commandId]))
      .toEqual([{ bytes: 65536 }]);
    await expect(database.query("UPDATE sandbox_executions SET stdout='' WHERE command_id=$1", [commandId])).rejects.toThrow();
  });

  test('enforces combined UTF-8 bytes at below/exact/over limits without discarding running state', async () => {
    for (const [stdout, stderr, valid] of [
      ['é'.repeat(32767), 'a', true], ['é'.repeat(32767), 'ab', true], ['é'.repeat(32768), 'a', false],
    ] as const) {
      const commandId = randomUUID();
      await admit(commandId);
      const save = () => database.transaction(async manager => {
        await manager.query(`UPDATE sandbox_executions SET status='completed',stdout=$2,stderr=$3,exit_code=0,
          finished_at=now(),quiesced_at=now() WHERE command_id=$1`, [commandId, stdout, stderr]);
        await manager.query('UPDATE sandbox_instances SET active_command_id=NULL WHERE sandbox_id=$1', [sandboxId]);
      });
      if (valid) await save();
      else {
        await expect(save()).rejects.toThrow();
        await database.transaction(async manager => {
          await manager.query(`UPDATE sandbox_executions SET status='interrupted',error_code='interrupted',
            finished_at=now(),quiesced_at=now() WHERE command_id=$1`, [commandId]);
          await manager.query('UPDATE sandbox_instances SET active_command_id=NULL WHERE sandbox_id=$1', [sandboxId]);
        });
      }
    }
  });

  test('stages immutable outcomes and enforces matching identity and delivery state', async () => {
    const payload = { ...identity, jobId, kind: 'ready', occurredAt: new Date().toISOString() };
    await database.query('INSERT INTO sandbox_outcomes(job_id,kind,payload) VALUES ($1,$2,$3)', [jobId, 'ready', payload]);
    await expect(database.query("UPDATE sandbox_outcomes SET payload='{}' WHERE job_id=$1", [jobId])).rejects.toThrow();
    await expect(database.query("UPDATE sandbox_outcomes SET attempt_count=-1 WHERE job_id=$1", [jobId])).rejects.toThrow();
    await expect(database.query("UPDATE sandbox_outcomes SET delivery_status='other' WHERE job_id=$1", [jobId])).rejects.toThrow();
    await database.query("UPDATE sandbox_outcomes SET delivery_status='delivered',delivered_at=now() WHERE job_id=$1", [jobId]);
  });

  test('destroy intent cannot be reversed and retained results survive it', async () => {
    await database.query("UPDATE sandbox_instances SET desired_state='destroyed',status='destroying' WHERE sandbox_id=$1", [sandboxId]);
    await expect(database.query("UPDATE sandbox_instances SET desired_state='ready' WHERE sandbox_id=$1", [sandboxId])).rejects.toThrow();
    await database.query("UPDATE sandbox_instances SET status='destroyed' WHERE sandbox_id=$1", [sandboxId]);
    expect((await database.query('SELECT command_id FROM sandbox_executions WHERE sandbox_id=$1', [sandboxId])).length).toBeGreaterThan(0);
  });

  test('real competing locks reject busy without blocking a different sandbox and release after work', async () => {
    const first = new SandboxRepository(database);
    const second = new SandboxRepository(database);
    let resume!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const locked = first.withLock(identity, async () => { started(); await waiting; return 'first'; });
    try {
      await entered;
      expect(await second.withLock(identity, async () => 'must not run')).toEqual({ acquired: false });
      expect(await second.withLock(sandboxIdentity(sessionId, 'idan-db', 2), async () => 'independent'))
        .toEqual({ acquired: true, value: 'independent' });
    } finally { resume(); await locked; }
    expect(await second.withLock(identity, async () => 'released')).toEqual({ acquired: true, value: 'released' });
    await first.close();
    await second.close();
  });

  test('repository immutable-instance replay and safe state writes use committed parameterized data', async () => {
    const repository = new SandboxRepository(database);
    const newIdentity = sandboxIdentity(sessionId, 'idan-db', 2);
    const input = { ...newIdentity, templateRef: 'idan-db-sql@2', imageDigest: request.imageDigest,
      seedRef: request.seedRef, policyRef: 'idan-db-sql@2' };
    await database.transaction(manager => repository.createInstance(manager, input));
    await database.transaction(manager => repository.createInstance(manager, input));
    await expect(database.transaction(manager => repository.createInstance(manager,
      { ...input, imageDigest: `localhost:5001/room1-sql@sha256:${'b'.repeat(64)}` })))
      .rejects.toMatchObject({ code: 'templateMismatch' });
    await database.transaction(manager => repository.saveInstanceError(manager, newIdentity, 'runtimeUnavailable'));
    expect(await database.query('SELECT last_error_code FROM sandbox_instances WHERE sandbox_id=$1', [newIdentity.podName]))
      .toEqual([{ last_error_code: 'runtimeUnavailable' }]);
    expect((await repository.pendingJobs()).map(row => row.job_id)).toContain(jobId);
    await repository.close();
  });

  test('down migration preserves earlier engine/catalog data and can be upgraded again', async () => {
    await database.undoLastMigration();
    expect(await database.query('SELECT job_id,request FROM engine_sandbox_requests')).toEqual([{ job_id: jobId, request }]);
    expect(await database.query('SELECT id FROM sessions')).toEqual([{ id: sessionId }]);
    expect(await database.runMigrations()).toHaveLength(1);
    expect(await database.runMigrations()).toEqual([]);
  });
});
