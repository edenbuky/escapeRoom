import type { RoomFile } from '@team5/contracts';
import type { CatalogFile, StateDef } from '../../script-catalog/catalog.types';
import type { Snapshot } from './state';

/** Strips catalog-only fields (revealedBy) so they never reach events, snapshots views or the player. */
export function publicFiles(files: CatalogFile[]): RoomFile[] {
  return files.map(file => ({ name: file.name, content: file.content }));
}

/** Per-session file contents of a room; falls back to the catalog content when the session has none yet. */
export function currentFiles(snapshot: Snapshot, room: StateDef): RoomFile[] {
  return structuredClone(snapshot.roomFiles?.[room.key] ?? publicFiles(room.files));
}

/** Initializes the per-session contents from the catalog (on session start / RoomEntered). */
export function initRoomFiles(snapshot: Snapshot, room: StateDef): void {
  snapshot.roomFiles = { ...snapshot.roomFiles, [room.key]: publicFiles(room.files) };
}

/**
 * On a solve of `puzzleKey`, every file whose catalog entry has revealedBy === puzzleKey takes the reveal
 * content supplied by the evaluation (a string for every such file, or a map by file name). Returns the
 * names of the files that changed.
 */
export function revealFiles(snapshot: Snapshot, room: StateDef, puzzleKey: string,
  reveal: string | Record<string, string> | undefined): string[] {
  if (reveal === undefined) return [];
  const files = currentFiles(snapshot, room);
  const changed: string[] = [];
  for (const entry of room.files) {
    if (entry.revealedBy !== puzzleKey) continue;
    const content = typeof reveal === 'string' ? reveal : reveal[entry.name];
    const file = files.find(candidate => candidate.name === entry.name);
    if (content === undefined || !file) continue;
    file.content = content;
    changed.push(file.name);
  }
  snapshot.roomFiles = { ...snapshot.roomFiles, [room.key]: files };
  return changed;
}
