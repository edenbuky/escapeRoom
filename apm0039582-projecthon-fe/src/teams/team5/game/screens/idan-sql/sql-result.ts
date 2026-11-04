import type { EvaluationView } from '../../../contracts/view';

/** What the SQL screen shows for the latest `idan-db` result. NULL cells are `null`. */
type SqlOutcome =
  | { kind: 'none' }
  | { kind: 'blocked' }
  | { kind: 'message'; text: string }
  | { kind: 'table'; notice: string | null; columns: string[]; rows: (string | null)[][] };

const TRUNCATED = 'SQL output truncated. Narrow the query.\n';
const NOT_PERMITTED = 'SQL operation is not permitted.\n';
/** Query-helper stderr lines (sandboxes/sql/query-helper.mjs); they end with `\n` like a one-column, zero-row table. */
const DIAGNOSTICS = new Set([NOT_PERMITTED, 'SQL syntax is invalid; submit one statement.\n', 'SQL query failed.\n', 'SQL execution cancelled.\n']);

/** One cell as the engine writes it (apps/game-engine sandbox/sql-result.ts); undefined when the escape is not valid. */
function decodeCell(cell: string): string | null | undefined {
  if (cell === '\\N') return null;
  let valid = true;
  const value = cell.replace(/\\(.)|\\/g, (_match, escaped: string | undefined) => {
    switch (escaped) {
      case '\\': return '\\';
      case 't': return '\t';
      case 'r': return '\r';
      case 'n': return '\n';
      default: valid = false; return '';
    }
  });
  return valid ? value : undefined;
}

/** Header row, then rows of the same width, whole text ending in `\n`; anything else is not a table. */
function decodeTable(output: string): { columns: string[]; rows: (string | null)[][] } | null {
  if (!output.endsWith('\n') || output.includes('\r') || output.includes('\0')) return null;
  const records = output.slice(0, -1).split('\n').map(record => record.split('\t').map(decodeCell));
  const [header, ...rows] = records;
  if (header.some(cell => typeof cell !== 'string') || rows.some(row => row.length !== header.length || row.includes(undefined))) return null;
  return { columns: header as string[], rows: rows as (string | null)[][] };
}

export function readSqlResult(result: EvaluationView | null): SqlOutcome {
  if (!result) return { kind: 'none' };
  const { output } = result;
  if (result.verdict === 'rejected') {
    if (result.reason === 'policyBlocked') return { kind: 'blocked' };
    return { kind: 'message', text: output.trim() || (result.reason === 'sandboxRestarting' ? 'Database unavailable. Try again.' : 'Query rejected.') };
  }
  if (output === NOT_PERMITTED) return { kind: 'blocked' };
  if (DIAGNOSTICS.has(output)) return { kind: 'message', text: output.trim() };
  const truncated = output.startsWith(TRUNCATED);
  const table = decodeTable(truncated ? output.slice(TRUNCATED.length) : output);
  return table ? { kind: 'table', notice: truncated ? TRUNCATED.trim() : null, ...table } : { kind: 'message', text: output };
}
