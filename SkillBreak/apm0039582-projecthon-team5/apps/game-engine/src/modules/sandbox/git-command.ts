/**
 * Command-line policy of the embedded git terminal (Room 2, `terminal-git`). There is no shell: one line is
 * split into words and matched against the template's allowlist; anything that would need a real shell
 * (pipes, redirection, command chaining, substitution) is blocked before anything runs.
 */
export interface GitPolicy {
  allowedCommands: string[];
  allowedGitSubcommands: string[];
  maxCommandChars: number;
}

export type ParsedCommand =
  | { ok: true; program: string; args: string[] }
  | { ok: false; kind: 'blocked' }
  | { ok: false; kind: 'syntax'; message: string };

/** Where the working copy lives inside the sandbox (what `pwd` prints; the prompt shows it as ~/project_cibus_payment). */
export const gitRepositoryDir = '/home/netanel/project_cibus_payment';

/** The Room 2 policy: read-oriented git plus a few shell basics. The `nethanel-git` template publishes the same values. */
export const room2GitPolicy: GitPolicy & { singleCommand: true } = {
  allowedCommands: ['git', 'ls', 'cat', 'pwd', 'help'],
  allowedGitSubcommands: ['log', 'show', 'status', 'diff', 'branch', 'add', 'commit', 'checkout', 'reset'],
  singleCommand: true,
  maxCommandChars: 4096,
};

// Shell metacharacters: pipes, redirection, chaining, background, substitution, grouping, escapes, newlines.
const shellSyntax = /[|;&<>`$(){}\\\n\r\0]/;

export function parseCommandLine(line: unknown, policy: GitPolicy): ParsedCommand {
  const blocked = { ok: false, kind: 'blocked' } as const;
  if (typeof line !== 'string' || !line.trim() || line.length > Math.min(4096, policy.maxCommandChars)
    || shellSyntax.test(line)) return blocked;
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined; else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === ' ' || char === '\t') {
      if (started || word) words.push(word);
      word = '';
      started = false;
    } else word += char;
  }
  if (quote) return { ok: false, kind: 'syntax', message: `Unterminated quote: ${quote}` };
  if (started || word) words.push(word);
  const [program, ...args] = words;
  if (!program || !policy.allowedCommands.includes(program)) return blocked;
  if (program === 'git') {
    const rest = args[0] === '--no-pager' ? args.slice(1) : args;
    if (rest.length && !policy.allowedGitSubcommands.includes(rest[0])) return blocked;
    return { ok: true, program, args: rest };
  }
  return { ok: true, program, args };
}
