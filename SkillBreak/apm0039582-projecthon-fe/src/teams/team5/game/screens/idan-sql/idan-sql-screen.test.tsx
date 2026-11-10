import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PuzzleInput } from '../../../contracts/outputs';
import type { SessionView } from '../../../contracts/view';
import { fakeViews } from '../../dev/fakeViews';
import { clearDrafts } from '../../device-drafts';
import type { SubmitResult } from '../types';
import { IdanSqlScreen } from './IdanSqlScreen';

const submit = vi.fn<(input: PuzzleInput) => Promise<SubmitResult>>();
const renderScreen = (view: SessionView) => render(<IdanSqlScreen puzzle={view.currentRoom.puzzles[0]} view={view} submit={submit} close={vi.fn()} />);
const query = () => screen.getByLabelText('SQL query');
const run = () => screen.getByRole('button', { name: /Run/ });

beforeEach(() => { submit.mockReset().mockResolvedValue('accepted'); clearDrafts(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Idan SQL screen', () => {
  it('unblocks Run when an accepted query result never arrives, without replaying it', async () => {
    vi.useFakeTimers();
    renderScreen(fakeViews().ready);
    fireEvent.change(query(), { target: { value: 'SELECT * FROM logs' } });
    await act(async () => { fireEvent.click(run()); });
    expect(run()).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(run()).toBeEnabled();
    expect(query()).toHaveValue('SELECT * FROM logs');
    expect(screen.getByRole('alert')).toHaveTextContent('No result received yet');
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('recovers the query controls after an unexpected request rejection', async () => {
    submit.mockRejectedValue(new Error('offline'));
    renderScreen(fakeViews().ready);
    fireEvent.change(query(), { target: { value: 'SELECT 1' } });
    await act(async () => { fireEvent.click(run()); });
    expect(run()).toBeEnabled();
    expect(query()).toHaveValue('SELECT 1');
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server');
  });
  it('shows the table names, a query field and an empty result area', () => {
    renderScreen(fakeViews().ready);
    expect(screen.getByText('employees')).toBeInTheDocument();
    expect(screen.getByText('logs')).toBeInTheDocument();
    expect(query()).toBeInTheDocument();
    expect(screen.getByText('No results yet. Run a query to see rows here.')).toBeInTheDocument();
  });

  it('submits the multi-line query as one command and stays pending until the view has a new result', async () => {
    const views = fakeViews();
    const { rerender } = renderScreen(views.ready);
    expect(run()).toBeDisabled();
    fireEvent.change(query(), { target: { value: '  \n ' } });
    expect(run()).toBeDisabled();
    fireEvent.change(query(), { target: { value: 'SELECT username\nFROM employees;' } });
    fireEvent.click(run());
    expect(submit).toHaveBeenCalledWith({ kind: 'command', command: 'SELECT username\nFROM employees;' });
    await waitFor(() => expect(run()).toHaveTextContent('Running…'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    rerender(<IdanSqlScreen puzzle={views.sqlRows.currentRoom.puzzles[0]} view={views.sqlRows} submit={submit} close={vi.fn()} />);
    expect(run()).toHaveTextContent('Run');
    expect(run()).toBeEnabled();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('shows the submit error and no result when the submission is refused', async () => {
    submit.mockResolvedValue({ error: 'network' });
    renderScreen(fakeViews().ready);
    fireEvent.change(query(), { target: { value: 'SELECT 1' } });
    fireEvent.click(run());
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost. Try again.');
    expect(run()).toBeEnabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('blocks Run while the sandbox is not ready', () => {
    renderScreen(fakeViews().starting);
    fireEvent.change(query(), { target: { value: 'SELECT 1' } });
    expect(screen.getByText('Database starting…')).toBeInTheDocument();
    expect(run()).toBeDisabled();
  });

  it('renders the rows from the session view as selectable cells with NULL marked', () => {
    renderScreen(fakeViews().sqlRows);
    const grid = screen.getByRole('table');
    expect(within(grid).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['employee_id', 'full_name', 'username', 'email']);
    expect(within(grid).getByText('danac').tagName).toBe('SPAN');
    expect(within(grid).getByText('NULL')).toHaveClass('t5-sql-null');
  });

  it('copies a value when the value itself is clicked and tags it "Copied" only after the clipboard accepted it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderScreen(fakeViews().sqlRows);
    expect(screen.queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument();
    const value = screen.getByRole('button', { name: /copy username, row 2/ });
    expect(value).toHaveTextContent('danac');
    fireEvent.click(value);
    await waitFor(() => expect(value).toHaveAttribute('data-copy', 'copied'));
    expect(writeText).toHaveBeenCalledWith('danac');
  });

  it('copies with the keyboard and copies a NULL cell as an empty string', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderScreen(fakeViews().sqlRows);
    fireEvent.keyDown(screen.getByRole('button', { name: /copy email, row 2/ }), { key: 'Enter' });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(''));
  });

  it('does not copy when the click ends a text selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderScreen(fakeViews().sqlRows);
    const value = screen.getByRole('button', { name: /copy username, row 2/ });
    window.getSelection()?.selectAllChildren(value);
    fireEvent.click(value);
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
  });

  it('selects the value for manual copy when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    renderScreen(fakeViews().sqlRows);
    const value = screen.getByRole('button', { name: /copy username, row 2/ });
    fireEvent.click(value);
    expect(await screen.findByText('Clipboard unavailable. The value is selected; copy it manually.')).toBeInTheDocument();
    expect(value).not.toHaveAttribute('data-copy', 'copied');
    expect(window.getSelection()?.toString()).toBe('danac');
    window.getSelection()?.removeAllRanges();
  });

  it('shows the syntax error and command failure as messages without a grid', () => {
    const views = fakeViews();
    const { rerender } = renderScreen(views.sqlSyntaxError);
    expect(screen.getByText('SQL syntax is invalid or unsupported.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    rerender(<IdanSqlScreen puzzle={views.sqlFailed.currentRoom.puzzles[0]} view={views.sqlFailed} submit={submit} close={vi.fn()} />);
    expect(screen.getByText('SQL command failed')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the truncation notice and the rows that fit', () => {
    renderScreen(fakeViews().sqlTruncated);
    expect(screen.getByText('SQL output truncated. Narrow the query.')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('idanl')).toBeInTheDocument();
  });

  it('shows a blocked message for a policy-blocked query and replaces the older rows', () => {
    const views = fakeViews();
    const blocked = structuredClone(views.sqlRows);
    blocked.currentRoom.puzzles[0].latestResult = { commandId: 'fixture-blocked', verdict: 'rejected', reason: 'policyBlocked', output: '' };
    const { rerender } = renderScreen(views.sqlRows);
    rerender(<IdanSqlScreen puzzle={blocked.currentRoom.puzzles[0]} view={blocked} submit={submit} close={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Query blocked. Only read-only SELECT queries are allowed.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a not-permitted operation (UPDATE) as blocked', () => {
    const view = structuredClone(fakeViews().ready);
    view.currentRoom.puzzles[0].latestResult = { commandId: 'fixture-update', verdict: 'progress', reason: null, output: 'SQL operation is not permitted.\n' };
    renderScreen(view);
    expect(screen.getByRole('alert')).toHaveTextContent('Query blocked.');
  });

  it("sits in the design's window frame and goes back to the room from its header button", () => {
    const close = vi.fn();
    const view = fakeViews().ready;
    render(<IdanSqlScreen puzzle={view.currentRoom.puzzles[0]} view={view} submit={submit} close={close} />);
    expect(screen.getByText("⌘ Idan · SQL terminal")).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL read-only · SELECT queries only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← Back to room' }));
    expect(close).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
});
