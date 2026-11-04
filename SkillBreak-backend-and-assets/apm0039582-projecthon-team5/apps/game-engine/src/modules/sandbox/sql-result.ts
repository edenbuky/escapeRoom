import { ExecResult } from './sandbox.contracts';
import { SandboxExecutionError } from './sandbox-errors';

function invalid(): never {
  throw new SandboxExecutionError('runtimeUnavailable');
}

function decodeCell(cell: string): string | null {
  if (cell === '\\N') return null;
  return cell.replace(/\\(.)|\\/g, (_match, escaped: string | undefined) => {
    switch (escaped) {
      case '\\': return '\\';
      case 't': return '\t';
      case 'r': return '\r';
      case 'n': return '\n';
      default: return invalid();
    }
  });
}

export function decodeSqlRows(stdout: string): (string | null)[][] {
  if (!stdout) return [];
  if (!stdout.endsWith('\n') || stdout.includes('\r') || stdout.includes('\0')) return invalid();
  const records = stdout.slice(0, -1).split('\n').map(record => record.split('\t').map(decodeCell));
  const header = records.shift();
  if (!header || header.some(cell => cell === null)
    || records.some(record => record.length !== header.length)) return invalid();
  return records;
}

export function validateHelperResult(value: unknown, commandId: string): ExecResult {
  if (!value || typeof value !== 'object'
    || !('version' in value) || value.version !== 1
    || !('commandId' in value) || value.commandId !== commandId
    || !('stdout' in value) || typeof value.stdout !== 'string'
    || !('stderr' in value) || typeof value.stderr !== 'string'
    || !('exitCode' in value) || (value.exitCode !== null
      && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode)))
    || !('timedOut' in value) || typeof value.timedOut !== 'boolean'
    || !('truncated' in value) || typeof value.truncated !== 'boolean') return invalid();
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 512 * 1024
      || Buffer.byteLength(value.stdout, 'utf8') + Buffer.byteLength(value.stderr, 'utf8') > 65536) return invalid();
  } catch {
    return invalid();
  }
  if (value.exitCode === 0 && !value.timedOut && !value.truncated && value.stdout === '') return invalid();
  if (value.timedOut && value.exitCode !== null) return invalid();
  decodeSqlRows(value.stdout);
  return {
    commandId, stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode,
    timedOut: value.timedOut, truncated: value.truncated,
  };
}
