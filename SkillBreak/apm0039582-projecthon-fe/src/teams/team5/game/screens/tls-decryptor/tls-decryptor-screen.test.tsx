import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionView } from '../../../contracts/view';
import { fakeViews } from '../../dev/fakeViews';
import { ROOM_2_ASSETS } from '../../room-design/room-assets';
import type { PuzzleScreenProps } from '../types';
import { TlsDecryptorScreen } from './TlsDecryptorScreen';

const submit = vi.fn<PuzzleScreenProps['submit']>();

function renderScreen(view: SessionView = fakeViews().room2TlsOpen) {
  const puzzle = view.currentRoom.puzzles.find(candidate => candidate.key === 'tls-decryptor')!;
  return render(<TlsDecryptorScreen puzzle={puzzle} view={view} submit={submit} close={vi.fn()} />);
}
function withResult(result: NonNullable<SessionView['currentRoom']['puzzles'][number]['latestResult']>) {
  const view = fakeViews().room2TlsOpen;
  view.currentRoom.puzzles.find(candidate => candidate.key === 'tls-decryptor')!.latestResult = result;
  return view;
}
const fill = () => {
  fireEvent.change(screen.getByLabelText('PMS'), { target: { value: '  0303AB \n' } });
  fireEvent.change(screen.getByLabelText('Client Random'), { target: { value: ' cd\r\n' } });
};

beforeEach(() => { submit.mockReset().mockResolvedValue('accepted'); localStorage.clear(); });

describe('TLS decryptor screen', () => {
  it('renders the device picture with the design fields at the design rects', () => {
    renderScreen();
    expect(screen.getByText('TLS Decryptor', { selector: '.modal-title' })).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'TLS Decryptor' });
    expect(form).toHaveClass('interactive-screen');
    expect(form.querySelector('img')).toHaveAttribute('src', ROOM_2_ASSETS['tls-decryptor-front']);
    expect(screen.getByLabelText('PMS')).toHaveStyle({ left: '39%', top: '29.2%', width: '42.2%', height: '5.1%' });
    expect(screen.getByLabelText('Client Random')).toHaveStyle({ left: '39%', top: '37.1%', width: '42.2%', height: '5.1%' });
    expect(screen.getByRole('button', { name: 'Decrypt' })).toHaveStyle({ left: '36.4%', top: '54%', width: '27.4%', height: '7.7%' });
    expect(screen.getByLabelText('Output')).toHaveStyle({ left: '18.9%', top: '68.7%', width: '62.2%', height: '6.6%' });
  });

  it('submits trimmed single-line values', async () => {
    renderScreen();
    fill();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decrypt' })); });
    expect(submit).toHaveBeenCalledWith({ kind: 'tls', pms: '0303AB', clientRandom: 'cd' });
  });

  it('keeps drafts per game session', () => {
    const view = { ...fakeViews().room2TlsOpen, sessionId: 'tls-draft' };
    const { unmount } = renderScreen(view);
    fill();
    unmount();
    renderScreen(view);
    expect(screen.getByLabelText('PMS')).toHaveValue('  0303AB \n'.replace('\n', ''));
    cleanup();
    renderScreen({ ...view, sessionId: 'other' });
    expect(screen.getByLabelText('PMS')).toHaveValue('');
  });

  it('shows pending once, then re-enables Decrypt', async () => {
    let settle!: (reply: 'accepted') => void;
    submit.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    renderScreen();
    fireEvent.submit(screen.getByLabelText('PMS'));
    fireEvent.submit(screen.getByLabelText('PMS'));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Output')).toHaveTextContent('Decrypting…');
    await act(async () => settle('accepted'));
    expect(screen.getByRole('button', { name: 'Decrypt' })).toBeEnabled();
  });

  it.each([
    ['wrongAnswer', 'Decryption failed. Check the PMS and the Client Random.'],
    ['policyBlocked', 'Invalid input. The PMS and the Client Random must be hex values.'],
    ['timeUp', 'Time is up.'], ['sessionEnded', 'This session has ended.'],
  ] as const)('shows the %s rejection', (reason, text) => {
    renderScreen(withResult({ commandId: 'c', verdict: 'rejected', reason, output: '' }));
    expect(screen.getByLabelText('Output')).toHaveTextContent(text);
  });

  it('shows submit transport errors and survives an unexpected rejection', async () => {
    submit.mockResolvedValueOnce({ error: 'unavailable' });
    renderScreen();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decrypt' })); });
    expect(screen.getByLabelText('Output')).toHaveTextContent('Game service unavailable. Try again.');
    submit.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decrypt' })); });
    expect(screen.getByLabelText('Output')).toHaveTextContent('Cannot reach the server');
    expect(screen.getByRole('button', { name: 'Decrypt' })).toBeEnabled();
  });

  it('shows the solved output', () => {
    renderScreen(withResult({ commandId: 'c', verdict: 'solved', reason: null, output: 'The file has been decrypted' }));
    expect(screen.getByLabelText('Output')).toHaveTextContent('The file has been decrypted');
  });
});
