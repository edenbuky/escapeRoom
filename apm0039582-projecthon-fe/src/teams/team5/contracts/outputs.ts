/** Browser-safe input contract; keep aligned with packages/contracts. */
export type PuzzleInput =
  | { kind: 'command'; command: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'credentials'; username: string; password: string };

export type PuzzleOutput = string;