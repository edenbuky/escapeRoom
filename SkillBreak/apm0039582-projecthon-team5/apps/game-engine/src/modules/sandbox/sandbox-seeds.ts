/** Seeds a sandbox may be provisioned from, and the puzzle template allowed to use each. */
const seeds: Record<string, RegExp> = {
  'room1-sql-v1': /^idan-db-sql@[1-9][0-9]*$/,
  'room2-git-v1': /^nethanel-git@[1-9][0-9]*$/,
};

export function isAllowedSeed(seedRef: string | null, policyRef: string): boolean {
  return seedRef !== null && Object.hasOwn(seeds, seedRef) && seeds[seedRef].test(policyRef);
}

/** Engines (puzzle families) that run in a sandbox instead of being evaluated in process. */
export const sandboxEngines: readonly string[] = ['sql', 'terminal-git'];

export function isSandboxEngine(engine: string): boolean {
  return sandboxEngines.includes(engine);
}
