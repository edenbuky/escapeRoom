import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/config';
import { EmbeddedDriver, embeddedImageDigest } from '../src/modules/sandbox/embedded-driver';
import { EmbeddedSql } from '../src/modules/sandbox/embedded-sql';
import type { ProvisionJob } from '../src/modules/sandbox/sandbox.contracts';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';
import { decodeSqlRows, validateHelperResult } from '../src/modules/sandbox/sql-result';
import { sandboxIdentity } from '../src/modules/sessions/core/ids';

jest.setTimeout(60000);

const hash = 'ea7e95b64496fb6f22959c4a2f6442ab5bd4d8a2ba9c5a0ff9404ee792a6ac90';
const job = (): ProvisionJob => ({ ...sandboxIdentity(randomUUID(), 'idan-db', 1), jobId: randomUUID(),
  operation: 'provision', imageDigest: embeddedImageDigest(), seedRef: 'room1-sql-v1', policyRef: 'idan-db-sql@2' });

describe('embedded sandbox driver', () => {
  const driver = new EmbeddedDriver(new EmbeddedSql(), 1500);
  let sandbox: ProvisionJob;
  let uid: string;
  const query = async (command: string) => {
    const commandId = randomUUID();
    const value = await driver.helper(sandbox, uid, 'query', { executionToken: randomUUID(), commandId, command });
    return validateHelperResult(value, commandId);
  };

  beforeAll(async () => {
    expect(await driver.preflight(embeddedImageDigest())).toMatchObject({ verified: true, embedded: true });
    sandbox = job();
    uid = (await driver.ensure(sandbox)).metadata!.uid!;
  });
  afterAll(() => driver.onModuleDestroy());

  test('follows the provision lifecycle the worker expects, without a pod', async () => {
    expect(await driver.read(sandbox, uid)).toEqual({ metadata: { uid }, status: { phase: 'Running' } });
    expect(await driver.ensure(sandbox)).toEqual({ metadata: { uid }, status: { phase: 'Running' } });
    await expect(driver.read(sandbox, randomUUID())).rejects.toMatchObject({ code: 'ownershipConflict' });
    expect(await driver.helper(sandbox, uid, 'status', { probeSeed: true })).toEqual({ version: 1, seeded: true, seedRef: 'room1-sql-v1' });
    expect(await driver.helper(sandbox, uid, 'ready')).toEqual({ version: 1, ready: true, seedRef: 'room1-sql-v1' });
    const other = job();
    const otherUid = (await driver.ensure(other)).metadata!.uid!;
    expect(await driver.confirmAbsent(other)).toBe(false);
    await driver.remove(other, otherUid);
    expect(await driver.confirmAbsent(other)).toBe(true);
    expect(await driver.read(other)).toBeNull();
    await expect(driver.helper(other, otherUid, 'ready')).rejects.toMatchObject({ code: 'notReady' });
    await expect(driver.ensure({ ...other, seedRef: 'room2-git' })).rejects.toMatchObject({ code: 'templateMismatch' });
  });

  test('accepts only the template pinned to its own fixture, like the Kubernetes allowlist', () => {
    expect(embeddedImageDigest()).toMatch(/^embedded\/room1-sql@sha256:[0-9a-f]{64}$/);
    expect(() => driver.validateImage(embeddedImageDigest())).not.toThrow();
    for (const image of ['local/room1-sql:dev', `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`]) {
      expect(() => driver.validateImage(image)).toThrow(SandboxExecutionError);
    }
  });

  test('returns the pod helper output format for the Room 1 answer query', async () => {
    const result = await query(`SELECT e.username, l.password_hash FROM employees e JOIN logs l ON l.employee_id = e.id
      WHERE l.event = 'auth'`);
    expect(result).toMatchObject({ exitCode: 0, stderr: '', timedOut: false, truncated: false });
    expect(result.stdout).toBe(`username\tpassword_hash\ndanaZ22\t${hash}\n`);
  });

  test('keeps raw Postgres text, nulls and empty results like the helper', async () => {
    expect((await query('SELECT id, event, password_hash, happened_at FROM logs ORDER BY id LIMIT 2')).stdout).toBe(
      `id\tevent\tpassword_hash\thappened_at\n1\tauth\t${hash}\t2026-01-01 10:00:00+00\n2\tlogout\t\\N\t2026-01-01 10:01:00+00\n`);
    expect((await query("SELECT 1.50::numeric AS n, true AS b, E'a\\tb' AS t")).stdout).toBe('n\tb\tt\n1.50\tt\ta\\tb\n');
    expect((await query('SELECT name FROM employees WHERE false')).stdout).toBe('name\n');
    expect(decodeSqlRows((await query('SELECT count(*) FROM employees')).stdout)).toEqual([['24']]);
  });

  test('refuses writes and reports diagnostics with the helper wording', async () => {
    for (const command of ['DELETE FROM logs', "UPDATE employees SET name = 'x'", 'CREATE TEMP TABLE t (x int)',
      "COPY employees TO '/tmp/x'", "SELECT set_config('transaction_read_only', 'off', true)"]) {
      const result = await query(command);
      expect(result.exitCode).toBe(1);
      expect(['SQL operation is not permitted.\n', 'SQL query failed.\n']).toContain(result.stderr);
    }
    expect((await query('SELECT FROM WHERE')).stderr).toBe('SQL syntax is invalid; submit one statement.\n');
    expect((await query('SELECT * FROM missing_table')).stderr).toBe('SQL query failed.\n');
  });

  test('a role change inside one statement does not survive into the next', async () => {
    await query("SELECT set_config('role', 'postgres', false)");
    expect((await query('SELECT current_user')).stdout).toBe('current_user\nsandbox_player\n');
  });

  test('truncates at 64 KB and times out runaway queries, then keeps serving', async () => {
    const big = await query("SELECT repeat('x', 1000) FROM generate_series(1, 200)");
    expect(big).toMatchObject({ truncated: true, exitCode: null });
    expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(65536);
    const slow = await query('SELECT pg_sleep(10)');
    expect(slow).toMatchObject({ timedOut: true, exitCode: null, stdout: '', stderr: 'SQL execution timed out.\n' });
    expect((await query('SELECT count(*) FROM logs')).stdout).toBe('count\n150\n');
  });

  test('execution tokens are single use and report quiescence like the helper', async () => {
    const executionToken = randomUUID();
    const commandId = randomUUID();
    await driver.helper(sandbox, uid, 'query', { executionToken, commandId, command: 'SELECT 1' });
    expect(await driver.helper(sandbox, uid, 'status', { executionToken })).toEqual({ version: 1, executionToken, quiesced: true });
    await expect(driver.helper(sandbox, uid, 'query', { executionToken, commandId, command: 'SELECT 1' }))
      .rejects.toBeInstanceOf(SandboxExecutionError);
    const cancelled = randomUUID();
    expect(await driver.helper(sandbox, uid, 'cancel', { executionToken: cancelled })).toEqual({ version: 1, executionToken: cancelled, quiesced: true });
    await expect(driver.helper(sandbox, uid, 'query', { executionToken: cancelled, commandId: randomUUID(), command: 'SELECT 1' }))
      .rejects.toBeInstanceOf(SandboxExecutionError);
    await expect(driver.helper(sandbox, uid, 'inspect')).rejects.toMatchObject({ code: 'policyBlocked' });
  });
});

describe('sandbox driver config', () => {
  const environment = { DATABASE_URL: 'postgres://u:p@127.0.0.1/engine', JWT_ACCESS_SECRET: Buffer.alloc(32, 1).toString('base64') };
  test('embedded is the default and needs no Kubernetes settings', () => {
    expect(loadConfig({ ...environment, SANDBOX_ENABLED: 'true' }).sandbox).toMatchObject({ enabled: true, driver: 'embedded' });
    expect(() => loadConfig({ ...environment, SANDBOX_DRIVER: 'docker' })).toThrow('SANDBOX_DRIVER');
    expect(() => loadConfig({ ...environment, SANDBOX_ENABLED: 'true', SANDBOX_DRIVER: 'kubernetes' })).toThrow('SANDBOX_KUBE_CONTEXT');
  });
});
