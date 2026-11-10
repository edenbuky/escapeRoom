import type { RepositoryState } from './sandbox.contracts';

export interface GitInvariants { branch: string; headOid: string; keyCommitOid: string }

/**
 * The first broken template invariant of a git sandbox, or undefined when the repository is still intact.
 * Reading old revisions (a detached HEAD on the fixture history) is allowed; changing the history is not.
 */
export function failedGitInvariant(state: RepositoryState, invariants: GitInvariants): string | undefined {
  if (state.branchTip === null) return 'branchPresent';
  if (state.branchTip !== invariants.headOid) return 'headUnchanged'; // new commit on the branch, reset, rewrite
  if (!state.headInHistory) return 'noNewCommits'; // a commit made off the branch (detached HEAD or another branch)
  if (!state.keyCommitPresent) return 'keyRemovalCommitPresent';
  return undefined;
}
