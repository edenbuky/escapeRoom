import { DataSource } from 'typeorm';
import { SandboxHarness } from './helpers/sandbox-harness';
import { CatalogRepository } from '../src/modules/script-catalog/catalog.repository';
import { room1Script, room1Templates } from '../src/modules/script-catalog/room1';
import { KubernetesDriver } from '../src/modules/sandbox/kubernetes-driver';
import { publishSqlRoom1 } from '../src/modules/script-catalog/publish-sql-room1';

const databaseTests = process.env.RUN_SANDBOX_DB_TESTS === '1' ? describe : describe.skip;
const imageDigest = `localhost:5001/room1-sql@sha256:${'a'.repeat(64)}`;

function verifier(): Pick<KubernetesDriver, 'preflight'> {
  return { preflight: jest.fn().mockResolvedValue({ verified: true }) } as unknown as Pick<KubernetesDriver, 'preflight'>;
}

describe('SQL room 1 catalog publication validation', () => {
  test('rejects mutable tags before preflight or database mutation', async () => {
    const transaction = jest.fn();
    const database = { transaction } as unknown as DataSource;
    const driver = verifier();

    await expect(publishSqlRoom1(database, 'localhost:5001/room1-sql:dev', driver)).rejects.toThrow();

    expect(driver.preflight).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  test('does not open a catalog transaction when verifier preflight rejects', async () => {
    const events: string[] = [];
    const database = { transaction: jest.fn(() => {
      events.push('transaction');
      return Promise.reject(new Error('unexpected transaction'));
    }) } as unknown as DataSource;
    const driver = {
      preflight: jest.fn(async () => {
        events.push('preflight');
        throw new Error('fixture verification failed');
      }),
    } as unknown as Pick<KubernetesDriver, 'preflight'>;

    await expect(publishSqlRoom1(database, imageDigest, driver)).rejects.toThrow('fixture verification failed');

    expect(events).toEqual(['preflight']);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  test('completes verifier preflight before opening the catalog transaction', async () => {
    const events: string[] = [];
    const database = { transaction: jest.fn(async () => {
      events.push('transaction');
      throw new Error('transaction reached');
    }) } as unknown as DataSource;
    const driver = {
      preflight: jest.fn(async () => {
        events.push('preflight');
        return { verified: true };
      }),
    } as unknown as Pick<KubernetesDriver, 'preflight'>;

    await expect(publishSqlRoom1(database, imageDigest, driver)).rejects.toThrow('transaction reached');

    expect(events).toEqual(['preflight', 'transaction']);
  });
});

databaseTests('SQL room 1 catalog publication (disposable PostgreSQL)', () => {
  let harness: SandboxHarness;

  beforeEach(async () => {
    harness = new SandboxHarness();
    await harness.start();
  }, 90000);

  afterEach(async () => {
    await harness.close();
  }, 40000);

  test('preserves v1, publishes v2 atomically, supports replay/concurrency, and prevents seed downgrade', async () => {
    const database = harness.database!;
    const repository = new CatalogRepository(database);
    await repository.seed();

    const beforeV1 = await database.query(`SELECT script_id, version, status, definition
      FROM catalog.script_versions ORDER BY script_id, version`);
    const beforeTemplates = await database.query(`SELECT key, version, family, engine, status, definition
      FROM catalog.component_templates ORDER BY key, version`);
    const driver = verifier();

    await publishSqlRoom1(database, imageDigest, driver);

    expect(driver.preflight).toHaveBeenCalledTimes(1);
    const sqlTemplateV1 = room1Templates.find(template => template.key === 'idan-db-sql')!;
    const expectedTemplateV2 = {
      ...sqlTemplateV1,
      version: 2,
      definition: { ...sqlTemplateV1.definition, imageDigest },
    };
    const expectedScriptV2 = structuredClone(room1Script);
    expectedScriptV2.version = 2;
    expectedScriptV2.states[0].puzzles.find(puzzle => puzzle.key === 'idan-db')!.templateRef = 'idan-db-sql@2';

    expect(await repository.template('idan-db-sql', 2)).toEqual(expectedTemplateV2);
    expect(await repository.script('escape-room', 2)).toEqual(expectedScriptV2);
    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 2 });
    expect(await database.query(`SELECT script_id, version, status, definition
      FROM catalog.script_versions WHERE version = 1 ORDER BY script_id, version`)).toEqual(beforeV1);
    expect(await database.query(`SELECT key, version, family, engine, status, definition
      FROM catalog.component_templates WHERE version = 1 ORDER BY key, version`)).toEqual(beforeTemplates);

    await publishSqlRoom1(database, imageDigest, driver);
    await Promise.all([
      publishSqlRoom1(database, imageDigest, driver),
      publishSqlRoom1(database, imageDigest, driver),
    ]);

    expect(await database.query('SELECT count(*)::int AS count FROM catalog.script_versions')).toEqual([{ count: 2 }]);
    expect(await database.query('SELECT count(*)::int AS count FROM catalog.component_templates')).toEqual([{ count: 4 }]);
    await expect(repository.seed()).rejects.toThrow('Conflicting script seed');
    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 2 });
    expect(await repository.script('escape-room', 1)).toEqual(room1Script);
  });

  test('rolls back publication when a conflicting v2 template already exists', async () => {
    const database = harness.database!;
    const repository = new CatalogRepository(database);
    await repository.seed();
    const sqlTemplateV1 = room1Templates.find(template => template.key === 'idan-db-sql')!;
    const conflictingDefinition = { ...sqlTemplateV1.definition, imageDigest: 'localhost:5001/room1-sql@sha256:' + 'b'.repeat(64) };
    await database.query(`INSERT INTO catalog.component_templates(key, version, family, engine, definition, status)
      VALUES ($1, 2, $2, $3, $4::jsonb, 'published')`,
    [sqlTemplateV1.key, sqlTemplateV1.family, sqlTemplateV1.engine, JSON.stringify(conflictingDefinition)]);
    const before = await database.query(`SELECT key, version, family, engine, definition, status
      FROM catalog.component_templates ORDER BY key, version`);
    const driver = verifier();

    await expect(publishSqlRoom1(database, imageDigest, driver)).rejects.toThrow();

    expect(driver.preflight).toHaveBeenCalledTimes(1);
    expect(await database.query(`SELECT key, version, family, engine, definition, status
      FROM catalog.component_templates ORDER BY key, version`)).toEqual(before);
    expect(await database.query('SELECT count(*)::int AS count FROM catalog.script_versions')).toEqual([{ count: 1 }]);
    expect(await repository.current('escape-room')).toEqual({ scriptId: 'escape-room', version: 1 });
  });

  test('refuses to publish over a script v1 that differs from the immutable room 1 definition', async () => {
    const database = harness.database!;
    await database.query(`INSERT INTO catalog.scripts(id, slug, current_version)
      VALUES ('escape-room', 'escape-room', 1)`);
    await database.query(`INSERT INTO catalog.script_versions(script_id, version, status, definition)
      VALUES ('escape-room', 1, 'published', '{}'::jsonb)`);
    const driver = verifier();

    await expect(publishSqlRoom1(database, imageDigest, driver)).rejects.toThrow('must match its seed');

    expect(await database.query('SELECT current_version FROM catalog.scripts WHERE id = $1', ['escape-room']))
      .toEqual([{ current_version: 1 }]);
    expect(await database.query('SELECT count(*)::int AS count FROM catalog.script_versions')).toEqual([{ count: 1 }]);
    expect(await database.query('SELECT count(*)::int AS count FROM catalog.component_templates')).toEqual([{ count: 0 }]);
  });
});
