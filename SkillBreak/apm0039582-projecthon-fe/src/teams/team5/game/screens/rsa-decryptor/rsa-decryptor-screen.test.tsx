import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionView } from '../../../contracts/view';
import { fakeViews } from '../../dev/fakeViews';
import { ROOM_2_ASSETS } from '../../room-design/room-assets';
import type { PuzzleScreenProps } from '../types';
import { RsaDecryptorScreen } from './RsaDecryptorScreen';

const submit = vi.fn<PuzzleScreenProps['submit']>();
const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabcd\n\n-----END RSA PRIVATE KEY-----\n';

function renderScreen(view: SessionView = fakeViews().room2RsaOpen) {
  const puzzle = view.currentRoom.puzzles.find(candidate => candidate.key === 'rsa-decryptor')!;
  return render(<RsaDecryptorScreen puzzle={puzzle} view={view} submit={submit} close={vi.fn()} />);
}
function withResult(result: NonNullable<SessionView['currentRoom']['puzzles'][number]['latestResult']>) {
  const view = fakeViews().room2RsaOpen;
  view.currentRoom.puzzles.find(candidate => candidate.key === 'rsa-decryptor')!.latestResult = result;
  return view;
}
const fill = () => {
  fireEvent.change(screen.getByLabelText('Private key'), { target: { value: KEY } });
  fireEvent.change(screen.getByLabelText('RSA modulus (N)'), { target: { value: '  ABCDEF \n' } });
  fireEvent.change(screen.getByLabelText('Encrypted PMS'), { target: { value: ' 0a0b\r\n' } });
};

beforeEach(() => { submit.mockReset().mockResolvedValue('accepted'); localStorage.clear(); });

describe('RSA decryptor screen', () => {
  it('renders the device picture with the design fields at the design rects', () => {
    renderScreen();
    expect(screen.getByText('RSA Decryptor')).toHaveClass('modal-title');
    const form = screen.getByRole('form', { name: 'RSA Decryptor' });
    expect(form).toHaveClass('interactive-screen');
    expect(form.querySelector('img')).toHaveAttribute('src', ROOM_2_ASSETS['rsa-decryptor-front']);
    expect(screen.getByLabelText('Private key').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Private key')).toHaveStyle({ left: '18%', top: '27.1%', width: '64%', height: '5.8%' });
    expect(screen.getByLabelText('RSA modulus (N)')).toHaveStyle({ top: '41.1%' });
    expect(screen.getByLabelText('Encrypted PMS')).toHaveStyle({ top: '55.1%' });
    expect(screen.getByRole('button', { name: 'Decrypt' })).toHaveStyle({ left: '35.5%', top: '64.2%', width: '29%', height: '7.5%' });
    expect(screen.getByLabelText('Output')).toHaveStyle({ left: '18%', top: '76.1%', width: '64%', height: '6.6%' });
  });

  it('submits the key with its line breaks intact and trims the single-line fields', async () => {
    renderScreen();
    fill();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decrypt' })); });
    expect(submit).toHaveBeenCalledWith({ kind: 'rsa', privateKey: KEY, encryptedPms: '0a0b', modulus: 'ABCDEF' });
  });

  it('keeps the multi-line key and values as drafts per game session', () => {
    const view = { ...fakeViews().room2RsaOpen, sessionId: 'rsa-draft' };
    const { unmount } = renderScreen(view);
    fill();
    unmount();
    renderScreen(view);
    expect((screen.getByLabelText('Private key') as HTMLTextAreaElement).value).toBe(KEY);
    expect(screen.getByLabelText('RSA modulus (N)')).toHaveValue('  ABCDEF ');
    cleanup();
    renderScreen({ ...view, sessionId: 'other' });
    expect(screen.getByLabelText('Private key')).toHaveValue('');
  });

  it('shows pending once, then re-enables Decrypt', async () => {
    let settle!: (reply: 'accepted') => void;
    submit.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    renderScreen();
    fireEvent.submit(screen.getByLabelText('Private key'));
    fireEvent.submit(screen.getByLabelText('Private key'));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Output')).toHaveTextContent('Decrypting…');
    await act(async () => settle('accepted'));
    expect(screen.getByRole('button', { name: 'Decrypt' })).toBeEnabled();
  });

  it.each([
    ['wrongAnswer', 'Decryption failed. Check the key, N and the encrypted PMS.'],
    ['policyBlocked', 'Invalid input. Check the private key and the hex values.'],
    ['timeUp', 'Time is up.'], ['sessionEnded', 'This session has ended.'],
  ] as const)('shows the %s rejection', (reason, text) => {
    renderScreen(withResult({ commandId: 'c', verdict: 'rejected', reason, output: '' }));
    expect(screen.getByLabelText('Output')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
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

  it('shows the PMS from the solved view and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderScreen(withResult({ commandId: 'c', verdict: 'solved', reason: null, output: '0303deadbeef' }));
    expect(screen.getByLabelText('Output')).toHaveTextContent('0303deadbeef');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(writeText).toHaveBeenCalledWith('0303deadbeef');
    expect(screen.getByText('Copied', { selector: '.modal-note' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
