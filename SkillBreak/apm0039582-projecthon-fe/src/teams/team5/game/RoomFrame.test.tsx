import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PuzzleInput } from '../contracts/outputs';
import type { PuzzleScreenProps } from './screens/types';
import { ROOM_1_ASSETS } from './room-design/room-assets';
import { fakeViews } from './dev/fakeViews';
import { setDanaDesktopOpen } from './room-1-progress';
import { ROOM_1_SCREENS } from './screens';
import { Countdown, RoomFrame } from './RoomFrame';

const sqlScreen = ({ submit }: PuzzleScreenProps) => <button type="button"
  onClick={() => void submit({ kind: 'command', command: 'SELECT 1' })}>Run query</button>;
const screens = { 'idan-db': sqlScreen };
const submit = vi.fn<(_key: string, _input: PuzzleInput) => Promise<'accepted'>>().mockResolvedValue('accepted');
/** Room-1 progress is kept per session, so each test that solves something plays its own session. */
const inSession = <T extends { sessionId: string }>(view: T, sessionId: string): T => ({ ...view, sessionId });

beforeEach(() => {
  submit.mockClear();
  vi.stubGlobal('Audio', vi.fn(() => ({ play: vi.fn().mockResolvedValue(undefined) })));
});
afterEach(() => vi.unstubAllGlobals());

