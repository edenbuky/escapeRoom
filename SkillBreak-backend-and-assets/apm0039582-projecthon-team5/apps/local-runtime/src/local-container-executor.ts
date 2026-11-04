import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EngineAppOptions } from '@team5/game-engine/bootstrap';
// Q20 option (b): relative imports of the compiled engine, with no engine change (recorded limitation).
// Option (a) replaces these two lines with one import from an engine export.
import { SandboxExecutionError } from '../../game-engine/dist/modules/sandbox/sandbox-errors';
import { validateHelperResult } from '../../game-engine/dist/modules/sandbox/sql-result';

type SandboxExecutor = NonNullable<EngineAppOptions['executor']>;

// Default Compose name for the sql-sandbox service of the projecthon-team5 project (demo-local profile).
const container = 'projecthon-team5-sql-sandbox-1';

export class LocalContainerExecutor implements SandboxExecutor {
  async execute({ commandId, command }: Parameters<SandboxExecutor['execute']>[0]) {
    const json = JSON.stringify({ version: 1, executionToken: randomUUID(), commandId, command });
    const value = await new Promise<unknown>((resolve, reject) => {
      const stdout: Buffer[] = [];
      let size = 0;
      let done = false;
      const child = spawn('docker', ['exec', '-i', container, 'node', '/opt/sql/query-helper.mjs', 'query'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
      const finish = (error?: SandboxExecutionError, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) { child.kill(); reject(error); } else resolve(result);
      };
      const timer = setTimeout(() => finish(new SandboxExecutionError('runtimeUnavailable')), 5500);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) finish(new SandboxExecutionError('runtimeUnavailable'));
        else stdout.push(chunk);
      });
      child.on('error', () => finish(new SandboxExecutionError('runtimeUnavailable')));
      child.on('close', code => {
        if (code !== 0) { finish(new SandboxExecutionError('runtimeUnavailable')); return; }
        try { finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
        catch { finish(new SandboxExecutionError('runtimeUnavailable')); }
      });
      child.stdin.on('error', () => finish(new SandboxExecutionError('runtimeUnavailable')));
      child.stdin.end(json);
    });
    return validateHelperResult(value, commandId);
  }
}
