import { useState, type FormEvent } from 'react';
import { LoaderCircle, Play } from '../../../vendor/icons';
import room1Design from '../../room-design/room-1.design.json';
import type { PuzzleScreenProps } from '../types';
import { copyShownValue } from '../room-1-ui.helpers';
import { submitErrorMessage } from '../shared/submit-error';
import { readSqlResult } from './sql-result';
import './idan-sql-screen.css';

/** Tables the player may read (sandboxes/sql/fixtures/room1-sql-v1.sql GRANT SELECT). */
const TABLES = ['employees', 'logs'];

/**
 * Idan's SQL view (DESIGN-v2: one command box and one result grid) inside the design HTML's window frame.
 * The query goes out as one command; the grid shows only `puzzle.latestResult` from the session view.
 * A NULL cell shows a NULL label and copies as an empty string (it has no value to paste).
 */
export function IdanSqlScreen({ puzzle, submit, close }: PuzzleScreenProps) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  /** The result id on screen when Run was pressed; the query is pending until the view carries another one. */
  const [waitingAfter, setWaitingAfter] = useState<string | null>();
  const [copy, setCopy] = useState<{ commandId: string; cell: string; state: 'copied' | 'selected' }>();
  const result = puzzle.latestResult;
  const outcome = readSqlResult(result);
  const sandbox = puzzle.sandbox.status;
  const pending = waitingAfter !== undefined && waitingAfter === (result?.commandId ?? null);
  const copyFailed = copy?.state === 'selected' && copy.commandId === result?.commandId;

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setWaitingAfter(result?.commandId ?? null);
    const reply = await submit({ kind: 'command', command: query });
    if (reply !== 'accepted') { setError(submitErrorMessage(reply)); setWaitingAfter(undefined); }
  }

  async function copyCell(commandId: string, cell: string, value: string, shown: Element) {
    const state = await copyShownValue(shown, value);
    if (state !== 'skipped') setCopy({ commandId, cell, state });
  }

  return <section className="window-shell" aria-label="SQL terminal">
    <div className="window-header">
      <button type="button" className="window-back" onClick={close}>← Back to room</button>
      <span className="window-name">⌘ {room1Design.characters.idan.displayName} · SQL terminal</span>
    </div>
    <div className="window-subtitle">PostgreSQL read-only · SELECT queries only</div>
    <div className="window-body t5-sql">
      <p className="t5-sql-tables">Tables: {TABLES.map(table => <code key={table}>{table}</code>)}</p>
      <form className="t5-sql-form" onSubmit={run}>
        <label htmlFor="t5-sql-query">SQL query</label>
        <textarea id="t5-sql-query" name="query" rows={4} spellCheck={false} autoComplete="off"
          value={query} onChange={event => setQuery(event.target.value)} />
        <div className="t5-sql-actions">
          <span className={`t5-sql-sandbox ${sandbox === 'ready' ? 'ready' : ''}`} role="status">
            {sandbox === 'ready' ? 'Database ready' : sandbox === 'failed' ? 'Database unavailable' : 'Database starting…'}
          </span>
          <button type="submit" className="t5-primary" disabled={sandbox !== 'ready' || pending || !query.trim()}>
            {pending ? <><LoaderCircle size={16} className="t5-sql-spin" />Running…</> : <><Play size={16} />Run</>}
          </button>
        </div>
        {error && <p className="t5-error" role="alert">{error}</p>}
      </form>
      <div className="t5-sql-result">
        {outcome.kind === 'none' && <p className="t5-sql-empty">No results yet. Run a query to see rows here.</p>}
        {outcome.kind === 'blocked' && <p className="t5-sql-message t5-sql-blocked" role="alert">
          Query blocked. Only read-only SELECT queries are allowed.</p>}
        {outcome.kind === 'message' && <pre className="t5-sql-message" role="status">{outcome.text}</pre>}
        {outcome.kind === 'table' && result && <>
          {outcome.notice && <p className="t5-sql-message" role="status">{outcome.notice}</p>}
          <div className="t5-sql-grid">
            <table>
              <thead><tr>{outcome.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
              <tbody>{outcome.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, index) => {
                const cell = `${rowIndex}:${index}`;
                const state = copy?.commandId === result.commandId && copy.cell === cell ? copy.state : undefined;
                const copyThis = (shown: Element) => void copyCell(result.commandId, cell, value ?? '', shown);
                return <td key={index}>
                  <span className={`t5-sql-value ${value === null ? 't5-sql-null' : ''}`} role="button" tabIndex={0}
                    title="Click to copy" data-copy={state}
                    aria-label={`${value ?? 'NULL'}: click to copy ${outcome.columns[index]}, row ${rowIndex + 1}`}
                    onClick={event => copyThis(event.currentTarget)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copyThis(event.currentTarget); } }}>
                    {value ?? 'NULL'}
                  </span>
                </td>;
              })}</tr>)}</tbody>
            </table>
          </div>
          {outcome.rows.length === 0 && <p className="t5-sql-empty">Query returned no rows.</p>}
          {copyFailed && <p className="t5-error" role="status">Clipboard unavailable. The value is selected; copy it manually.</p>}
          {outcome.rows.length > 0 && <p className="t5-sql-hint">Click a value to copy it.</p>}
        </>}
      </div>
    </div>
    <div className="window-footer">Run a SELECT query · Click outside the window or press Esc to go back</div>
  </section>;
}
