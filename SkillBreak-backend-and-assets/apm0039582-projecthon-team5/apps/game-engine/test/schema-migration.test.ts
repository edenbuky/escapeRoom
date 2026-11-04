import type { QueryRunner } from 'typeorm';
import { FoundationSchemas1793570400000 } from '../src/database/migrations/1793570400000-FoundationSchemas';
import { CatalogSchema1793570401000 } from '../src/database/migrations/1793570401000-CatalogSchema';
import { EngineSchema1793570402000 } from '../src/database/migrations/1793570402000-EngineSchema';
import { databaseOptions, loadConfig } from '../src/config/config';

test('foundation migration creates schemas only and can be re-applied safely', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockResolvedValue(undefined) };
  const migration = new FoundationSchemas1793570400000();
  await migration.up(runner);
  await migration.up(runner);
  expect(runner.query).toHaveBeenNthCalledWith(1, 'CREATE SCHEMA IF NOT EXISTS catalog');
  expect(runner.query).toHaveBeenNthCalledWith(2, 'CREATE SCHEMA IF NOT EXISTS projection');
  expect(runner.query).toHaveBeenCalledTimes(4);
});
test('migration errors propagate and rollback refuses to remove populated schemas', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockRejectedValue(new Error('denied')) };
  await expect(new FoundationSchemas1793570400000().up(runner)).rejects.toThrow('denied');
  await expect(new FoundationSchemas1793570400000().down(runner)).rejects.toThrow('denied');
  expect(runner.query).toHaveBeenLastCalledWith('DROP SCHEMA IF EXISTS projection');
});

test('catalog migration scopes business tables and immutable-content guards to catalog only', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockResolvedValue(undefined) };
  await new CatalogSchema1793570401000().up(runner);
  const sql = (runner.query as jest.Mock).mock.calls[0][0] as string;
  for (const table of ['scripts', 'script_versions', 'component_templates']) {
    expect(sql).toContain(`CREATE TABLE catalog.${table}`);
  }
  expect(sql).toContain('CREATE FUNCTION catalog.guard_published_content()');
  expect(sql).toContain('BEFORE UPDATE OR DELETE ON catalog.script_versions');
  expect(sql).toContain('BEFORE UPDATE OR DELETE ON catalog.component_templates');
  expect(sql).not.toMatch(/outbox|inbox|dead_letters|CREATE SCHEMA|projection/);
});

test('engine forward migration owns session and messaging tables without changing catalog or projection', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockResolvedValue(undefined) };
  await new EngineSchema1793570402000().up(runner);
  const sql = (runner.query as jest.Mock).mock.calls[0][0] as string;
  for (const table of ['sessions', 'session_puzzles', 'command_log', 'engine_sandbox_requests',
    'messaging_outbox', 'messaging_inbox_receipt', 'messaging_consumer_attempt', 'messaging_dead_letter']) {
    expect(sql).toContain(`CREATE TABLE ${table}`);
  }
  expect(sql).not.toMatch(/catalog\.|projection\.|DROP |ALTER /);
});

test('complete engine migration order preserves all previous identities', () => {
  const options = databaseOptions(loadConfig({
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test', REDIS_URL: 'redis://127.0.0.1',
  }));
  expect(options.migrations).toEqual([
    FoundationSchemas1793570400000, CatalogSchema1793570401000, EngineSchema1793570402000,
    expect.objectContaining({ name: 'SqlSandbox1793570403000' }),
    expect.objectContaining({ name: 'SessionProjection1793570404000' }),
  ]);
});
