import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ComponentTemplateDto, ScriptVersionDto } from './catalog.types';
import { room1Script, room1Templates } from './room1';

@Injectable()
export class CatalogRepository {
  constructor(private readonly database: DataSource) {}

  async current(slug: string): Promise<{ scriptId: string; version: number } | undefined> {
    const rows = await this.database.query(`SELECT scripts.id AS "scriptId", scripts.current_version AS version FROM catalog.scripts scripts
      JOIN catalog.script_versions versions ON versions.script_id = scripts.id AND versions.version = scripts.current_version
      WHERE scripts.slug = $1 AND versions.status = 'published'`, [slug]);
    return rows[0];
  }
  async script(id: string, version: number): Promise<ScriptVersionDto | undefined> {
    const rows = await this.database.query(`SELECT definition FROM catalog.script_versions
      WHERE script_id = $1 AND version = $2 AND status = 'published'`, [id, version]);
    return rows[0]?.definition;
  }
  async template(key: string, version: number): Promise<ComponentTemplateDto | undefined> {
    const rows = await this.database.query(`SELECT key, version, family, engine, definition FROM catalog.component_templates
      WHERE key = $1 AND version = $2 AND status = 'published'`, [key, version]);
    return rows[0];
  }
  async seed(): Promise<void> {
    await this.database.transaction(async manager => {
      await manager.query(`INSERT INTO catalog.scripts(id, slug, current_version) VALUES ('escape-room', 'escape-room', 1)
        ON CONFLICT DO NOTHING`);
      const scripts = await manager.query(`SELECT id FROM catalog.scripts WHERE id = 'escape-room' AND slug = 'escape-room' AND current_version = 1`);
      if (scripts.length !== 1) throw new Error('Conflicting script seed');
      await manager.query(`INSERT INTO catalog.script_versions(script_id, version, status, definition, published_at)
        VALUES ($1, $2, 'published', $3, now()) ON CONFLICT DO NOTHING`,
      [room1Script.scriptId, room1Script.version, JSON.stringify(room1Script)]);
      const versions = await manager.query(`SELECT version FROM catalog.script_versions
        WHERE script_id = $1 AND version = $2 AND status = 'published' AND definition = $3::jsonb`,
      [room1Script.scriptId, room1Script.version, JSON.stringify(room1Script)]);
      if (versions.length !== 1) throw new Error('Conflicting script version seed');
      for (const template of room1Templates) {
        const values = [template.key, template.version, template.family, template.engine, JSON.stringify(template.definition)];
        await manager.query(`INSERT INTO catalog.component_templates(key, version, family, engine, definition, status)
          VALUES ($1, $2, $3, $4, $5, 'published') ON CONFLICT DO NOTHING`, values);
        const rows = await manager.query(`SELECT key FROM catalog.component_templates WHERE key = $1 AND version = $2
          AND family = $3 AND engine = $4 AND definition = $5::jsonb AND status = 'published'`, values);
        if (rows.length !== 1) throw new Error('Conflicting template seed');
      }
    });
  }
}