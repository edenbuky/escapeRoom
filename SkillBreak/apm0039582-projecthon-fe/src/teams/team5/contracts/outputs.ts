/** Browser-safe input contract; keep aligned with packages/contracts. */
export type PuzzleInput =
  | { kind: 'command'; command: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'credentials'; username: string; password: string }
  | { kind: 'rsa'; privateKey: string; encryptedPms: string; modulus: string }
  | { kind: 'tls'; pms: string; clientRandom: string };

export type PuzzleOutput = string;