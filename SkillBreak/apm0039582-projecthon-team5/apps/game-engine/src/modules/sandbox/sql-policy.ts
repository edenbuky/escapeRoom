import { parse } from 'pgsql-ast-parser';
import { SandboxExecutionError } from './sandbox-errors';

export function validateSql(command: string, maxQueryChars = 4096): void {
  if (typeof command !== 'string' || !Number.isInteger(maxQueryChars) || maxQueryChars < 1
    || !command.trim() || command.includes('\0') || command.length > Math.min(4096, maxQueryChars)) {
    throw new SandboxExecutionError('policyBlocked');
  }
  let count: number;
  try {
    count = parse(command).length;
  } catch {
    let empty: boolean;
    try {
      // The parser rejects comment-only input. A complete prefix distinguishes it without splitting SQL text.
      empty = parse(`SELECT 1;\n${command}`).length === 1;
    } catch { throw new SandboxExecutionError('syntaxError'); }
    throw new SandboxExecutionError(empty ? 'policyBlocked' : 'syntaxError');
  }
  if (count !== 1) throw new SandboxExecutionError('policyBlocked');
}
