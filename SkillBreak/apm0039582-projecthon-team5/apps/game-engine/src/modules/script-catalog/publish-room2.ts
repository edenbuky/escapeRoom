import { DataSource, type EntityManager } from 'typeorm';
import { databaseOptions, loadEngineConfig } from '../../config/config';
import type { ComponentTemplateDto, ScriptVersionDto } from './catalog.types';
import { room1GameplayScript } from './room1';
import { ROOM2_SCRIPT_VERSION, room2Script, room2Templates } from './room2';
import { sameJsonValue } from './publish-sql-room1';

type CatalogTransaction = Pick<EntityManager, 'query'>;

const GAMEPLAY_VERSION = 4;

/** Catalog 4 as publishGameplay publishes it once SQL template 2 exists. */
function gameplayV4(): ScriptVersionDto {
  const definition = structuredClone(room1GameplayScript);
  definition.version = GAMEPLAY_VERSION;
  definition.states[0].puzzles[0].templateRef = 'idan-db-sql@2';
  return definition;
}

async function verifyGameplay(manager: CatalogTransaction): Promise<ScriptVersionDto> {
  const scripts = await manager.query('SELECT current_version FROM team5.scripts WHERE id = $1 FOR UPDATE', [room1GameplayScript.scriptId]);
  if (scripts.length !== 1 || ![GAMEPLAY_VERSION, ROOM2_SCRIPT_VERSION].includes(Number(scripts[0].current_version))) {
    throw new Error('Gameplay catalog 4 must be published first');
  }
  const rows = await manager.query('SELECT status, definition FROM team5.script_versions WHERE script_id = $1 AND version = $2',
    [room1GameplayScript.scriptId, GAMEPLAY_VERSION]);
  if (rows.length !== 1 || rows[0].status !== 'published' || !sameJsonValue(rows[0].definition, gameplayV4())) {
    throw new Error('Gameplay script v4 is missing or does not match its seed');
  }
  const sql = await manager.query(`SELECT 1 FROM team5.component_templates
    WHERE key = 'idan-db-sql' AND version = 2 AND status = 'published'`);
  if (sql.length !== 1) throw new Error('SQL template idan-db-sql@2 is missing');
  return rows[0].definition;
}

async function insertAndVerifyTemplate(manager: CatalogTransaction, template: ComponentTemplateDto): Promise<void> {
  await manager.query(`INSERT INTO team5.component_templates(key, version, family, engine, definition, status)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'published') ON CONFLICT DO NOTHING`,
  [template.key, template.version, template.family, template.engine, JSON.stringify(template.definition)]);
  const rows = await manager.query(`SELECT family, engine, status, definition FROM team5.component_templates
    WHERE key = $1 AND version = $2`, [template.key, template.version]);
  if (rows.length !== 1 || rows[0].family !== template.family || rows[0].engine !== template.engine
    || rows[0].status !== 'published' || !sameJsonValue(rows[0].definition, template.definition)) {
    throw new Error(`Conflicting Room 2 template ${template.key}@${template.version} publication`);
  }
}

async function insertAndVerifyScript(manager: CatalogTransaction, definition: ScriptVersionDto): Promise<void> {
  await manager.query(`INSERT INTO team5.script_versions(script_id, version, status, definition, published_at)
    VALUES ($1, $2, 'published', $3::jsonb, now()) ON CONFLICT DO NOTHING`,
  [definition.scriptId, definition.version, JSON.stringify(definition)]);
  const rows = await manager.query('SELECT status, definition FROM team5.script_versions WHERE script_id = $1 AND version = $2',
    [definition.scriptId, definition.version]);
  if (rows.length !== 1 || rows[0].status !== 'published' || !sameJsonValue(rows[0].definition, definition)) {
    throw new Error('Conflicting Room 2 script v5 publication');
  }
}

/** Publishes the Room 2 templates and script v5 in one transaction; identical content is a no-op. */
export async function publishRoom2(database: DataSource, templates = room2Templates()): Promise<void> {
  await database.transaction(async manager => {
    const gameplay = await verifyGameplay(manager);
    for (const template of templates) await insertAndVerifyTemplate(manager, template);
    await insertAndVerifyScript(manager, room2Script(gameplay));
    await manager.query('UPDATE team5.scripts SET current_version = $2 WHERE id = $1 AND current_version < $2',
      [room1GameplayScript.scriptId, ROOM2_SCRIPT_VERSION]);
  });
}

async function runPublication(): Promise<void> {
  const database = new DataSource(databaseOptions(loadEngineConfig()));
  try {
    await database.initialize();
    await publishRoom2(database);
  } finally {
    if (database.isInitialized) await database.destroy();
  }
}

if (require.main === module) {
  void runPublication().catch(() => {
    process.stderr.write('Room 2 catalog publication failed; check gameplay catalog 4, migrations and immutable versions.\n');
    process.exitCode = 1;
  });
}
