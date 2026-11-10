import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PuzzleInput } from '../contracts/outputs';
import type { PuzzleScreenProps } from './screens/types';
import { ROOM_2_ASSETS } from './room-design/room-assets';
import { fakeViews } from './dev/fakeViews';
import { ROOM_1_SCREENS, ROOM_2_SCREENS } from './screens';
import { RoomFrame } from './RoomFrame';

const submit = vi.fn<(_key: string, _input: PuzzleInput) => Promise<'accepted'>>().mockResolvedValue('accepted');
const screens = { ...ROOM_1_SCREENS, ...ROOM_2_SCREENS };
const frame = (view = fakeViews().room2, extra: Partial<Parameters<typeof RoomFrame>[0]> = {}) =>
  <RoomFrame view={view} serverTime="2026-11-03T10:00:00.000Z" connection="live" submit={submit} screens={screens} toolbar={document.body} {...extra} />;

beforeEach(() => { submit.mockClear(); vi.stubGlobal('Audio', vi.fn(() => ({ play: vi.fn().mockResolvedValue(undefined) }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Room 2 scene', () => {
  it('renders Nathanel\'s room from the session view: toolbar, tag, backgrounds, hotspots at the design percentages', () => {
    const { container } = render(frame());
    expect(screen.getByText("Nathanel's room")).toBeInTheDocument();
    expect(screen.getByText('02 / 03')).toBeInTheDocument();
    expect(screen.getByText('ROOM 02 · CIBUS PAYMENT')).toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    const backgrounds = container.querySelectorAll('img.room-bg');
    expect(backgrounds[0]).toHaveAttribute('src', ROOM_2_ASSETS['room-background-closed']);
    expect(backgrounds[1]).toHaveAttribute('src', ROOM_2_ASSETS['room-background-open']);
    expect(backgrounds[1]).not.toHaveClass('is-visible');
    const board = screen.getByRole('button', { name: "Nathanel's task board" });
    expect(board).toHaveStyle({ left: '37.4%', top: '1.7%', width: '36.5%', height: '37.6%', zIndex: '1' });
    expect(screen.getByRole('button', { name: "Nathanel's computer · Git / PCAP" })).toHaveStyle({ left: '35%', top: '32%', width: '22%', zIndex: '4' });
    expect(screen.getByRole('button', { name: /^RSA Decryptor/ })).toHaveStyle({ left: '20%', top: '54.5%', width: '27%' });
    expect(screen.getByRole('button', { name: /^TLS Decryptor/ })).toHaveStyle({ left: '49%', top: '53.4%', width: '29.6%' });
    expect(screen.getByRole('button', { name: /^Exit keypad/ })).toHaveStyle({ left: '84%', top: '37%', width: '12%', zIndex: '5' });
    expect(container.querySelectorAll('.scene-decoration')).toHaveLength(3);
    expect(screen.getByText('Sandbox starting')).toBeInTheDocument();
    expect(screen.getByText('0 / 4 solved')).toBeInTheDocument();
  });

  it('shows the open background when the server says the door is open, and walks through with the enter action', async () => {
    const door = vi.fn().mockResolvedValue(undefined);
    const view = fakeViews().room2DoorOpen;
    view.currentRoom.doorOpenedAt = '2026-11-03T10:01:00Z';
    const { container } = render(frame(view, { door }));
    expect(container.querySelector('.room-bg-open')).toHaveClass('is-visible');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Go to the victory room' })); });
    expect(door).toHaveBeenCalledWith('enter');
  });

  it('opens the door from the keypad once the code is solved, then closes the keypad', async () => {
    const door = vi.fn().mockResolvedValue(undefined);
    const view = fakeViews().room2DoorOpen;
    view.currentRoom.doorOpenedAt = null;
    view.currentRoom.puzzles.find(item => item.key === 'door')!.status = 'solved';
    render(frame(view, { door }));
    fireEvent.click(screen.getByRole('button', { name: /^Exit keypad/ }));
    const dialog = screen.getByRole('dialog', { name: /^Exit keypad/ });
    expect(dialog).toHaveTextContent('ACCESS GRANTED');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Open door' })); });
    expect(door).toHaveBeenCalledWith('open-door');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the exit door locked and hints at the keypad for a moment', () => {
    vi.useFakeTimers();
    try {
      render(frame(fakeViews().room2DoorOpen));
      const door = screen.getByRole('button', { name: 'Locked door, enter the code on the keypad' });
      expect(door).toHaveTextContent('🔒 Code required');
      fireEvent.click(door);
      expect(door).toHaveTextContent('🔒 Enter the code on the keypad');
      act(() => { vi.advanceTimersByTime(1600); });
      expect(door).toHaveTextContent('🔒 Code required');
    } finally { vi.useRealTimers(); }
  });

  it('opens the task board close-up and goes back with Escape', () => {
    render(frame());
    fireEvent.click(screen.getByRole('button', { name: "Nathanel's task board" }));
    const dialog = screen.getByRole('dialog', { name: "Nathanel's task board" });
    expect(within(dialog).getByRole('img', { name: "Nathanel's task board" })).toHaveAttribute('src', ROOM_2_ASSETS['task-board']);
    expect(dialog).toHaveTextContent('Click outside the picture to return to the room');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens Nathanel\'s desktop with the two files, and steps back file -> desktop -> room', () => {
    render(frame());
    fireEvent.click(screen.getByRole('button', { name: "Nathanel's computer · Git / PCAP" }));
    const dialog = screen.getByRole('dialog', { name: "Nathanel's computer · Git / PCAP" });
    expect(dialog).toHaveTextContent("Nathanel's computer · Cibus Payment");
    expect(dialog.querySelector('.desktop-screen')).toHaveAttribute('src', ROOM_2_ASSETS['computer-desktop']);
    expect(within(dialog).getByRole('button', { name: 'Open project_cibus_payment' })).toHaveClass('desktop-file', 'git-file');
    expect(within(dialog).getByRole('button', { name: 'Open Cibus_payment_try.pcap' })).toHaveClass('desktop-file', 'pcap-file');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open project_cibus_payment' }));
    expect(dialog).toHaveTextContent('⌘ Netanel · Git terminal · project_cibus_payment');
    fireEvent.click(within(dialog).getByRole('button', { name: "← Nathanel's computer" }));
    expect(screen.getByRole('dialog')).toHaveTextContent("Nathanel's computer · Cibus Payment");
    fireEvent.click(screen.getByRole('button', { name: 'Open project_cibus_payment' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toHaveTextContent("Nathanel's computer · Cibus Payment");
    fireEvent.click(screen.getByRole('button', { name: 'Open Cibus_payment_try.pcap' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Wireshark · Cibus_payment_try.pcap');
    fireEvent.click(screen.getByRole('button', { name: "← Nathanel's computer" }));
    expect(screen.getByRole('dialog')).toHaveTextContent("Nathanel's computer · Cibus Payment");
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('plugs a registered screen into a file slot without faking puzzle logic', () => {
    const gitScreen = ({ puzzle, submit: send }: PuzzleScreenProps) => <button type="button"
      onClick={() => void send({ kind: 'command', command: 'git log' })}>{`git ${puzzle.key}`}</button>;
    render(frame(fakeViews().room2GitReady, { screens: { ...screens, 'nethanel-git': gitScreen } }));
    fireEvent.click(screen.getByRole('button', { name: "Nathanel's computer · Git / PCAP" }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project_cibus_payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'git nethanel-git' }));
    expect(submit).toHaveBeenCalledWith('nethanel-git', { kind: 'command', command: 'git log' });
  });

  it('opens a Locked panel for locked machines and the registered slot once they are open', () => {
    const { rerender } = render(frame(fakeViews().room2GitReady));
    const rsa = screen.getByRole('button', { name: 'RSA Decryptor (locked)' });
    expect(rsa).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(rsa);
    expect(screen.getByRole('dialog', { name: 'RSA Decryptor' })).toHaveTextContent('Locked');
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(frame(fakeViews().room2RsaOpen));
    fireEvent.click(screen.getByRole('button', { name: 'RSA Decryptor' }));
    expect(screen.getByRole('dialog', { name: 'RSA Decryptor' })).toContainElement(screen.getByLabelText('Private key'));
    expect(screen.getByText('1 / 4 solved')).toBeInTheDocument();
  });

  it('reports the git sandbox status in the footer', () => {
    const { rerender } = render(frame(fakeViews().room2GitReady));
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const failed = fakeViews().room2;
    failed.currentRoom.puzzles[0].sandbox.status = 'failed';
    rerender(frame(failed));
    expect(screen.getByText('Sandbox failed')).toBeInTheDocument();
    const restarting = fakeViews().room2;
    restarting.currentRoom.puzzles[0].sandbox.generation = 2;
    rerender(frame(restarting));
    expect(screen.getByText('Sandbox restarting')).toBeInTheDocument();
  });

  it('does not accept input for a puzzle the view no longer lists', () => {
    const gitScreen = ({ submit: send }: PuzzleScreenProps) => <button type="button"
      onClick={() => void send({ kind: 'command', command: 'ls' })}>run</button>;
    const view = fakeViews().room2GitReady; view.status = 'Expired';
    render(frame(view, { screens: { ...screens, 'nethanel-git': gitScreen } }));
    fireEvent.click(screen.getByRole('button', { name: "Nathanel's computer · Git / PCAP" }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project_cibus_payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    expect(submit).not.toHaveBeenCalled();
  });
});
