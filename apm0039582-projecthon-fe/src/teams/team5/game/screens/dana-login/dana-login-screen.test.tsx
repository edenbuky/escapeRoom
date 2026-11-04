import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeViews } from '../../dev/fakeViews';
import { ROOM_1_ASSETS } from '../../room-design/room-assets';
import type { PuzzleScreenProps, SubmitResult } from '../types';
import { DanaLoginScreen } from './DanaLoginScreen';

const submit = vi.fn<PuzzleScreenProps['submit']>();
const close = vi.fn();

function loginView(change?: (puzzle: PuzzleScreenProps['puzzle']) => void) {
  const view = fakeViews().login;
  const puzzle = view.currentRoom.puzzles.find(candidate => candidate.key === 'dana-login')!;
  change?.(puzzle);
  return { view, puzzle };
}

function renderScreen(change?: (puzzle: PuzzleScreenProps['puzzle']) => void) {
  const { view, puzzle } = loginView(change);
  return render(<DanaLoginScreen view={view} puzzle={puzzle} submit={submit} close={close} />);
}

function fillCredentials(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

beforeEach(() => {
  submit.mockReset().mockResolvedValue('accepted');
  close.mockReset();
});

describe('Dana login screen', () => {
  it('submits trimmed username and untouched password as credentials', async () => {
    renderScreen();
    expect(screen.getByText("Dana's computer · Sign in")).toHaveClass('modal-title');
    expect(screen.getByText('Enter a username and password to unlock the computer')).toHaveClass('modal-note');
    expect(screen.getByRole('form', { name: "Dana's login screen" }).querySelector('img')).toHaveAttribute('src', ROOM_1_ASSETS['login-screen']);
    expect(screen.getByLabelText('Username')).toHaveClass('screen-input', 'login-input');
    expect(screen.getByLabelText('Password')).toHaveClass('screen-input', 'login-input');
    fillCredentials('  danaZ22\n', ' pass word ');
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ kind: 'credentials', username: 'danaZ22', password: ' pass word ' }));
    expect(screen.queryByRole('button', { name: 'Open room' })).not.toBeInTheDocument();
  });

  it('submits with Enter and disables the login while pending', async () => {
    let resolve!: (result: SubmitResult) => void;
    submit.mockReturnValue(new Promise(done => { resolve = done; }));
    renderScreen();
    fillCredentials('danaZ22', 'secret');
    fireEvent.submit(screen.getByLabelText('Password'));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Log In' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Password'));
    expect(submit).toHaveBeenCalledTimes(1);
    resolve('accepted');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log In' })).toBeEnabled());
  });

  it('shows the submit error in the error bar on the picture', async () => {
    submit.mockResolvedValue({ error: 'network' });
    renderScreen();
    fillCredentials('danaZ22', 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Log In' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Connection lost. Try again.');
    expect(error).toHaveClass('screen-error');
    expect(screen.getByRole('form', { name: "Dana's login screen" })).toContainElement(error);
    expect(screen.getByLabelText('Password')).toHaveValue('secret');
  });

  it('opens a fresh form: a rejection already in the view is not shown, a newer one is (design showDanaLogin)', () => {
    const { view, puzzle } = loginView(candidate => {
      candidate.latestResult = { commandId: 'fixture-login', verdict: 'rejected', reason: 'wrongAnswer', output: '' };
    });
    const { rerender } = render(<DanaLoginScreen view={view} puzzle={puzzle} submit={submit} close={close} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password')).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Open room' })).not.toBeInTheDocument();
    rerender(<DanaLoginScreen view={view} submit={submit} close={close}
      puzzle={{ ...puzzle, latestResult: { commandId: 'attempt-2', verdict: 'rejected', reason: 'wrongAnswer', output: '' } }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong username or password');
    expect(screen.getByRole('alert')).toHaveClass('screen-error');
  });

  it('clears and focuses the password when a new rejection arrives in the view', () => {
    const { view, puzzle } = loginView();
    const { rerender } = render(<DanaLoginScreen view={view} puzzle={puzzle} submit={submit} close={close} />);
    fillCredentials('danaZ22', 'wrong');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const rejected = { ...puzzle, latestResult: { commandId: 'attempt-1', verdict: 'rejected' as const, reason: 'wrongAnswer' as const, output: '' } };
    rerender(<DanaLoginScreen view={view} puzzle={rejected} submit={submit} close={close} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong username or password');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(screen.getByLabelText('Username')).toHaveValue('danaZ22');
  });

  it('shows the desktop once the view says solved; the file only closes the panel', () => {
    renderScreen(puzzle => {
      puzzle.status = 'solved';
      puzzle.latestResult = { commandId: 'fixture-login', verdict: 'solved', reason: null, output: 'Accepted' };
    });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByText("Dana's computer · Desktop")).toHaveClass('modal-title');
    expect(screen.getByText('Click open room to open the door and move to the second room')).toHaveClass('modal-note');
    const desktop = screen.getByRole('group', { name: "Dana's desktop" });
    expect(desktop).toHaveClass('interactive-screen', 'dana-desktop');
    expect(desktop.querySelector('img')).toHaveAttribute('src', ROOM_1_ASSETS['computer-open-empty']);
    const openRoom = screen.getByRole('button', { name: 'Open room' });
    expect(openRoom).toHaveClass('dana-file');
    expect(openRoom.querySelector('img')).toHaveAttribute('src', ROOM_1_ASSETS['open-doors-file']);
    openRoom.focus();
    expect(openRoom).toHaveFocus();
    fireEvent.click(openRoom);
    expect(close).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});
