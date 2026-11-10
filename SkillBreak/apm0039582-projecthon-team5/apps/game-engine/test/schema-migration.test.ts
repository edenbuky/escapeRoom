import type { QueryRunner } from 'typeorm';
import { FoundationSchemas1793570400000 } from '../src/database/migrations/1793570400000-FoundationSchemas';
import { CatalogSchema1793570401000 } from '../src/database/migrations/1793570401000-CatalogSchema';
import { EngineSchema1793570402000 } from '../src/database/migrations/1793570402000-EngineSchema';
import { databaseOptions, loadConfig } from '../src/config/config';

test('foundation migration never creates or removes shared database schemas', async () => {
  const migration = new FoundationSchemas1793570400000();
  await expect(migration.up()).resolves.toBeUndefined();
  await expect(migration.down()).resolves.toBeUndefined();
});

test('catalog migration scopes business tables and immutable-content guards to team5 only', async () => {
  const runner: Pick<QueryRunner, 'query'> = { query: jest.fn().mockResolvedValue(undefined) };
  await new CatalogSchema1793570401000().up(runner);
  const sql = (runner.query as jest.Mock).mock.calls[0][0] as string;
  for (const table of ['scripts', 'script_versions', 'component_templates']) {
    expect(sql).toContain(`CREATE TABLE team5.${table}`);
  }
  expect(sql).toContain('CREATE FUNCTION team5.guard_published_content()');
  expect(sql).toContain('BEFORE UPDATE OR DELETE ON team5.script_versions');
  expect(sql).toContain('BEFORE UPDATE OR DELETE ON team5.component_templates');
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
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
  }));
  expect(options.migrations).toEqual([
    FoundationSchemas1793570400000, CatalogSchema1793570401000, EngineSchema1793570402000,
    expect.objectContaining({ name: 'SqlSandbox1793570403000' }),
    expect.objectContaining({ name: 'SessionProjection1793570404000' }),
    expect.objectContaining({ name: 'SandboxSeedRefs1793570410000' }),
  ]);
  if (options.type !== 'postgres') throw new Error('Expected PostgreSQL options');
  expect(options.schema).toBe('team5');
  expect(options.migrationsTableName).toBe('engine_migrations');
});
