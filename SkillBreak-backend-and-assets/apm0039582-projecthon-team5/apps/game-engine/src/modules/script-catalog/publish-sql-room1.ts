import { DataSource, type EntityManager } from 'typeorm';
import { isDeepStrictEqual } from 'node:util';
import { databaseOptions, loadEngineConfig } from '../../config/config';
import { SandboxExecutionError } from '../sandbox/sandbox-errors';
import { KubernetesDriver } from '../sandbox/kubernetes-driver';
import type { ComponentTemplateDto, ScriptVersionDto } from './catalog.types';
import { room1Script, room1Templates } from './room1';

type CatalogTransaction = Pick<EntityManager, 'query'>;

function assertDefinition(actual: unknown, expected: unknown, message: string): void {
  if (!sameJsonValue(actual, expected)) throw new Error(message);
}

function sameJsonValue(actual: unknown, expected: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  } catch {
    return false;
  }
}

function scriptV2(): ScriptVersionDto {
  const definition = structuredClone(room1Script);
  definition.version = 2;
  const sqlPuzzle = definition.states.flatMap(state => state.puzzles).filter(puzzle => puzzle.key === 'idan-db');
  if (sqlPuzzle.length !== 1) throw new Error('Room 1 SQL puzzle definition is inconsistent');
  sqlPuzzle[0].templateRef = 'idan-db-sql@2';
  return definition;
}

function templateV2(imageDigest: string): ComponentTemplateDto {
  const template = room1Templates.find(value => value.key === 'idan-db-sql');
  if (!template || template.family !== 'sandbox' || template.engine !== 'sql') {
    throw new Error('Room 1 SQL template definition is inconsistent');
  }
  return {
    ...structuredClone(template),
    version: 2,
    definition: { ...template.definition, imageDigest },
  };
}

async function verifyBaseline(manager: CatalogTransaction): Promise<number> {
  const scripts = await manager.query(`SELECT id, slug, current_version FROM catalog.scripts
    WHERE id = $1 FOR UPDATE`, [room1Script.scriptId]);
  if (scripts.length !== 1 || scripts[0].slug !== 'escape-room'
    || ![1, 2].includes(Number(scripts[0].current_version))) {
    throw new Error('Room 1 script seed is missing or conflicting');
  }

  const scriptRows = await manager.query(`SELECT status, definition FROM catalog.script_versions
    WHERE script_id = $1 AND version = 1`, [room1Script.scriptId]);
  if (scriptRows.length !== 1 || scriptRows[0].status !== 'published') {
    throw new Error('Room 1 script v1 is missing or conflicting');
  }
  assertDefinition(scriptRows[0].definition, room1Script, 'Room 1 script v1 is immutable and must match its seed');

  for (const template of room1Templates) {
    const rows = await manager.query(`SELECT family, engine, status, definition FROM catalog.component_templates
      WHERE key = $1 AND version = 1`, [template.key]);
    if (rows.length !== 1 || rows[0].family !== template.family || rows[0].engine !== template.engine
      || rows[0].status !== 'published') {
      throw new Error(`Room 1 template ${template.key}@1 is missing or conflicting`);
    }
    assertDefinition(rows[0].definition, template.definition, `Room 1 template ${template.key}@1 is immutable and must match its seed`);
  }
  return Number(scripts[0].current_version);
}

async function insertAndVerifyTemplate(manager: CatalogTransaction, template: ComponentTemplateDto): Promise<void> {
  const values = [template.key, template.version, template.family, template.engine, JSON.stringify(template.definition)];
  await manager.query(`INSERT INTO catalog.component_templates(key, version, family, engine, definition, status)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'published') ON CONFLICT DO NOTHING`, values);
  const rows = await manager.query(`SELECT family, engine, status, definition FROM catalog.component_templates
    WHERE key = $1 AND version = $2`, [template.key, template.version]);
  if (rows.length !== 1 || rows[0].family !== template.family || rows[0].engine !== template.engine
    || rows[0].status !== 'published' || !sameJsonValue(rows[0].definition, template.definition)) {
    throw new Error('Conflicting SQL template v2 publication');
  }
}

async function insertAndVerifyScript(manager: CatalogTransaction, definition: ScriptVersionDto): Promise<void> {
  await manager.query(`INSERT INTO catalog.script_versions(script_id, version, status, definition, published_at)
    VALUES ($1, 2, 'published', $2::jsonb, now()) ON CONFLICT DO NOTHING`,
  [definition.scriptId, JSON.stringify(definition)]);
  const rows = await manager.query(`SELECT status, definition FROM catalog.script_versions
    WHERE script_id = $1 AND version = 2`, [definition.scriptId]);
  if (rows.length !== 1 || rows[0].status !== 'published'
    || !sameJsonValue(rows[0].definition, definition)) {
    throw new Error('Conflicting SQL script v2 publication');
  }
}

export async function publishSqlRoom1(
  database: DataSource,
  imageDigest: string,
  driver: Pick<KubernetesDriver, 'preflight'>,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/.test(imageDigest)
    || imageDigest.includes('..')) {
    throw new SandboxExecutionError('imageNotPinned');
  }

  await driver.preflight(imageDigest);

  await database.transaction(async manager => {
    const currentVersion = await verifyBaseline(manager);
    await insertAndVerifyTemplate(manager, templateV2(imageDigest));
    await insertAndVerifyScript(manager, scriptV2());
    if (currentVersion === 1) {
      await manager.query(`UPDATE catalog.scripts SET current_version = 2
        WHERE id = $1 AND current_version = 1`, [room1Script.scriptId]);
      const pointer = await manager.query('SELECT current_version FROM catalog.scripts WHERE id = $1',
        [room1Script.scriptId]);
      if (pointer.length !== 1 || Number(pointer[0].current_version) !== 2) {
        throw new Error('Room 1 current script pointer changed during publication');
      }
    }
  });
}

function imageArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--image' || !args[1]) {
    throw new Error('Expected --image <allowlisted-repository>@sha256:<manifest-digest>');
  }
  return args[1];
}

async function runPublication(args: string[]): Promise<void> {
  const imageDigest = imageArgument(args);
  const config = loadEngineConfig();
  if (!process.env.SANDBOX_RUNTIME_CLASS?.trim() || config.sandbox.imageAllowlist.length === 0) {
    throw new Error('Explicit sandbox runtime and image allowlist configuration are required');
  }

  const database = new DataSource(databaseOptions(config));
  try {
    await database.initialize();
    const driver = new KubernetesDriver({
      runtimeClass: config.runtimeClass,
      kubeContext: config.sandbox.kubeContext,
      imageAllowlist: config.sandbox.imageAllowlist,
    });
    await publishSqlRoom1(database, imageDigest, driver);
  } finally {
    if (database.isInitialized) await database.destroy();
  }
}

if (require.main === module) {
  void runPublication(process.argv.slice(2)).catch(() => {
    process.stderr.write('SQL sandbox catalog publication failed; verify the image, runtime, migrations, and catalog state.\n');
    process.exitCode = 1;
  });
}
