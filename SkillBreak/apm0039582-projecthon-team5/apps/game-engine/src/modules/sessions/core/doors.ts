import type { RejectionReason } from '@team5/contracts';
import type { DoorDef } from '../../script-catalog/catalog.types';
import type { ResolvedScript, Snapshot } from './state';

/**
 * Catalog v3/v4 (Room 1 only) were published before doors became catalog data; their Room 1 door
 * keeps the original destination and unlock puzzle. Catalog v5+ always carries `door` per room.
 */
const LEGACY_DOORS: Record<string, DoorDef> = { 'room-1': { to: 'room-2', unlockedBy: 'dana-login' } };

/** The door of a room, from catalog data (legacy v3/v4 fall back to the Room 1 door). */
export function doorOf(content: ResolvedScript, roomKey: string): DoorDef | undefined {
  const room = content.script.states.find(state => state.key === roomKey);
  if (room?.door) return room.door;
  return content.script.version >= 3 && content.script.version < 5 ? LEGACY_DOORS[roomKey] : undefined;
}

/** Why an OpenDoor/EnterRoom command is rejected, or undefined when it may proceed. */
export function doorRejection(current: Snapshot, content: ResolvedScript, type: 'OpenDoor' | 'EnterRoom',
  roomKey: string, expired: boolean): RejectionReason | undefined {
  if (current.status !== 'Active') return 'sessionEnded';
  if (expired) return 'timeUp';
  const door = content.script.version >= 3 && current.roomKey === roomKey ? doorOf(content, roomKey) : undefined;
  if (!door || !current.puzzles.some(puzzle => puzzle.roomKey === roomKey && puzzle.key === door.unlockedBy && puzzle.status === 'solved')
    || (type === 'EnterRoom' && !current.doors?.[roomKey])) return 'puzzleLocked';
  return undefined;
}

export function isFinalState(content: ResolvedScript, stateKey: string): boolean {
  return content.script.finalStates.includes(stateKey);
}
