import type { QueryRunner } from 'typeorm';
import { SqlSandbox1793570403000 } from '../src/database/migrations/1793570403000-SqlSandbox';

test('sandbox forward migration extends the existing queue and adds bounded durable state', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockResolvedValue(undefined) };
  await new SqlSandbox1793570403000().up(runner);
  const sql = (runner.query as jest.Mock).mock.calls.map(call => call[0]).join('\n');
  expect(sql).toContain('ALTER TABLE engine_sandbox_requests');
  for (const table of ['sandbox_instances', 'sandbox_executions', 'sandbox_outcomes']) {
    expect(sql).toContain(`CREATE TABLE ${table}`);
  }
  expect(sql).toContain('octet_length(stdout) + octet_length(stderr) <= 65536');
  expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  expect(sql).toContain("WHERE status = 'running'");
  expect(sql).not.toMatch(/CREATE TABLE engine_sandbox_requests|ALTER TABLE catalog|DROP TABLE/);
});

test('sandbox down migration leaves earlier engine and catalog tables intact', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockResolvedValue(undefined) };
  await new SqlSandbox1793570403000().down(runner);
  const sql = (runner.query as jest.Mock).mock.calls.map(call => call[0]).join('\n');
  expect(sql).not.toMatch(/DROP TABLE (sessions|session_puzzles|engine_sandbox_requests|catalog\.)/);
  expect(sql).toContain('DROP TABLE sandbox_outcomes');
});
