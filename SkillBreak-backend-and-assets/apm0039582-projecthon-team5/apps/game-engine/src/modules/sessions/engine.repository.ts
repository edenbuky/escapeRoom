import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { PuzzleState, Snapshot } from './core/state';

export class VersionConflict extends Error {}

@Injectable()
export class EngineRepository {
  async load(manager: EntityManager, sessionId: string): Promise<Snapshot | null> {
    const rows: { state: Omit<Snapshot, 'puzzles'> }[] = await manager.query('SELECT state FROM sessions WHERE id = $1', [sessionId]);
    if (!rows[0]) return null;
    const puzzles: { state: PuzzleState }[] = await manager.query(
      'SELECT state FROM session_puzzles WHERE session_id = $1 ORDER BY puzzle_key', [sessionId]);
    return { ...rows[0].state, puzzles: puzzles.map(row => row.state) };
  }

  async save(manager: EntityManager, snapshot: Snapshot, previousVersion: number | undefined, now: Date): Promise<void> {
    const { puzzles, ...state } = snapshot;
    if (previousVersion === undefined) {
      const inserted = await manager.query(`INSERT INTO sessions(id, owner_id, script_id, script_version, version, state, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [snapshot.id, snapshot.ownerId, snapshot.scriptId, snapshot.scriptVersion, snapshot.version, JSON.stringify(state), now]);
      if (!inserted.length) throw new VersionConflict('Session already exists');
    } else {
      const updated = await manager.query(`UPDATE sessions SET version=$2, state=$3, last_seen_at=$4
        WHERE id=$1 AND version=$5 RETURNING id`, [snapshot.id, snapshot.version, JSON.stringify(state), now, previousVersion]);
      if (!updated[0]?.length) throw new VersionConflict('Session version changed');
    }
    for (const puzzle of puzzles) {
      await manager.query(`INSERT INTO session_puzzles(session_id,puzzle_key,state) VALUES ($1,$2,$3)
        ON CONFLICT (session_id,puzzle_key) DO UPDATE SET state=EXCLUDED.state`, [snapshot.id, puzzle.key, JSON.stringify(puzzle)]);
    }
  }
}