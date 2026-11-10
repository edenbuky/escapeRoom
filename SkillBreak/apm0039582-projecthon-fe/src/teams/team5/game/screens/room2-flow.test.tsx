import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PuzzleInput } from '../../contracts/outputs';
import type { SessionView } from '../../contracts/view';
import { fakeViews } from '../dev/fakeViews';
import { clearDrafts } from '../device-drafts';
import { VictoryScreen } from '../VictoryScreen';
import { ROOM_2_SCREENS } from './index';
import type { PuzzleScreenProps } from './types';

// The Room 2 winning path as the registered screens see it: git ready -> rsa open -> tls open -> door open -> escaped.
const terminals: FakeTerminal[] = [];
class FakeTerminal {
  written: string[] = [];
  data: (data: string) => void = () => {};
  open = vi.fn(); loadAddon = vi.fn(); focus = vi.fn(); dispose = vi.fn(); clear = vi.fn();
  hasSelection = () => false; getSelection = () => '';
  attachCustomKeyEventHandler = vi.fn();
  constructor(public options: unknown) { terminals.push(this); }
  write(text: string) { this.written.push(text); }
  writeln(text: string) { this.written.push(`${text}\r\n`); }
  onData(listener: (data: string) => void) { this.data = listener; return { dispose: vi.fn() }; }
  get screen() { return this.written.join(''); }
}
vi.mock('../../vendor/xterm', () => ({ Terminal: FakeTerminal, FitAddon: class { fit = vi.fn(); activate() {} dispose() {} } }));

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabcd\n-----END RSA PRIVATE KEY-----\n';
const CARD = '4000000131941181';
const submit = vi.fn<(input: PuzzleInput) => Promise<'accepted'>>();
const openDoor = vi.fn();

/** Renders the registered screen for a slot against a fake view, as the room frame does. */
function open(slot: string, view: SessionView, puzzleKey = slot) {
  const Screen = ROOM_2_SCREENS[slot];
  const puzzle = view.currentRoom.puzzles.find(item => item.key === puzzleKey) ?? view.currentRoom.puzzles[0];
  const props: PuzzleScreenProps = { puzzle, view, submit: submit as PuzzleScreenProps['submit'], close: vi.fn(), openDoor };
  const ui = (next: PuzzleScreenProps) => <Screen {...next} />;
  const rendered = render(ui(props));
  return { ...rendered, update: (next: SessionView) => rendered.rerender(ui({ ...props, view: next,
    puzzle: next.currentRoom.puzzles.find(item => item.key === puzzle.key)! })) };
}
const status = (view: SessionView, key: string) => view.currentRoom.puzzles.find(item => item.key === key)!.status;
const type = (term: FakeTerminal, line: string) => act(async () => { for (const char of line) term.data(char); term.data('\r'); });

beforeEach(() => { terminals.length = 0; submit.mockReset().mockResolvedValue('accepted'); openDoor.mockReset().mockResolvedValue(undefined); localStorage.clear(); });
afterEach(() => { cleanup(); clearDrafts(); });

