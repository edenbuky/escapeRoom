import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionView } from '../../../contracts/view';
import { fakeViews } from '../../dev/fakeViews';
import { readRoom1Progress } from '../../room-1-progress';
import { ROOM_1_ASSETS } from '../../room-design/room-assets';
import type { PuzzleScreenProps } from '../types';
import { HashCrackerScreen } from './HashCrackerScreen';

const submit = vi.fn<PuzzleScreenProps['submit']>();

function renderScreen(view: SessionView) {
  const puzzle = view.currentRoom.puzzles.find(candidate => candidate.key === 'hash-cracker')!;
  return render(<HashCrackerScreen puzzle={puzzle} view={view} submit={submit} close={vi.fn()} />);
}

function decoyView() {
  const view = fakeViews().hash;
  view.currentRoom.puzzles[1].latestResult = { commandId: 'fixture-decoy', verdict: 'rejected', reason: 'wrongAnswer', output: '' };
  return view;
}

beforeEach(() => {
  submit.mockReset().mockResolvedValue('accepted');
  sessionStorage.clear();
});

describe('Hash-Cracker screen (spec 005 US2)', () => {
  it('sends the trimmed hash as an answer from the CRACK button on the device picture', async () => {
    renderScreen(fakeViews().hash);
    expect(screen.getByText('Hash Cracker')).toHaveClass('modal-title');
    expect(screen.getByText('Paste a hash and press CRACK')).toHaveClass('modal-note');
    expect(screen.getByRole('form', { name: 'Hash Cracker' })).toHaveClass('interactive-screen');
    expect(screen.getByRole('form', { name: 'Hash Cracker' }).querySelector('img'))
      .toHaveAttribute('src', ROOM_1_ASSETS['hash-cracker-streight']);
    fireEvent.change(screen.getByLabelText('Input hash'), { target: { value: ' \n abc123 \r\n' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CRACK' })); });
    expect(submit).toHaveBeenCalledWith({ kind: 'answer', answer: 'abc123' });
    expect(screen.getByLabelText('Output')).toBeEmptyDOMElement();
  });

  it('cracks on Enter (form submit) once and shows pending until the submit settles', async () => {
    let settle!: (reply: 'accepted') => void;
    submit.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    renderScreen(fakeViews().hash);
    fireEvent.change(screen.getByLabelText('Input hash'), { target: { value: 'abc' } });
    fireEvent.submit(screen.getByLabelText('Input hash'));
    expect(submit).toHaveBeenCalledWith({ kind: 'answer', answer: 'abc' });
    expect(screen.getByRole('button', { name: 'CRACK' })).toBeDisabled();
    expect(screen.getByLabelText('Output')).toHaveTextContent('Cracking…');
    fireEvent.submit(screen.getByLabelText('Input hash'));
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => settle('accepted'));
    expect(screen.getByRole('button', { name: 'CRACK' })).toBeEnabled();
  });

  it('shows the submit error on the output display and no result', async () => {
    submit.mockResolvedValue({ error: 'unavailable' });
    renderScreen(fakeViews().hash);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CRACK' })); });
    expect(screen.getByLabelText('Output')).toHaveTextContent('Game service unavailable. Try again.');
  });

  it('keeps the typed hash per game session when the window is opened again (design deviceDrafts)', () => {
    const view = { ...fakeViews().hash, sessionId: 'draft-session' };
    const { unmount } = renderScreen(view);
    fireEvent.change(screen.getByLabelText('Input hash'), { target: { value: 'abc123' } });
    unmount();
    renderScreen(view);
    expect(screen.getByLabelText('Input hash')).toHaveValue('abc123');
    cleanup();
    renderScreen({ ...view, sessionId: 'other-session' });
    expect(screen.getByLabelText('Input hash')).toHaveValue('');
  });

  it('shows "no match" for a decoy hash and never a password', () => {
    renderScreen(decoyView());
    expect(screen.getByLabelText('Output')).toHaveTextContent('No match found.');
    expect(readRoom1Progress(decoyView().sessionId).passwordCracked).toBe(false);
  });

  it('explains a value that is not a hash', () => {
    const view = fakeViews().hash;
    view.currentRoom.puzzles[1].latestResult = { commandId: 'fixture-bad', verdict: 'rejected', reason: 'policyBlocked', output: '' };
    renderScreen(view);
    expect(screen.getByLabelText('Output')).toHaveTextContent('Not a valid SHA-256 hash.');
  });

  it('shows the password only from the solved session view, as selectable text, and marks it cracked', () => {
    const { rerender } = renderScreen(fakeViews().hash);
    expect(screen.queryByText('fixture-password')).not.toBeInTheDocument();
    const solved = fakeViews().login;
    rerender(<HashCrackerScreen puzzle={solved.currentRoom.puzzles[1]} view={solved} submit={submit} close={vi.fn()} />);
    expect(screen.getByLabelText('Output')).toHaveTextContent('fixture-password');
    expect(screen.getByLabelText('Output').tagName).toBe('OUTPUT');
    expect(readRoom1Progress(solved.sessionId).passwordCracked).toBe(true);
    // No separate Copy button: the output itself is the copy control (click-to-copy).
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Output', 'CRACK']);
  });
  it('copies the cracked password when the output itself is clicked; a decoy result is not copyable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderScreen(decoyView());
    expect(screen.getByLabelText('Output')).not.toHaveAttribute('role');
    cleanup();
    renderScreen(fakeViews().login);
    const output = screen.getByRole('button', { name: 'Output' });
    expect(output).toHaveTextContent('fixture-password');
    expect(screen.getByText('Click the description to copy it')).toHaveClass('modal-note');
    fireEvent.click(output);
    await vi.waitFor(() => expect(output).toHaveAttribute('data-copy', 'copied'));
    expect(screen.getByText('Copied')).toHaveClass('modal-note');
    expect(writeText).toHaveBeenCalledWith('fixture-password');
    vi.unstubAllGlobals();
  });
  it('shows and copies a known log description without marking the puzzle solved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const view = { ...fakeViews().hash, sessionId: 'description-progress-session' };
    view.currentRoom.puzzles[1].latestResult = { commandId: 'description', verdict: 'progress', reason: null, output: 'logged out' };
    renderScreen(view);
    const output = screen.getByRole('button', { name: 'Output' });
    expect(output).toHaveTextContent('logged out');
    expect(readRoom1Progress(view.sessionId).passwordCracked).toBe(false);
    await act(async () => { fireEvent.click(output); });
    expect(writeText).toHaveBeenCalledWith('logged out');
    vi.unstubAllGlobals();
  });
  it('retains the complete final password-change sentence', () => {
    const view = fakeViews().login;
    view.currentRoom.puzzles[1].latestResult = { commandId: 'final', verdict: 'solved', reason: null, output: 'changed password to edenIsMyFavourite' };
    renderScreen(view);
    expect(screen.getByLabelText('Output')).toHaveTextContent('changed password to edenIsMyFavourite');
  });
  it('leaves the typed hash available and re-enables CRACK after an unexpected rejection', async () => {
    submit.mockRejectedValue(new Error('offline'));
    renderScreen(fakeViews().hash);
    fireEvent.change(screen.getByLabelText('Input hash'), { target: { value: 'abc123' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CRACK' })); });
    expect(screen.getByRole('button', { name: 'CRACK' })).toBeEnabled();
    expect(screen.getByLabelText('Input hash')).toHaveValue('abc123');
    expect(screen.getByLabelText('Output')).toHaveTextContent('Cannot reach the server');
  });
});
