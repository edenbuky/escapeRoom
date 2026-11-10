import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Clock3, LockKeyhole } from '../vendor/icons';
import openingDoorSound from '../assets/opening-door.mp3';
import type { SessionView } from '../contracts/view';
import type { PuzzleInput } from '../contracts/outputs';
import type { PuzzleScreenProps, SubmitResult } from './screens/types';
import { ZoomPanel } from './ZoomPanel';
import { DanaDesktop } from './screens/dana-login';
import { percentBox } from './screens/shared/DeviceScreen';
import { hitOpaquePixel } from './opaque-pixel';
import { markPasswordCracked, readRoom1Progress, setDanaDesktopOpen } from './room-1-progress';
import room1Design from './room-design/room-1.design.json';
import { ROOM_1_ASSETS, type RoomAssetId } from './room-design/room-assets';
import { ROOM_2_PUZZLE_KEYS } from '../contracts/keys';
import { Room2Stage, room2Title } from './Room2Stage';
import { DESKTOP_WINDOW, Room2Window, type Room2Target } from './Room2Window';

export function Countdown({ deadlineAt, serverTime }: { deadlineAt: string; serverTime?: string }) {
  const initialRemaining = serverTime ? Date.parse(deadlineAt) - Date.parse(serverTime) : Number.NaN;
  const [remaining, setRemaining] = useState(() => Number.isFinite(initialRemaining) ? Math.max(0, initialRemaining) : 0);
  useEffect(() => {
    const remainingAtSample = Date.parse(deadlineAt) - Date.parse(serverTime ?? '');
    if (!Number.isFinite(remainingAtSample)) return;
    const sampledAt = performance.now();
    const tick = () => setRemaining(Math.max(0, remainingAtSample - (performance.now() - sampledAt)));
    tick(); const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadlineAt, serverTime]);
  const seconds = Math.ceil(remaining / 1000);
  return <span className={`t5-clock ${seconds === 0 ? 't5-time-up' : ''}`} role="timer" aria-label="Time remaining">
    {Number.isFinite(initialRemaining) ? <><Clock3 size={18} /><span>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</span>
      {seconds === 0 && <span>Time is up</span>}</> : <span>Syncing timer…</span>}
  </span>;
}

const characterName = (characterId: string) =>
  room1Design.characters[characterId as keyof typeof room1Design.characters].displayName;

function hotspotLabel(puzzleId: string | undefined) {
  const hotspot = room1Design.hotspots.find(candidate => candidate.puzzleId === puzzleId);
  if (!hotspot) return 'Puzzle';
  return hotspot.characterId ? `${characterName(hotspot.characterId)}'s ${hotspot.label}` : hotspot.label;
}

