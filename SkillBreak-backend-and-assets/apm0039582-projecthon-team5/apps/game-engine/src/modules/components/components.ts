import { createHash, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { describeFailure } from '@team5/messaging';
import type { ComponentTemplateDto } from '../script-catalog/catalog.types';
import type { SandboxExecutor } from '../sandbox/sandbox.contracts';
import { sandboxIdentity } from '../sessions/core/ids';
import type { Evaluation, PuzzleState, Snapshot } from '../sessions/core/state';
import type { HashPool } from './hash-pool';
import { SandboxExecutionError } from '../sandbox/sandbox-errors';
import { validateSql } from '../sandbox/sql-policy';
import { decodeSqlRows } from '../sandbox/sql-result';

const invalid: Evaluation = { verdict: 'rejected', reason: 'policyBlocked', output: '' };
const unavailable: Evaluation = { verdict: 'rejected', reason: 'sandboxRestarting', output: '' };

export class ComponentFactory {
  private readonly logger = new Logger(ComponentFactory.name);
  constructor(private readonly sandbox: SandboxExecutor | undefined, private readonly hashes: Pick<HashPool, 'compare'>) {}

  async evaluate(template: ComponentTemplateDto, snapshot: Snapshot, puzzle: PuzzleState,
    commandId: string, input: unknown): Promise<Evaluation> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid;
    const fields = input as Record<string, unknown>;
    if (template.engine === 'sql') {
      if (Object.keys(fields).length !== 2 || fields.kind !== 'command' || typeof fields.command !== 'string'
        || !fields.command.trim() || fields.command.length > Math.min(4096, template.definition.policy.maxQueryChars)) return invalid;
      try {
        validateSql(fields.command, template.definition.policy.maxQueryChars);
      } catch (error) {
        if (!(error instanceof SandboxExecutionError)) throw error;
        if (error.code === 'syntaxError') return { verdict: 'progress', reason: null, output: error.message };
        return invalid;
      }
      if (!this.sandbox) return unavailable;
      try {
        const response = await this.sandbox.execute({ ...sandboxIdentity(snapshot.id, puzzle.key, puzzle.sandbox.generation),
          commandId, command: fields.command });
        if (response.commandId !== commandId) return unavailable;
        if (Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr) > 65536) {
          throw new SandboxExecutionError('runtimeUnavailable');
        }
        if (response.timedOut) return { ...unavailable, output: 'SQL execution timed out.' };
        if (response.truncated) {
          let output = 'SQL output truncated. Narrow the query.\n';
          for (const record of response.stdout.split('\n').slice(0, -1)) {
            if (Buffer.byteLength(output) + Buffer.byteLength(record) + 1 > 65536) break;
            output += `${record}\n`;
          }
          return { verdict: 'progress', reason: null, output };
        }
        if (response.exitCode !== 0 || response.stderr) {
          return { verdict: 'progress', reason: null, output: response.stderr || 'SQL command failed' };
        }
        const output = response.stdout;
        // Legacy injected executors may return a single unframed cell; real helper envelopes are validated earlier.
        const rows = output.includes('\n') ? decodeSqlRows(output) : [[output]];
        const solved = rows.some(row => row.some(cell => cell === template.definition.goal.value));
        return { verdict: solved ? 'solved' : 'progress', reason: null, output };
      } catch (error) {
        if (error instanceof SandboxExecutionError) {
          if (error.code === 'busy' || error.code === 'inProgress') throw error;
          return { verdict: 'rejected',
            reason: ['policyBlocked', 'commandConflict', 'invalidIdentity', 'templateMismatch'].includes(error.code)
              ? 'policyBlocked' : 'sandboxRestarting', output: error.message };
        }
        this.logger.error(`SQL executor unavailable: ${describeFailure(error)}`);
        return unavailable;
      }
    }
    if (template.engine === 'hash') {
      if (Object.keys(fields).length !== 2 || fields.kind !== 'answer' || typeof fields.answer !== 'string'
        || fields.answer.length > 128 || !/^[a-f0-9]{64}$/i.test(fields.answer.trim())) return invalid;
      try {
        return await this.hashes.compare(fields.answer.trim().toLowerCase(), template.definition.seed.expectedHashHex)
          ? { verdict: 'solved', reason: null, output: template.definition.seed.revealedPassword }
          : { verdict: 'rejected', reason: 'wrongAnswer', output: '' };
      } catch (error) {
        this.logger.warn(`Hash comparison failed: ${describeFailure(error)}`);
        return unavailable;
      }
    }
    if (Object.keys(fields).length !== 3 || fields.kind !== 'credentials'
      || typeof fields.username !== 'string' || typeof fields.password !== 'string'
      || fields.username.length > 256 || fields.password.length > 256) return invalid;
    const expected = template.definition.seed.fields;
    if (Object.keys(expected).length !== 2 || expected.username === undefined || expected.password === undefined) {
      throw new Error('Unsupported credential template');
    }
    const credentials = { username: fields.username, password: fields.password };
    let accepted = true;
    for (const key of ['username', 'password'] as const) {
      const actual = credentials[key].trim();
      const wanted = expected[key].trim();
      const actualHash = createHash('sha256').update(key === 'username' ? actual.toLowerCase() : actual).digest();
      const wantedHash = createHash('sha256').update(key === 'username' ? wanted.toLowerCase() : wanted).digest();
      accepted = timingSafeEqual(actualHash, wantedHash) && accepted;
    }
    return accepted ? { verdict: 'solved', reason: null, output: 'Accepted' }
      : { verdict: 'rejected', reason: 'wrongAnswer', output: '' };
  }
}