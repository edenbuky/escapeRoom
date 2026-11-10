import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { databaseOptions, ENGINE_CONFIG, loadConfig } from '../src/config/config';
import { FoundationSchemas1793570400000 } from '../src/database/migrations/1793570400000-FoundationSchemas';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { ScriptCatalogModule } from '../src/modules/script-catalog/script-catalog.module';
import { ROOM1, room1Script, room1Templates } from '../src/modules/script-catalog/room1';

const databaseTests = process.env.RUN_CATALOG_DB_TESTS === '1' ? describe : describe.skip;

databaseTests('catalog PostgreSQL and HTTP integration (isolated Docker database)', () => {
  let container: string | undefined;
  let database: DataSource | undefined;
  let application: INestApplication | undefined;
  let repository: CatalogRepository;
  let baseUrl: string;
  const token = randomBytes(32).toString('base64');
  const config = loadConfig({
    DATABASE_URL: 'postgresql://postgres:temporary@127.0.0.1:5432/catalog_test',
    INTERNAL_API_TOKEN: token,
  });

  beforeAll(async () => {
    const password = randomBytes(32).toString('hex');
    container = execFileSync('docker', [
      'run', '--detach', '--rm', '--label', 'team5.test=catalog-1.3',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=catalog_test',
      '--publish', '127.0.0.1::5432', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      'postgres:16-alpine',
    ], { encoding: 'utf8', timeout: 60000 }).trim();
    const binding = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim();
    const hostPort = Number(binding.split(':').pop());
    if (!Number.isInteger(hostPort) || hostPort < 1) throw new Error('Temporary database port unavailable');
    config.databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${hostPort}/catalog_test`;
    database = new DataSource({ ...databaseOptions(config), migrations: [FoundationSchemas1793570400000] });
    const deadline = Date.now() + 30000;
    while (!database.isInitialized) {
      try { await database.initialize(); }
      catch {
        if (Date.now() >= deadline) throw new Error('Temporary PostgreSQL did not become ready');
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    await database.runMigrations();
    await database.destroy();
    database = new DataSource(databaseOptions(config));
    await database.initialize();
    await database.runMigrations();

    @Global()
    @Module({
      providers: [{ provide: DataSource, useValue: database }, { provide: ENGINE_CONFIG, useValue: config }],
      exports: [DataSource, ENGINE_CONFIG],
    })
    class TestDependencies {}
    @Module({ imports: [TestDependencies, ScriptCatalogModule] })
    class CatalogTestApp {}
    application = await NestFactory.create(CatalogTestApp, { logger: false, abortOnError: false });
    await application.listen(0, '127.0.0.1');
    baseUrl = await application.getUrl();
    repository = application.get(CatalogRepository);
  }, 90000);

  afterAll(async () => {
    try { await application?.close(); }
    finally {
      try { if (database?.isInitialized) await database.destroy(); }
      finally {
        if (container) execFileSync('docker', ['stop', '--time', '1', container], { stdio: 'ignore', timeout: 30000 });
      }
    }
  }, 40000);

  async function request(path: string, headers: Record<string, string> = { 'x-internal-token': token }) {
    return fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5000) });
  }

  test('upgrades foundation without replacing migration history or adding catalog messaging tables', async () => {
    expect(await database!.query('SELECT name FROM migrations ORDER BY timestamp')).toEqual([
      { name: 'FoundationSchemas1793570400000' }, { name: 'CatalogSchema1793570401000' },
      { name: 'EngineSchema1793570402000' },
      { name: 'SqlSandbox1793570403000' },
      { name: 'SessionProjection1793570404000' },
    ]);
    expect(await database!.showMigrations()).toBe(false);
    expect(await database!.runMigrations()).toEqual([]);
    expect(await database!.query("SELECT tablename FROM pg_tables WHERE schemaname = 'catalog' ORDER BY tablename"))
      .toEqual([{ tablename: 'component_templates' }, { tablename: 'script_versions' }, { tablename: 'scripts' }]);
    expect(await database!.query("SELECT tablename FROM pg_tables WHERE schemaname = 'projection' ORDER BY tablename")).toEqual([
      { tablename: 'messaging_consumer_attempt' }, { tablename: 'messaging_dead_letter' },
      { tablename: 'messaging_inbox_receipt' }, { tablename: 'session_view' },
    ]);
  });

  test('seeds published room 1 twice without duplicates and serves all templates over HTTP', async () => {
    await repository.seed();
    await repository.seed();
    expect(await database!.query('SELECT count(*)::int AS count FROM catalog.component_templates')).toEqual([{ count: 3 }]);
    expect(await database!.query('SELECT count(*)::int AS count FROM catalog.script_versions')).toEqual([{ count: 1 }]);
    const current = await request('/internal/scripts/by-slug/escape-room/current');
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ scriptId: 'escape-room', version: 1 });
    const script = await request('/internal/scripts/escape-room/versions/1');
    expect(script.status).toBe(200);
    expect(script.headers.get('cache-control')).toBe('no-store');
    expect(await script.json()).toEqual(room1Script);
    for (const template of room1Templates) {
      const response = await request(`/internal/templates/${template.key}/versions/1`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(template);
    }
  });

  test.each([
    '/internal/scripts/by-slug/escape-room/current',
    '/internal/scripts/escape-room/versions/1',
    '/internal/templates/dana-login/versions/1',
  ])('protects %s before querying private content', async path => {
    const query = jest.spyOn(database!, 'query');
    try {
      const invalidHeaders: Record<string, string>[] = [{}, { 'x-internal-token': 'wrong' }, { 'x-internal-token': `${token}, ${token}` }];
      for (const headers of invalidHeaders) {
        const response = await request(path, headers);
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ statusCode: 401 });
      }
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
  });

  test('missing internal-token configuration disables HTTP lookups without exposing definitions', async () => {
    config.internalApiToken = undefined;
    try {
      const response = await request('/internal/templates/dana-login/versions/1');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ statusCode: 503 });
    } finally { config.internalApiToken = token; }
  });

  test.each(['0', '-1', '1.5', '2147483648', 'not-a-version'])('rejects invalid version %s', async version => {
    for (const path of [`scripts/escape-room/versions/${version}`, `templates/dana-login/versions/${version}`]) {
      const response = await request(`/internal/${path}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ statusCode: 400 });
    }
  });

  test('unknown, draft and retired versions are not returned as published content', async () => {
    await database!.query(`INSERT INTO catalog.script_versions(script_id, version, status, definition)
      VALUES ('escape-room', 2, 'draft', '{}'), ('escape-room', 3, 'retired', '{}')`);
    await database!.query(`INSERT INTO catalog.component_templates(key, version, family, engine, definition, status)
      VALUES ('dana-login', 2, 'input', 'answer', '{}', 'draft'), ('dana-login', 3, 'input', 'answer', '{}', 'retired')`);
    for (const path of [
      'scripts/by-slug/missing/current', 'scripts/missing/versions/1', 'templates/missing/versions/1',
      'scripts/escape-room/versions/2', 'scripts/escape-room/versions/3',
      'templates/dana-login/versions/2', 'templates/dana-login/versions/3',
    ]) {
      expect((await request(`/internal/${path}`)).status).toBe(404);
    }
    for (const version of [2, 3]) {
      await database!.query('UPDATE catalog.scripts SET current_version = $1 WHERE id = $2', [version, 'escape-room']);
      expect(await repository.current('escape-room')).toBeUndefined();
    }
    await database!.query("UPDATE catalog.scripts SET current_version = 1 WHERE id = 'escape-room'");
  });

  test('published and retired rows reject SQL updates, deletes and unpublishing', async () => {
    for (const version of [1, 3]) {
      for (const table of ['script_versions', 'component_templates']) {
        for (const change of ["SET definition = '{}'::jsonb || '{\"changed\":true}'::jsonb", "SET status = 'draft'", 'SET version = 99']) {
          await expect(database!.query(`UPDATE catalog.${table} ${change} WHERE version = $1`, [version]))
            .rejects.toThrow('Published content is immutable');
        }
        await expect(database!.query(`DELETE FROM catalog.${table} WHERE version = $1`, [version]))
          .rejects.toThrow('Published content is immutable');
      }
    }
    await expect(database!.query("UPDATE catalog.component_templates SET engine = 'hash' WHERE key = 'dana-login' AND version = 1"))
      .rejects.toThrow('Published content is immutable');
    expect(await repository.script('escape-room', 1)).toEqual(room1Script);
    expect(await repository.template('dana-login', 1)).toEqual(room1Templates[2]);
  });

  test('seed refuses conflicting published definitions instead of overwriting them', async () => {
    const originalDuration = room1Script.durationMinutes;
    room1Script.durationMinutes = 46;
    try { await expect(repository.seed()).rejects.toThrow('Conflicting script version seed'); }
    finally { room1Script.durationMinutes = originalDuration; }
    const originalTemplate = room1Templates[2];
    const originalSchema = originalTemplate.definition.inputSchema;
    originalTemplate.definition.inputSchema = { ...originalSchema, changed: true };
    try { await expect(repository.seed()).rejects.toThrow('Conflicting template seed'); }
    finally { originalTemplate.definition.inputSchema = originalSchema; }
    expect(await repository.script('escape-room', 1)).toEqual(room1Script);
    expect(await repository.template('dana-login', 1)).toEqual(originalTemplate);
  });

  test('seed rolls back earlier inserts when a later template conflicts', async () => {
    const originalFirst = room1Templates[0];
    const originalLast = room1Templates[2];
    room1Templates[0] = { ...originalFirst, key: 'rollback-probe' };
    room1Templates[2] = { ...originalLast, version: 3 };
    try { await expect(repository.seed()).rejects.toThrow('Conflicting template seed'); }
    finally { room1Templates[0] = originalFirst; room1Templates[2] = originalLast; }
    expect(await database!.query("SELECT key FROM catalog.component_templates WHERE key = 'rollback-probe'")).toEqual([]);
  });

  test('repository failures return sanitized non-cacheable HTTP errors', async () => {
    const query = jest.spyOn(database!, 'query').mockRejectedValueOnce(new Error(`private definition ${ROOM1.danaPassword}`));
    try {
      const response = await request('/internal/templates/dana-login/versions/1');
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ statusCode: 503 });
    } finally { query.mockRestore(); }
  });
});