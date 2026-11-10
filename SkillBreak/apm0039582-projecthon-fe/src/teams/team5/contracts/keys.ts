/** Room and puzzle keys the session view uses; keep aligned with the game-engine catalog (DESIGN §13). */
export const ROOM_KEYS = { room1: 'room-1', room2: 'room-2' } as const;

export const ROOM_1_PUZZLE_KEYS = { sql: 'idan-db', hash: 'hash-cracker', login: 'dana-login' } as const;

/** Room 2 opening order: nethanel-git (open at entry) -> rsa-decryptor -> tls-decryptor -> door. */
export const ROOM_2_PUZZLE_KEYS = {
  git: 'nethanel-git',
  rsa: 'rsa-decryptor',
  tls: 'tls-decryptor',
  door: 'door',
} as const;

/** The only room-2 file; its content is replaced when `tls-decryptor` is solved (`revealedBy`). */
export const ROOM_2_FILE_NAME = 'Cibus_payment_try.pcap';
