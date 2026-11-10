import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { databaseOptions, loadConfig } from '../src/config/config';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { publishRoom2 } from '../src/modules/script-catalog/publish-room2';
import { publishSqlRoom1 } from '../src/modules/script-catalog/publish-sql-room1';
import { room2Script, room2Templates } from '../src/modules/script-catalog/room2';

const databaseTests = process.env.RUN_ROOM2_DB_TESTS === '1' ? describe : describe.skip;
const imageDigest = `embedded/room1-sql@sha256:${'a'.repeat(64)}`;
const driver = { preflight: jest.fn().mockResolvedValue({ verified: true }) } as unknown as Parameters<typeof publishSqlRoom1>[2];

databaseTests('Room 2 catalog publication (disposable PostgreSQL)', () => {
  let container: string | undefined;
  let database: DataSource;
  let repository: CatalogRepository;

  beforeEach(async () => {
    const password = randomBytes(32).toString('hex');
    container = execFileSync('docker', ['run', '--detach', '--rm', '--label', 'team5.test=room2-publication',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=room2_test', '--publish', '127.0.0.1::5432',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', 'postgres:16-alpine'], { encoding: 'utf8', timeout: 60000 }).trim();
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop());
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/room2_test`;
    const deadline = Date.now() + 30000;
    for (;;) {
      const client = new Client({ connectionString: url });
      try { await client.connect(); await client.query('CREATE SCHEMA IF NOT EXISTS team5'); await client.end(); break; }
      catch (error) {
        await client.end().catch(() => undefined);
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    database = new DataSource(databaseOptions(loadConfig({ DATABASE_URL: url })));
    await database.initialize();
    await database.runMigrations();
    repository = new CatalogRepository(database);
  }, 90000);

  afterEach(async () => {
    if (database?.isInitialized) await database.destroy();
    if (container) execFileSync('docker', ['stop', '--time', '1', container], { stdio: 'ignore', timeout: 30000 });
  }, 40000);

  async function publishThroughGameplay() {
    await repository.seed();
    await publishSqlRoom1(database, imageDigest, driver);
    await repository.publishGameplay();
  }

  test('publishes script v5 once, keeps v1 to v4 unchanged, and survives the init-container rerun', async () => {
    await publishThroughGameplay();
    const v4 = (await repository.script('escape-room', 4))!;
    const earlier = `SELECT script_id, version, status, definition FROM team5.script_versions WHERE version < 5 ORDER BY version`;
    const before = await database.query(earlier);

    await publishRoom2(database);
    await publishRoom2(database);
    await Promise.all([publishRoom2(database), publishRoom2(database)]);

    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 5 });
    expect(await repository.script('escape-room', 5)).toEqual(room2Script(v4));
    for (const template of room2Templates()) expect(await repository.template(template.key, 1)).toEqual(template);
    expect(await database.query('SELECT count(*)::int AS count FROM team5.script_versions')).toEqual([{ count: 4 }]);
    expect(await database.query('SELECT count(*)::int AS count FROM team5.component_templates')).toEqual([{ count: 8 }]);
    expect(await database.query(earlier)).toEqual(before);
    await expect(database.query("UPDATE team5.script_versions SET definition = '{}'::jsonb WHERE version = 5"))
      .rejects.toThrow('Published content is immutable');

    // The AKS init container reruns every publisher on each start; none may fail or move the pointer back.
    await repository.seed();
    await publishSqlRoom1(database, imageDigest, driver);
    await repository.publishGameplay();
    await publishRoom2(database);
    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 5 });
  });

  test('refuses publication without catalog 4 and over conflicting immutable content', async () => {
    await repository.seed();
    await expect(publishRoom2(database)).rejects.toThrow('Gameplay catalog 4 must be published first');
    await publishSqlRoom1(database, imageDigest, driver);
    await repository.publishGameplay();
    const rsa = room2Templates().find(template => template.key === 'rsa-decryptor')!;
    await database.query(`INSERT INTO team5.component_templates(key, version, family, engine, definition, status)
      VALUES ('rsa-decryptor', 1, 'input', 'rsa', $1::jsonb, 'published')`,
    [JSON.stringify({ ...rsa.definition, seed: { ...(rsa.definition as { seed: object }).seed, modulusHex: 'ff' } })]);

    await expect(publishRoom2(database)).rejects.toThrow('Conflicting Room 2 template rsa-decryptor@1');

    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 4 });
    expect(await repository.script('escape-room', 5)).toBeUndefined();
    expect(await database.query('SELECT count(*)::int AS count FROM team5.component_templates')).toEqual([{ count: 5 }]);
  });

  test('refuses a conflicting v5 script row', async () => {
    await publishThroughGameplay();
    await database.query(`INSERT INTO team5.script_versions(script_id, version, status, definition, published_at)
      VALUES ('escape-room', 5, 'published', '{}'::jsonb, now())`);
    await expect(publishRoom2(database)).rejects.toThrow('Conflicting Room 2 script v5 publication');
    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 4 });
  });
});
