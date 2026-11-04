export type Verdict = 'progress' | 'solved' | 'rejected' | 'ruined';
export type RejectionReason = 'wrongAnswer' | 'policyBlocked' | 'sandboxRestarting'
  | 'timeUp' | 'noHint' | 'puzzleLocked' | 'sessionEnded';
export type SessionStatus = 'Active' | 'Escaped' | 'Expired' | 'Abandoned';
export type PuzzleStatus = 'locked' | 'open' | 'solved';
export type SandboxStatus = 'none' | 'provisioning' | 'ready' | 'failed';
export type PuzzleFamily = 'sql' | 'terminal-git' | 'hash' | 'rsa' | 'tls' | 'answer';