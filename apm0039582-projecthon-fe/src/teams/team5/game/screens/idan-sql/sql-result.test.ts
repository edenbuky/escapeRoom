import type { EvaluationView } from '../../../contracts/view';
import { readSqlResult } from './sql-result';

const progress = (output: string): EvaluationView => ({ commandId: 'c1', verdict: 'progress', reason: null, output });

describe('readSqlResult', () => {
  it('has nothing to show before the first result', () => {
    expect(readSqlResult(null)).toEqual({ kind: 'none' });
  });

  it('decodes the header row, rows and \\N as NULL', () => {
    expect(readSqlResult(progress('id\tusername\temail\n1\tdana\t\\N\n2\tidan\tidan@example.test\n'))).toEqual({
      kind: 'table', notice: null, columns: ['id', 'username', 'email'],
      rows: [['1', 'dana', null], ['2', 'idan', 'idan@example.test']],
    });
  });

  it('decodes escaped backslash, tab, newline and carriage return inside a cell', () => {
    const outcome = readSqlResult(progress('note\na\\\\b\\tc\\nd\\re\n'));
    expect(outcome).toEqual({ kind: 'table', notice: null, columns: ['note'], rows: [['a\\b\tc\nd\re']] });
  });

  it('keeps a header-only result as a table with zero rows', () => {
    expect(readSqlResult(progress('id\tusername\n'))).toEqual({ kind: 'table', notice: null, columns: ['id', 'username'], rows: [] });
  });

  it('treats output that is not a valid table as plain text', () => {
    for (const output of ['id\tname\n1\tdana', 'id\tname\r\n1\tdana\r\n', 'id\tname\n1\n', 'bad\\x\n', '\\N\n', 'SQL command failed']) {
      expect(readSqlResult(progress(output))).toEqual({ kind: 'message', text: output });
    }
  });

  it('shows engine and helper diagnostics as messages, not one-column tables', () => {
    expect(readSqlResult(progress('SQL syntax is invalid or unsupported.'))).toEqual({ kind: 'message', text: 'SQL syntax is invalid or unsupported.' });
    expect(readSqlResult(progress('SQL query failed.\n'))).toEqual({ kind: 'message', text: 'SQL query failed.' });
    expect(readSqlResult(progress('SQL syntax is invalid; submit one statement.\n'))).toEqual({ kind: 'message', text: 'SQL syntax is invalid; submit one statement.' });
  });

  it('keeps the truncation notice and decodes the rows that fit', () => {
    expect(readSqlResult(progress('SQL output truncated. Narrow the query.\nid\tusername\n1\tdana\n'))).toEqual({
      kind: 'table', notice: 'SQL output truncated. Narrow the query.', columns: ['id', 'username'], rows: [['1', 'dana']],
    });
  });

  it('marks policy rejections and not-permitted operations as blocked', () => {
    expect(readSqlResult({ commandId: 'c1', verdict: 'rejected', reason: 'policyBlocked', output: '' })).toEqual({ kind: 'blocked' });
    expect(readSqlResult(progress('SQL operation is not permitted.\n'))).toEqual({ kind: 'blocked' });
  });

  it('shows other rejections as a message', () => {
    expect(readSqlResult({ commandId: 'c1', verdict: 'rejected', reason: 'sandboxRestarting', output: 'SQL execution timed out.' }))
      .toEqual({ kind: 'message', text: 'SQL execution timed out.' });
    expect(readSqlResult({ commandId: 'c1', verdict: 'rejected', reason: 'sandboxRestarting', output: '' }))
      .toEqual({ kind: 'message', text: 'Database unavailable. Try again.' });
  });
});
