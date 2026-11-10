/**
 * Room-1 facts the session view stops showing once the player is in room 2, kept per game session.
 * Saved in sessionStorage so a reload keeps them; a page-local copy keeps them when storage is unavailable.
 */
interface Room1Progress {
  /** The hash puzzle was seen solved; drives the "password cracked" inventory note. */
  passwordCracked: boolean;
  /** Dana's desktop stays open after the move to room 2 until the player clicks "open room". */
  danaDesktopOpen: boolean;
}

const EMPTY: Room1Progress = { passwordCracked: false, danaDesktopOpen: false };
const pageCopy = new Map<string, Room1Progress>();
const storageKey = (sessionId: string) => `t5-room-1-progress:${sessionId}`;

export function readRoom1Progress(sessionId: string): Room1Progress {
  const kept = pageCopy.get(sessionId);
  if (kept) return kept;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(sessionId)) ?? 'null') as Partial<Room1Progress> | null;
    return { passwordCracked: saved?.passwordCracked === true, danaDesktopOpen: saved?.danaDesktopOpen === true };
  } catch {
    return EMPTY;
  }
}

function save(sessionId: string, change: Partial<Room1Progress>) {
  const progress = { ...readRoom1Progress(sessionId), ...change };
  pageCopy.set(sessionId, progress);
  try {
    sessionStorage.setItem(storageKey(sessionId), JSON.stringify(progress));
  } catch {
    // Storage blocked or full: the page copy still holds the progress until the page unloads.
  }
}

export function markPasswordCracked(sessionId: string) {
  save(sessionId, { passwordCracked: true });
}

/** Used by RoomFrame: open when Dana's login is seen solved, closed when the player clicks "open room". */
export function setDanaDesktopOpen(sessionId: string, open: boolean) {
  save(sessionId, { danaDesktopOpen: open });
}
