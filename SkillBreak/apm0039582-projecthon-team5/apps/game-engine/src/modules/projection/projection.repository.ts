import { Injectable } from '@nestjs/common';
import type { SessionView } from '@team5/contracts';
import type { EntityManager } from 'typeorm';
import { ProjectionDatabase } from './projection-database';

export interface ProjectionRecord {
  ownerId: string;
  version: number;
  revision: string;
  view: SessionView;
}

@Injectable()
export class ProjectionRepository {
  constructor(private readonly database: ProjectionDatabase) {}
  async read(sessionId: string, manager = this.database.source.manager): Promise<ProjectionRecord | null> {
    const rows: ProjectionRecord[] = await manager.query(
      'SELECT owner_id AS "ownerId", version, revision::text, view FROM team5.session_view WHERE session_id=$1', [sessionId]);
    return rows[0] ?? null;
  }
  async save(manager: EntityManager, ownerId: string, view: SessionView): Promise<void> {
    const rows: { session_id: string }[] = await manager.query(`INSERT INTO team5.session_view
      (session_id,owner_id,version,revision,view) VALUES ($1,$2,$3,1,$4)
      ON CONFLICT (session_id) DO UPDATE SET version=EXCLUDED.version,
        revision=team5.session_view.revision+1, view=EXCLUDED.view, updated_at=now()
      WHERE team5.session_view.owner_id=EXCLUDED.owner_id RETURNING session_id`,
    [view.sessionId, ownerId, view.version, JSON.stringify(view)]);
    if (!rows.length) throw new Error('Projection ownership conflict');
  }
}