describe('reference RoomFrame adapted to the current session view', () => {
  it('keeps an open SQL window and its draft through disconnection and recovery', () => {
    const view = inSession(fakeViews().ready, 'connection-recovery');
    const { rerender } = render(<RoomFrame view={view} connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={null} />);
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    fireEvent.change(screen.getByLabelText('SQL query'), { target: { value: 'SELECT * FROM logs ORDER BY happened_at' } });
    rerender(<RoomFrame view={view} connection="retrying" submit={submit} screens={ROOM_1_SCREENS} toolbar={null} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Cannot reach the server');
    expect(screen.getByLabelText('SQL query')).toHaveValue('SELECT * FROM logs ORDER BY happened_at');
    rerender(<RoomFrame view={view} connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={null} />);
    expect(screen.queryByText(/Cannot reach the server/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('SQL query')).toHaveValue('SELECT * FROM logs ORDER BY happened_at');
  });
  it('opens the registered puzzle screen and closes the zoom with Escape or the backdrop', () => {
    render(<RoomFrame view={fakeViews().ready} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={screens} toolbar={document.body} />);
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    expect(screen.getByRole('dialog', { name: "Idan's computer · SQL" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    expect(submit).toHaveBeenCalledWith('idan-db', { kind: 'command', command: 'SELECT 1' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    fireEvent.click(screen.getByRole('button', { name: 'Close puzzle' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the window open for clicks on the screen, closes it for the empty window area (design L1226-1232)', () => {
    const pictureScreen = () => <><div className="modal-title">Title</div>
      <div className="interactive-screen"><span>Screen body</span></div><div className="window-shell"><span>Terminal</span></div></>;
    render(<RoomFrame view={fakeViews().ready} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={{ 'idan-db': pictureScreen }} toolbar={document.body} />);
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    fireEvent.click(screen.getByText('Screen body'));
    fireEvent.click(screen.getByText('Terminal'));
    // Selecting text: the press starts on the screen and is released on the backdrop.
    fireEvent.mouseDown(screen.getByText('Screen body'));
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Title').parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses the room design assets and locks puzzles from the projected view', () => {
    const { container } = render(<RoomFrame view={fakeViews().starting} serverTime="2026-11-03T10:00:00.000Z"
      connection="connecting" submit={submit} screens={screens} toolbar={document.body} />);
    expect(container.querySelector('.room-bg')?.getAttribute('src')).toBe(ROOM_1_ASSETS['room-background-closed']);
    const dana = screen.getByRole('button', { name: "Dana's computer (locked)" });
    expect(dana).toHaveAttribute('aria-disabled', 'true');
    expect(dana.querySelector('img')).toHaveAttribute('src', ROOM_1_ASSETS['login-screen']);
    // Like the design, room 1 shows no door control until Dana's desktop opens it.
    expect(container.querySelector('.door')).toBeNull();
    expect(screen.getByText("Dana's room").parentElement).toHaveTextContent("Dana's room01 / 03");
    fireEvent.click(screen.getByRole('button', { name: 'Hash Cracker (locked)' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Hash CrackerLockedClick outside the window or press Esc to go back');
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows the open-room file on Dana's computer after her login is solved", () => {
    const solved = structuredClone(fakeViews().login);
    solved.currentRoom.puzzles.find(puzzle => puzzle.key === 'dana-login')!.status = 'solved';
    const { rerender } = render(<RoomFrame view={inSession(fakeViews().ready, 'desktop-transition')} connection="live"
      submit={submit} screens={ROOM_1_SCREENS} toolbar={null} />);
    const dana = screen.getByRole('button', { name: "Dana's computer (locked)" });
    expect(dana.querySelector('img')).toHaveAttribute('src', ROOM_1_ASSETS['login-screen']);
    rerender(<RoomFrame view={inSession(solved, 'desktop-transition')} connection="live"
      submit={submit} screens={ROOM_1_SCREENS} toolbar={null} />);
    const openDana = screen.getByRole('button', { name: "Dana's computer" });
    expect(openDana.querySelector('img')).toHaveAttribute('src', ROOM_1_ASSETS['computer-open-empty']);
    expect(openDana.querySelector('.desktop-open-file')).toHaveAttribute('src', ROOM_1_ASSETS['open-room-file']);
  });

  it('shows room 2 directly after a reload once the room was opened', () => {
    render(<RoomFrame view={inSession(fakeViews().room2, 'opened-before')} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
    expect(screen.getByText("Nathanel's room")).toBeInTheDocument();
    expect(screen.getByText('ROOM 02 · CIBUS PAYMENT')).toBeInTheDocument();
    expect(screen.getByText('02 / 03')).toBeInTheDocument();
    expect(Audio).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("shows the desktop in the open login window; closing only hides it, the open-room file opens the door", async () => {
    vi.useFakeTimers();
    try {
      const views = fakeViews();
      const { rerender } = render(<RoomFrame view={inSession(views.login, 'held')} serverTime="2026-11-03T10:00:00.000Z"
        connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
      fireEvent.click(screen.getByRole('button', { name: "Dana's computer" }));
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      rerender(<RoomFrame view={inSession(views.room2, 'held')} serverTime="2026-11-03T10:00:00.000Z"
        connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
      expect(screen.getByRole('dialog', { name: "Dana's computer" })).toHaveTextContent("Dana's computer · Desktop");
      expect(document.activeElement).toHaveClass('modal-content');
      fireEvent.keyDown(document, { key: 'Escape' });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText("Nathanel's room")).not.toBeInTheDocument();
      // Room 1 keeps its last puzzles while the view is already in room 2.
      expect(screen.getByRole('button', { name: 'Hash Cracker' })).toHaveAttribute('aria-disabled', 'false');
      fireEvent.click(screen.getByRole('button', { name: "Dana's computer" }));
      fireEvent.click(screen.getByRole('button', { name: 'Close puzzle' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: "Dana's computer" }));
      fireEvent.click(screen.getByRole('button', { name: 'Open room' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(849); });
      expect(screen.getByRole('button', { name: "Dana's computer" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.getByText("Nathanel's room")).toBeInTheDocument();
    expect(screen.getByText('ROOM 02 · CIBUS PAYMENT')).toBeInTheDocument();
      expect(submit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('does not pop the desktop up when the solve arrives with no window or another window open', () => {
    const views = fakeViews();
    const { rerender } = render(<RoomFrame view={inSession(views.login, 'no-popup')} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hash Cracker' }));
    rerender(<RoomFrame view={inSession(views.room2, 'no-popup')} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
    expect(screen.getByRole('dialog', { name: 'Hash Cracker' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open room' })).not.toBeInTheDocument();
    // Room 1's puzzles are gone from the view, so the device no longer sends anything.
    fireEvent.click(screen.getByRole('button', { name: 'CRACK' }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText("Nathanel's room")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Dana's computer" }));
    expect(screen.getByRole('button', { name: 'Open room' })).toBeInTheDocument();
  });

  it("keeps the held desktop after a reload in room 2 until Dana's computer is opened", () => {
    setDanaDesktopOpen('reloaded', true);
    render(<RoomFrame view={inSession(fakeViews().room2, 'reloaded')} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
    expect(screen.queryByText("Nathanel's room")).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Dana's computer/ }));
    expect(screen.getByRole('dialog', { name: "Dana's computer" })).toContainElement(screen.getByRole('button', { name: 'Open room' }));
  });

  it('gives the focus back to the hotspot that opened the window, without scrolling', () => {
    render(<RoomFrame view={fakeViews().ready} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={screens} toolbar={document.body} />);
    const hotspot = screen.getByRole('button', { name: "Idan's computer · SQL" });
    const focus = vi.spyOn(hotspot, 'focus');
    // A mouse click does not always focus the button (Safari), so the opener is remembered from the click.
    fireEvent.click(hotspot);
    expect(hotspot).not.toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hotspot).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('brings Tab focus that left the window back to its first control (design L1240-1243)', () => {
    render(<RoomFrame view={fakeViews().ready} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={screens} toolbar={document.body} />);
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close puzzle' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Run query' })).toHaveFocus();
  });

  describe('transparent pixels of a hotspot picture (design hitOpaquePixel)', () => {
    const spies: { mockRestore(): void }[] = [];
    function laidOutPictures(context: CanvasRenderingContext2D | null) {
      spies.push(vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true),
        vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(200),
        vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(100),
        vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue(
          { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }),
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never));
    }
    afterEach(() => spies.splice(0).forEach(spy => spy.mockRestore()));

    it('ignores a mouse click on a transparent pixel; keyboard activation always opens', () => {
      const getImageData = vi.fn((x: number) => ({ data: [0, 0, 0, x < 100 ? 0 : 255] }));
      laidOutPictures({ drawImage: vi.fn(), getImageData } as unknown as CanvasRenderingContext2D);
      render(<RoomFrame view={fakeViews().hash} serverTime="2026-11-03T10:00:00.000Z"
        connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
      const hash = screen.getByRole('button', { name: 'Hash Cracker' });
      fireEvent.click(hash, { detail: 1, clientX: 20, clientY: 20 });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(getImageData).toHaveBeenCalledWith(10, 10, 1, 1);
      fireEvent.click(hash, { detail: 1, clientX: 300, clientY: 20 });
      expect(screen.getByRole('dialog', { name: 'Hash Cracker' })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(hash, { detail: 0, clientX: 20, clientY: 20 });
      expect(screen.getByRole('dialog', { name: 'Hash Cracker' })).toBeInTheDocument();
    });

    it('lets the click through when no canvas is available', () => {
      laidOutPictures(null);
      render(<RoomFrame view={fakeViews().ready} serverTime="2026-11-03T10:00:00.000Z"
        connection="live" submit={submit} screens={screens} toolbar={document.body} />);
      fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }), { detail: 1, clientX: 20, clientY: 20 });
      expect(screen.getByRole('dialog', { name: "Idan's computer · SQL" })).toBeInTheDocument();
    });

    it('closes an image-backed component when clicked on a transparent pixel', () => {
      const getImageData = vi.fn((x: number) => ({ data: [0, 0, 0, x < 100 ? 0 : 255] }));
      laidOutPictures({ drawImage: vi.fn(), getImageData } as unknown as CanvasRenderingContext2D);
      render(<RoomFrame view={fakeViews().hash} serverTime="2026-11-03T10:00:00.000Z"
        connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
      fireEvent.click(screen.getByRole('button', { name: 'Hash Cracker' }));
      const screenPicture = screen.getByRole('form', { name: 'Hash Cracker' });
      fireEvent.mouseDown(screenPicture, { clientX: 300, clientY: 20 });
      fireEvent.click(screenPicture, { clientX: 300, clientY: 20 });
      expect(screen.getByRole('dialog', { name: 'Hash Cracker' })).toBeInTheDocument();
      fireEvent.mouseDown(screenPicture, { clientX: 20, clientY: 20 });
      fireEvent.click(screenPicture, { clientX: 20, clientY: 20 });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(getImageData).toHaveBeenLastCalledWith(10, 10, 1, 1);
    });
  });

  it('shows the inventory note once the hash is cracked and wires the real screens', () => {
    render(<RoomFrame view={inSession(fakeViews().hash, 'inventory')} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
    expect(screen.queryByText(/password \(cracked\)/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hash Cracker' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Input hash' }), { target: { value: ' abc ' } });
    fireEvent.click(screen.getByRole('button', { name: 'CRACK' }));
    expect(submit).toHaveBeenCalledWith('hash-cracker', { kind: 'answer', answer: 'abc' });
    cleanup();
    render(<RoomFrame view={inSession(fakeViews().login, 'inventory')} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} />);
    expect(screen.getByText("Inventory: Dana's password (cracked)")).toBeInTheDocument();
  });

  it('uses a monotonic countdown from the server sample', async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      vi.setSystemTime(new Date('2026-11-03T15:00:00.000Z'));
      const { rerender } = render(<Countdown deadlineAt="2026-11-03T10:45:00.000Z" serverTime="2026-11-03T10:00:00.000Z" />);
      expect(screen.getByRole('timer')).toHaveTextContent('45:00');
      elapsed = 1000;
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByRole('timer')).toHaveTextContent('44:59');
      elapsed = 5 * 60 * 1000;
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByRole('timer')).toHaveTextContent('40:00');
      rerender(<Countdown deadlineAt="2026-11-03T10:45:00.000Z" serverTime="2026-11-03T10:05:00.000Z" />);
      expect(screen.getByRole('timer')).toHaveTextContent('40:00');
      elapsed = 46 * 60 * 1000;
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByRole('timer')).toHaveTextContent('00:00');
    } finally { monotonicNow.mockRestore(); vi.useRealTimers(); }
  });

  it('does not submit after the session is terminal', () => {
    const ended = { ...fakeViews().ready, status: 'Abandoned' as const };
    render(<RoomFrame view={ended} serverTime="2026-11-03T10:00:00.000Z"
      connection="live" submit={submit} screens={screens} toolbar={document.body} />);
    fireEvent.click(screen.getByRole('button', { name: "Idan's computer · SQL" }));
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    expect(submit).not.toHaveBeenCalled();
  });
  it('keeps login and file clicks in Room 1 until the physical door entry is projected', async () => {
    const view = inSession(fakeViews().login, 'server-door');
    view.currentRoom.doorOpenedAt = null;
    view.currentRoom.puzzles.find(puzzle => puzzle.key === 'dana-login')!.status = 'solved';
    const door = vi.fn().mockResolvedValue(undefined);
    const frame = (snapshot = view) => <RoomFrame view={snapshot} connection="live" submit={submit} screens={ROOM_1_SCREENS} toolbar={document.body} door={door} />;
    const { rerender } = render(frame());
    fireEvent.click(screen.getByRole('button', { name: "Dana's computer" }));
    expect(screen.getByRole('button', { name: 'Open room' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enter Room 2' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open room' })); });
    expect(door).toHaveBeenCalledWith('open-door');
    expect(screen.getByText("Dana's room")).toBeInTheDocument();
    const opened = { ...view, currentRoom: { ...view.currentRoom, doorOpenedAt: '2026-11-03T10:01:00Z' } };
    rerender(frame(opened));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter Room 2' })); });
    expect(door).toHaveBeenLastCalledWith('enter');
    expect(screen.getByText("Dana's room")).toBeInTheDocument();
    const room2 = inSession(fakeViews().room2, view.sessionId);
    room2.currentRoom.doorOpenedAt = null;
    rerender(frame(room2));
    expect(screen.getByText("Nathanel's room")).toBeInTheDocument();
    expect(screen.getByText('ROOM 02 · CIBUS PAYMENT')).toBeInTheDocument();
  });

  it('plays the opening-door sound on each closed-to-open transition, not on initial state', () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const audio = vi.fn(() => ({ play }));
    vi.stubGlobal('Audio', audio);
    try {
      const closed = inSession(fakeViews().ready, 'door-sound');
      closed.currentRoom.doorOpenedAt = null;
      const frame = (view: typeof closed) => <RoomFrame view={view} connection="live" submit={submit}
        screens={screens} toolbar={document.body} />;
      const { rerender } = render(frame(closed));
      expect(audio).not.toHaveBeenCalled();
      const opened = { ...closed, currentRoom: { ...closed.currentRoom, doorOpenedAt: '2026-11-03T10:01:00Z' } };
      rerender(frame(opened));
      expect(audio).toHaveBeenCalledWith(expect.stringContaining('opening-door.mp3'));
      expect(play).toHaveBeenCalledTimes(1);
      rerender(frame(opened));
      expect(play).toHaveBeenCalledTimes(1);
      rerender(frame(closed));
      rerender(frame(opened));
      expect(play).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });
});
