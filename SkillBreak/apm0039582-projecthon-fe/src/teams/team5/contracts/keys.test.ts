import type { PuzzleInput } from './outputs';
import { ROOM_2_FILE_NAME, ROOM_2_PUZZLE_KEYS, ROOM_KEYS } from './keys';

describe('room 2 contract constants', () => {
  it('names the frozen puzzle keys, room key and room file (tasks.md section 5)', () => {
    expect(ROOM_KEYS.room2).toBe('room-2');
    expect(Object.values(ROOM_2_PUZZLE_KEYS)).toEqual(['nethanel-git', 'rsa-decryptor', 'tls-decryptor', 'door']);
    expect(ROOM_2_FILE_NAME).toBe('Cibus_payment_try.pcap');
  });

  it('accepts exactly the frozen room 2 inputs', () => {
    const inputs: PuzzleInput[] = [
      { kind: 'command', command: 'git log' },
      { kind: 'rsa', privateKey: 'k', encryptedPms: 'e', modulus: 'n' },
      { kind: 'tls', pms: 'p', clientRandom: 'r' },
      { kind: 'answer', answer: '1234' },
    ];
    expect(inputs.map(input => input.kind)).toEqual(['command', 'rsa', 'tls', 'answer']);
  });
});
