/** progress: goal unmet; solved: goal met; rejected: not accepted; ruined: invariant broken. */
export type Verdict = 'progress' | 'solved' | 'rejected' | 'ruined';
export type SessionStatus = 'Active' | 'Escaped' | 'Expired' | 'Abandoned';
export type PuzzleStatus = 'locked' | 'open' | 'solved';
export type SandboxStatus = 'none' | 'provisioning' | 'ready' | 'failed';
export type PuzzleFamily = 'sql' | 'terminal-git' | 'hash' | 'rsa' | 'tls' | 'answer';
export type RejectionReason =
  | 'wrongAnswer' | 'policyBlocked' | 'sandboxRestarting'
  | 'timeUp' | 'noHint' | 'puzzleLocked' | 'sessionEnded';
export type PuzzleInput =
  | { kind: 'command'; command: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'credentials'; username: string; password: string }
  | { kind: 'rsa'; privateKey: string; encryptedPms: string; modulus: string }
  | { kind: 'tls'; pms: string; clientRandom: string };
