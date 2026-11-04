const messages = {
  invalidIdentity: 'Invalid sandbox identity.',
  staleGeneration: 'Sandbox generation is no longer current.',
  commandConflict: 'Command identity conflicts with an accepted execution.',
  inProgress: 'This command is still in progress.',
  busy: 'Another command is using this sandbox. Retry later.',
  expired: 'Sandbox lease or maximum lifetime has expired.',
  notReady: 'Sandbox is not ready.',
  interrupted: 'Accepted execution was interrupted and will not be repeated.',
  policyBlocked: 'SQL submission is not allowed by the puzzle policy.',
  syntaxError: 'SQL syntax is invalid or unsupported.',
  runtimeUnavailable: 'Sandbox runtime is unavailable.',
  preflightControlUnavailable: 'A sandbox isolation positive-control target is unreachable.',
  isolationFailed: 'Sandbox isolation or resource enforcement could not be verified.',
  ownershipConflict: 'Sandbox resource ownership does not match.',
  imageNotPinned: 'Sandbox requires an allowed immutable image digest.',
  templateMismatch: 'Sandbox template does not match the pinned puzzle.',
  provisionTimeout: 'Sandbox provisioning exceeded its original sixty-second deadline.',
  readinessFailed: 'Sandbox fixture readiness could not be verified within its persisted budget.',
  persistenceFailure: 'Sandbox state could not be durably recorded.',
  lockCleanupFailed: 'Sandbox lock cleanup failed; new admission is fenced.',
  capacityExceeded: 'Sandbox connection capacity is busy. Retry later.',
  stopped: 'Sandbox admission has stopped.',
} as const;

export type SandboxErrorCode = keyof typeof messages;

export class SandboxExecutionError extends Error {
  constructor(readonly code: SandboxErrorCode) {
    super(messages[code]);
    this.name = 'SandboxExecutionError';
  }
}