export function RoomFrame({ view, serverTime, connection, submit, screens, toolbar, door }: {
  view: SessionView; connection: string; submit: (puzzleKey: string, input: PuzzleInput) => Promise<SubmitResult>;
  serverTime?: string;
  screens?: Partial<Record<string, ComponentType<PuzzleScreenProps>>>;
  /** The page header element the room toolbar (room count and timer) renders into. */
  toolbar: HTMLElement | null;
  door?: (action: 'open-door' | 'enter') => Promise<void>;
}) {
  const { sessionId } = view;
  const authoritativeDoor = view.currentRoom.doorOpenedAt !== undefined;
  const [doorPending, setDoorPending] = useState(false);
  const [doorError, setDoorError] = useState('');
  const doorAction = async (action: 'open-door' | 'enter') => {
    if (!door || doorPending || view.status !== 'Active') return;
    setDoorPending(true); setDoorError('');
    try { await door(action); if (action === 'open-door') { setActive(undefined); setActive2(undefined); } }
    catch { setDoorError('Door request failed. Try again.'); }
    finally { setDoorPending(false); }
  };
  const [progress, setProgress] = useState(() => readRoom1Progress(sessionId));
  const remember = (change: () => void) => { change(); setProgress(readRoom1Progress(sessionId)); };
  const [active, setActive] = useState<string>();
  const [active2, setActive2] = useState<Room2Target>();
  useEffect(() => { if (authoritativeDoor) setActive(undefined); }, [authoritativeDoor, view.currentRoom.key]);
  const trigger = useRef<HTMLElement | null>(null);
  const [doorOpened, setDoorOpened] = useState(false);
  const isDoorOpen = authoritativeDoor ? Boolean(view.currentRoom.doorOpenedAt) : doorOpened;
  const wasDoorOpen = useRef<boolean>();
  const previousRoom = useRef(view.currentRoom.key);
  const enteredRoomTwo = useRef(false);
  useEffect(() => {
    if (wasDoorOpen.current === false && isDoorOpen && (authoritativeDoor || enteredRoomTwo.current)) {
      const playback = new Audio(openingDoorSound).play();
      void playback?.catch(() => undefined);
      enteredRoomTwo.current = false;
    }
    wasDoorOpen.current = isDoorOpen;
  }, [authoritativeDoor, isDoorOpen]);
  // A reload while Dana's desktop is held keeps room 1 on screen even though the view is already in room 2.
  const [displayedRoom, setDisplayedRoom] = useState(() => progress.danaDesktopOpen ? 'room-1' : view.currentRoom.key);
  const displayingRoomTwo = (authoritativeDoor ? view.currentRoom.key : displayedRoom) === 'room-2';
  // While Dana's desktop is held (and during the door animation) the view is already in room 2:
  // room 1's hotspots keep the last room-1 puzzles the view showed.
  const lastRoom1Puzzles = useRef(view.currentRoom.puzzles);
  useEffect(() => { if (view.currentRoom.key === 'room-1') lastRoom1Puzzles.current = view.currentRoom.puzzles; });
  const puzzles = view.currentRoom.key === 'room-1' ? view.currentRoom.puzzles : lastRoom1Puzzles.current;
  const puzzle = puzzles.find(candidate => candidate.key === active);
  const Screen = active ? screens?.[active] : undefined;
  const sandbox = puzzles.find(candidate => candidate.key === 'idan-db')?.sandbox.status;
  const status = sandbox === 'ready' ? 'Ready' : sandbox === 'failed' ? 'Sandbox failed' : 'Sandbox starting';
  // Room 2 comes straight from the session view: the git sandbox status and the solved count are the view's.
  const room2Puzzles = view.currentRoom.key === 'room-2' ? view.currentRoom.puzzles : [];
  const gitPuzzle = room2Puzzles.find(candidate => candidate.key === ROOM_2_PUZZLE_KEYS.git);
  const gitSandbox = gitPuzzle?.sandbox;
  const restarting = gitSandbox?.status === 'provisioning' && (gitSandbox.generation > 1
    || (gitPuzzle?.latestResult?.verdict === 'rejected' && gitPuzzle.latestResult.reason === 'sandboxRestarting'));
  const room2Status = gitSandbox?.status === 'ready' ? 'Ready' : gitSandbox?.status === 'failed' ? 'Sandbox failed'
    : restarting ? 'Sandbox restarting' : 'Sandbox starting';
  const solved = (key: string) => view.currentRoom.puzzles.some(item => item.key === key && item.status === 'solved');
  const hashSolved = solved('hash-cracker');
  const danaSolved = solved('dana-login');
  const seen = useRef({ room: view.currentRoom.key, danaSolved });
  const image = (assetId: string) => ROOM_1_ASSETS[assetId as RoomAssetId];
  useEffect(() => {
    if (hashSolved) remember(() => markPasswordCracked(sessionId));
  }, [hashSolved, sessionId]);
  useEffect(() => {
    // Solving Dana's login is the only way out of room 1; the server may project the solve and the move in one view.
    if (authoritativeDoor) return;
    const leftRoomOne = seen.current.room === 'room-1' && view.currentRoom.key === 'room-2';
    // Once the solve was seen (and latched), a later move to room 2 does not hold the desktop again.
    if (!seen.current.danaSolved && (danaSolved || leftRoomOne)) remember(() => setDanaDesktopOpen(sessionId, true));
    seen.current = { room: view.currentRoom.key, danaSolved };
  }, [view.currentRoom.key, danaSolved, sessionId]);
  useEffect(() => {
    enteredRoomTwo.current = previousRoom.current === 'room-1' && view.currentRoom.key === 'room-2';
    previousRoom.current = view.currentRoom.key;
  }, [view.currentRoom.key]);
  useEffect(() => {
    if (authoritativeDoor) return;
    if (view.currentRoom.key !== 'room-2') {
      setDisplayedRoom(view.currentRoom.key);
      setDoorOpened(false);
      return;
    }
    // Reads storage, not state: the latch effect above may have set it in this same commit.
    if (readRoom1Progress(sessionId).danaDesktopOpen) return;
    setDoorOpened(true);
    const transition = window.setTimeout(() => setDisplayedRoom('room-2'), 850);
    return () => window.clearTimeout(transition);
  }, [view.currentRoom.key, progress.danaDesktopOpen, sessionId]);
  // Only the desktop's open-room file lets the door open (design L762-769); closing the window only hides the desktop.
  const openRoom = () => { remember(() => setDanaDesktopOpen(sessionId, false)); setActive(undefined); };
  const closePuzzle = () => setActive(undefined);
  // The held desktop shows only in Dana's window: opened from her computer, or the login the player was looking at.
  const desktopHeld = !authoritativeDoor && progress.danaDesktopOpen && active === 'dana-login';
  const shown = desktopHeld || (active === 'dana-login' && puzzle?.status === 'solved') ? 'desktop'
    : puzzle?.status === 'locked' ? 'locked' : 'screen';
  const acceptsInput = (key: string) => view.status === 'Active' && view.currentRoom.puzzles.some(item => item.key === key);
  const roomNumber = displayingRoomTwo ? 2 : 1;
  return <>
    {toolbar && createPortal(<>
      <div className="room-count" aria-live="polite">
        <span>{displayingRoomTwo ? room2Title : `${characterName(room1Design.title.characterId)}'s room`}</span>
        <div className="room-dots" aria-hidden="true">{[1, 2, 3].map(room => <span key={room} className={`dot ${room === roomNumber ? 'active' : ''}`} />)}</div>
        <span>{String(roomNumber).padStart(2, '0')} / 03</span>
      </div>
      <Countdown deadlineAt={view.deadlineAt} serverTime={serverTime} />
    </>, toolbar)}
    <section className="stage-frame" aria-label="Interactive escape room">
      {displayingRoomTwo ? <Room2Stage view={view} open={Boolean(view.currentRoom.doorOpenedAt)} enterPending={doorPending}
        onOpen={(hotspot, opener) => { trigger.current = opener; setActive2({ hotspotId: hotspot.id, window: DESKTOP_WINDOW }); }}
        onEnter={() => void doorAction('enter')} /> : <div className="stage">
        <img className="room-bg" src={image(room1Design.stage.backgrounds.closed)} alt="" draggable={false} />
        <img className={`room-bg room-bg-open ${(authoritativeDoor ? view.currentRoom.doorOpenedAt : doorOpened) ? 'is-visible' : ''}`} src={image(room1Design.stage.backgrounds.open)} alt="" draggable={false} />
        {authoritativeDoor && view.currentRoom.doorOpenedAt && <button type="button" className="t5-door-hotspot"
          aria-label="Enter Room 2" title="Enter Room 2" disabled={doorPending || view.status !== 'Active'}
          style={{ ...percentBox(room1Design.door), zIndex: room1Design.door.zIndex }} onClick={() => void doorAction('enter')} />}
        <span className="room-tag">{room1Design.tag} · {characterName(room1Design.title.characterId).toUpperCase()}'S {room1Design.title.suffix.toUpperCase()}</span>
        {room1Design.decorations.map(decoration => <img key={decoration.id} className="scene-decoration"
          data-decoration={decoration.id} src={image(decoration.assetId)} alt="" draggable={false}
          style={{ ...percentBox(decoration), zIndex: decoration.zIndex }} />)}
        {room1Design.hotspots.map(hotspot => {
          const item = puzzles.find(candidate => candidate.key === hotspot.puzzleId);
          const locked = !item || item.status === 'locked';
          const desktopOpen = hotspot.puzzleId === 'dana-login' && item?.status === 'solved';
          const name = `${hotspotLabel(hotspot.puzzleId)}${locked ? ' (locked)' : ''}`;
          return <button key={hotspot.puzzleId} className="scene-object" type="button" data-surface="desk" data-label={name}
            style={{ ...percentBox(hotspot), aspectRatio: `${hotspot.aspectRatio[0]} / ${hotspot.aspectRatio[1]}`, zIndex: hotspot.zIndex }}
            aria-label={name} aria-disabled={locked} onClick={event => {
              // A mouse click on a transparent pixel misses the object; keyboard activation (detail 0) always opens it (design L601).
              const picture = event.currentTarget.querySelector('img');
              if (event.detail !== 0 && picture && !hitOpaquePixel(picture, event)) return;
              trigger.current = event.currentTarget;
              setActive(hotspot.puzzleId);
            }}>
            <img src={image(desktopOpen ? room1Design.desktopAssets['dana-login'].desktop : hotspot.assetId)} alt="" draggable={false} />
            {desktopOpen && <img className="desktop-open-file" src={image(room1Design.desktopAssets['dana-login'].openRoomFile)} alt="" draggable={false} />}
          </button>;
        })}
      </div>}
    </section>
    {doorError && <p role="alert" className="t5-error">{doorError}</p>}
    <p className="hint">Click a computer or device · Click outside a window or press <kbd>Esc</kbd> to go back</p>
    <footer className="t5-room-status"><span className={`t5-status-dot ${(displayingRoomTwo ? gitSandbox?.status : sandbox) === 'ready' ? 'ready' : ''}`} />{displayingRoomTwo ? room2Status : status}
      {!displayingRoomTwo && progress.passwordCracked && <span className="t5-inventory">Inventory: {characterName('dana')}'s password (cracked)</span>}
      <span className="t5-connection">{connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}</span>
      <span>{(displayingRoomTwo ? room2Puzzles : puzzles).filter(item => item.status === 'solved').length} / {(displayingRoomTwo ? room2Puzzles : puzzles).length} solved</span>
    </footer>
    {displayingRoomTwo && active2 && <Room2Window target={active2} setTarget={setActive2} view={view} connection={connection}
      submit={submit} screens={screens} trigger={trigger} openDoor={() => doorAction('open-door')} doorPending={doorPending} />}
    {active && (desktopHeld || puzzle) && <ZoomPanel title={hotspotLabel(active)} close={closePuzzle} trigger={trigger} screen={shown}>
      {connection === 'retrying' && <div className="t5-connection-notice" role="status">Cannot reach the server. Reconnecting... Your inputs are preserved.</div>}
      {authoritativeDoor && active === 'dana-login' && puzzle?.status === 'solved'
        ? <DanaDesktop openRoom={() => void doorAction('open-door')} pending={doorPending} />
        : desktopHeld || !puzzle ? <DanaDesktop openRoom={openRoom} /> : puzzle.status !== 'locked' && Screen ? <Screen
        puzzle={puzzle} view={view}
        submit={input => acceptsInput(puzzle.key) ? submit(puzzle.key, input) : Promise.resolve({ error: 'conflict' })}
        close={closePuzzle}
      /> : <>
        <div className="modal-title">{hotspotLabel(active)}</div>
        {puzzle.status === 'locked' ? <p className="t5-panel-state"><LockKeyhole size={24} />Locked</p>
          : <div className="t5-panel-state"><p>Screen unavailable</p><button type="button" onClick={closePuzzle}>← Back to room</button></div>}
        <div className="modal-note">Click outside the window or press Esc to go back</div>
      </>}
    </ZoomPanel>}
  </>;
}