describe('Room 2 flow across the registered screens', () => {
  it('registers a real screen for every Room 2 slot', () => {
    expect(Object.keys(ROOM_2_SCREENS).sort()).toEqual(['capture-viewer', 'door', 'nethanel-git', 'rsa-decryptor', 'tls-decryptor']);
  });

  it('the fake views walk the puzzles in order', () => {
    const views = fakeViews();
    expect(['nethanel-git', 'rsa-decryptor', 'tls-decryptor', 'door'].map(key => status(views.room2GitReady, key))).toEqual(['open', 'locked', 'locked', 'locked']);
    expect(['nethanel-git', 'rsa-decryptor', 'tls-decryptor', 'door'].map(key => status(views.room2RsaOpen, key))).toEqual(['solved', 'open', 'locked', 'locked']);
    expect(['nethanel-git', 'rsa-decryptor', 'tls-decryptor', 'door'].map(key => status(views.room2TlsOpen, key))).toEqual(['solved', 'solved', 'open', 'locked']);
    expect(['nethanel-git', 'rsa-decryptor', 'tls-decryptor', 'door'].map(key => status(views.room2DoorOpen, key))).toEqual(['solved', 'solved', 'solved', 'open']);
  });

  it('1. git: the terminal submits command payloads, shows the blocked editor, and prints the key', async () => {
    const views = fakeViews();
    const { update } = open('nethanel-git', views.room2GitReady);
    await waitFor(() => expect(terminals).toHaveLength(1));
    await type(terminals[0], 'git log --oneline');
    expect(submit).toHaveBeenLastCalledWith({ kind: 'command', command: 'git log --oneline' });
    const listed = structuredClone(views.room2GitReady);
    listed.currentRoom.puzzles[0].latestResult = { commandId: 'c1', verdict: 'progress', reason: null, output: 'a1b2c3d Security fix: Removed private key from repository.\n' };
    listed.latestResult = listed.currentRoom.puzzles[0].latestResult;
    update(listed);
    expect(terminals[0].screen).toContain('Security fix');
    await type(terminals[0], 'vim server.key');
    expect(submit).toHaveBeenLastCalledWith({ kind: 'command', command: 'vim server.key' });
    const blocked = structuredClone(views.room2GitReady);
    blocked.currentRoom.puzzles[0].latestResult = { commandId: 'c2', verdict: 'rejected', reason: 'policyBlocked', output: '' };
    blocked.latestResult = blocked.currentRoom.puzzles[0].latestResult;
    update(blocked);
    expect(terminals[0].screen).toContain('Command not allowed');
    await type(terminals[0], 'git show HEAD~1:server.key');
    expect(submit).toHaveBeenLastCalledWith({ kind: 'command', command: 'git show HEAD~1:server.key' });
    const solved = structuredClone(views.room2RsaOpen);
    solved.currentRoom.puzzles[0].latestResult = { commandId: 'c3', verdict: 'solved', reason: null, output: PEM };
    solved.latestResult = solved.currentRoom.puzzles[0].latestResult;
    update(solved);
    expect(terminals[0].screen).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('2. capture viewer: encrypted before the TLS solve, decrypted payment after it', () => {
    const views = fakeViews();
    const encrypted = open('capture-viewer', views.room2TlsOpen, 'tls-decryptor');
    expect(document.body).toHaveTextContent('Cibus_payment_try.pcap');
    expect(document.body).toHaveTextContent('Application Data (encrypted)');
    expect(document.body).not.toHaveTextContent(CARD);
    encrypted.unmount();
    open('capture-viewer', views.room2DoorOpen, 'door');
    expect(document.body).toHaveTextContent('POST /api/v2/payments');
  });

  it('3. rsa: submits key, N and the encrypted PMS as an rsa payload', async () => {
    open('rsa-decryptor', fakeViews().room2RsaOpen);
    fireEvent.change(screen.getByLabelText('Private key'), { target: { value: PEM } });
    fireEvent.change(screen.getByLabelText('RSA modulus (N)'), { target: { value: 'bbb7' } });
    fireEvent.change(screen.getByLabelText('Encrypted PMS'), { target: { value: '8800' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decrypt' })); });
    expect(submit).toHaveBeenCalledWith({ kind: 'rsa', privateKey: PEM, encryptedPms: '8800', modulus: 'bbb7' });
  });

  it('4. tls: submits the PMS and the Client Random as a tls payload', async () => {
    open('tls-decryptor', fakeViews().room2TlsOpen);
    fireEvent.change(screen.getByLabelText('PMS'), { target: { value: `0303${'ab'.repeat(46)}` } });
    fireEvent.change(screen.getByLabelText('Client Random'), { target: { value: '4089f054' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decrypt' })); });
    expect(submit).toHaveBeenCalledWith({ kind: 'tls', pms: `0303${'ab'.repeat(46)}`, clientRandom: '4089f054' });
  });

  it('5. door: a wrong code is denied, the card number is accepted as an answer payload, then Open door', async () => {
    const views = fakeViews();
    const { update, container } = open('door', views.room2DoorOpen);
    fireEvent.change(screen.getByLabelText('Paste code'), { target: { value: '4000000131941182' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm code' })); });
    expect(submit).toHaveBeenLastCalledWith({ kind: 'answer', answer: '4000000131941182' });
    const denied = structuredClone(views.room2DoorOpen);
    const door = denied.currentRoom.puzzles.find(item => item.key === 'door')!;
    door.latestResult = { commandId: 'd1', verdict: 'rejected', reason: 'wrongAnswer', output: '' };
    update(denied);
    expect(screen.getByRole('status')).toHaveTextContent('ACCESS DENIED');
    fireEvent.change(screen.getByLabelText('Paste code'), { target: { value: CARD } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm code' })); });
    expect(submit).toHaveBeenLastCalledWith({ kind: 'answer', answer: CARD });
    const granted = structuredClone(views.room2DoorOpen);
    granted.currentRoom.puzzles.find(item => item.key === 'door')!.status = 'solved';
    granted.currentRoom.doorOpenedAt = null;
    update(granted);
    expect(screen.getByRole('status')).toHaveTextContent('ACCESS GRANTED');
    expect(container.querySelector('.keypad-display')).toHaveClass('granted');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open door' })); });
    expect(openDoor).toHaveBeenCalledTimes(1);
  });

  it('6. escaped: the victory screen replaces the room', () => {
    const view = fakeViews().room2Escaped;
    expect(view.status).toBe('Escaped');
    const restart = vi.fn();
    const { container } = render(<VictoryScreen toolbar={null} restart={restart} />);
    expect(container.querySelector('.stage[data-room="victory"]')).not.toBeNull();
    expect(screen.getByText('🎉 Welcome to the team!')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Return to game start/ }));
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
