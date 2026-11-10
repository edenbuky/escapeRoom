import type { ComponentType, RefObject } from 'react';
import { LockKeyhole } from '../vendor/icons';
import type { PuzzleInput } from '../contracts/outputs';
import type { SessionView } from '../contracts/view';
import { ROOM_2_PUZZLE_KEYS } from '../contracts/keys';
import room2Design from './room-design/room-2.design.json';
import { ROOM_2_ASSETS, type Room2AssetId } from './room-design/room-assets';
import { room2HotspotLabel, type Room2Hotspot } from './Room2Stage';
import { NathanelDesktop } from './screens/nathanel-desktop';
import type { PuzzleScreenProps, SubmitResult } from './screens/types';
import { ZoomPanel } from './ZoomPanel';

/** Which close-up is open: a hotspot, and for Nathanel's computer the window inside it (`desktop` or a file's screen key). */
export interface Room2Target { hotspotId: string; window: string }
export const DESKTOP_WINDOW = 'desktop';

/** Room 2's close-ups (design showObject, showNetanelDesktop, stepBackModal): board picture, locked panel, desktop with files, screens. */
export function Room2Window({ target, setTarget, view, connection, submit, screens, trigger, openDoor, doorPending }: {
  target: Room2Target; setTarget: (target: Room2Target | undefined) => void; view: SessionView; connection: string;
  submit: (puzzleKey: string, input: PuzzleInput) => Promise<SubmitResult>;
  screens?: Partial<Record<string, ComponentType<PuzzleScreenProps>>>;
  trigger: RefObject<HTMLElement | null>;
  openDoor?: () => Promise<void>;
  doorPending?: boolean;
}) {
  const hotspot = room2Design.hotspots.find(candidate => candidate.id === target.hotspotId) as Room2Hotspot;
  const title = room2HotspotLabel(hotspot);
  const puzzle = hotspot.puzzleId ? view.currentRoom.puzzles.find(candidate => candidate.key === hotspot.puzzleId) : undefined;
  const isComputer = hotspot.puzzleId === ROOM_2_PUZZLE_KEYS.git;
  const inFile = isComputer && target.window !== DESKTOP_WINDOW;
  // Like the design's stepBackModal: a file's window steps back to the desktop, the desktop closes to the room.
  const close = () => setTarget(inFile ? { hotspotId: hotspot.id, window: DESKTOP_WINDOW } : undefined);
  const acceptsInput = (key: string) => view.status === 'Active' && view.currentRoom.puzzles.some(item => item.key === key);
  const slotKey = inFile ? target.window : hotspot.puzzleId ?? '';
  const Screen = screens?.[slotKey];
  const locked = hotspot.puzzleId !== null && (!puzzle || puzzle.status === 'locked');
  // The capture is not a puzzle; it belongs to the TLS decryptor, which reveals the decrypted file.
  const slotPuzzle = slotKey === 'capture-viewer'
    ? view.currentRoom.puzzles.find(item => item.key === ROOM_2_PUZZLE_KEYS.tls) ?? puzzle : puzzle;
  const submitFor = (input: PuzzleInput) => slotKey === 'capture-viewer' || !puzzle || !acceptsInput(puzzle.key)
    ? Promise.resolve<SubmitResult>({ error: 'conflict' }) : submit(puzzle.key, input);
  const screenName = hotspot.puzzleId === null ? 'object' : locked ? 'locked' : isComputer ? target.window : 'screen';
  return <ZoomPanel title={title} close={close} trigger={trigger} screen={screenName}>
    {connection === 'retrying' && <div className="t5-connection-notice" role="status">Cannot reach the server. Reconnecting... Your inputs are preserved.</div>}
    {hotspot.puzzleId === null ? <>
      <div className="modal-title">{title}</div>
      <img className="modal-image" src={ROOM_2_ASSETS[hotspot.assetId as Room2AssetId]} alt={title} draggable={false} />
      <div className="modal-note">{room2Design.boardNote}</div>
    </> : locked ? <>
      <div className="modal-title">{title}</div>
      <p className="t5-panel-state"><LockKeyhole size={24} />Locked</p>
      <div className="modal-note">Click outside the window or press Esc to go back</div>
    </> : isComputer && !inFile ? <NathanelDesktop openFile={window => setTarget({ hotspotId: hotspot.id, window })} />
      : Screen && slotPuzzle ? <Screen puzzle={slotPuzzle} view={view} submit={submitFor} close={close}
        openDoor={openDoor} doorPending={doorPending} /> : <>
        <div className="modal-title">{title}</div>
        <div className="t5-panel-state"><p>Unavailable</p><button type="button" onClick={close}>← Back</button></div>
        <div className="modal-note">Click outside the window or press Esc to go back</div>
      </>}
  </ZoomPanel>;
}
