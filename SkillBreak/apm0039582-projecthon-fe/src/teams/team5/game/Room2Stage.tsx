import { useEffect, useRef, useState } from 'react';
import type { SessionView } from '../contracts/view';
import room2Design from './room-design/room-2.design.json';
import { ROOM_2_ASSETS, type Room2AssetId } from './room-design/room-assets';
import { hitOpaquePixel } from './opaque-pixel';
import { percentBox } from './screens/shared/DeviceScreen';

export type Room2Hotspot = (typeof room2Design.hotspots)[number];

const image = (assetId: string) => ROOM_2_ASSETS[assetId as Room2AssetId];
const characterName = (characterId: string) =>
  room2Design.characters[characterId as keyof typeof room2Design.characters].displayName;

export const room2HotspotLabel = (hotspot: Room2Hotspot) =>
  hotspot.characterId ? `${characterName(hotspot.characterId)}'s ${hotspot.label}` : hotspot.label;

export const room2Title = `${characterName(room2Design.title.characterId)}'s ${room2Design.title.suffix}`;

/** Nathanel's room (design showRoom, index 1): backgrounds by door state, hotspots, decorations and the exit door. */
export function Room2Stage({ view, open, enterPending, onOpen, onEnter }: {
  view: SessionView;
  /** The door was opened (server `doorOpenedAt`): shows the open background and lets the player walk through. */
  open: boolean;
  enterPending: boolean;
  onOpen: (hotspot: Room2Hotspot, opener: HTMLElement) => void;
  onEnter: () => void;
}) {
  const [hinted, setHinted] = useState(false);
  const hintTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  const { door } = room2Design;
  const doorLabel = open ? door.labelOpen : hinted ? door.labelHint : door.labelLocked;
  return <div className="stage" data-room="room-2">
    <img className="room-bg" src={image(room2Design.stage.backgrounds.closed)} alt="" draggable={false} />
    <img className={`room-bg room-bg-open ${open ? 'is-visible' : ''}`} src={image(room2Design.stage.backgrounds.open)} alt="" draggable={false} />
    <span className="room-tag">{room2Design.tag}</span>
    {room2Design.hotspots.map(hotspot => {
      const item = hotspot.puzzleId ? view.currentRoom.puzzles.find(candidate => candidate.key === hotspot.puzzleId) : undefined;
      const locked = hotspot.puzzleId !== null && (!item || item.status === 'locked');
      const name = `${room2HotspotLabel(hotspot)}${locked ? ' (locked)' : ''}`;
      const box = 'height' in hotspot ? percentBox(hotspot)
        : { ...percentBox(hotspot), aspectRatio: `${hotspot.aspectRatio[0]} / ${hotspot.aspectRatio[1]}` };
      return <button key={hotspot.id} className="scene-object" type="button" data-item={hotspot.id} data-surface={hotspot.surface}
        data-label={name} aria-label={name} aria-disabled={locked} style={{ ...box, zIndex: hotspot.zIndex }}
        onClick={event => {
          // A mouse click on a transparent pixel misses the object; keyboard activation (detail 0) always opens it (design L601).
          const picture = event.currentTarget.querySelector('img');
          if (event.detail !== 0 && picture && !hitOpaquePixel(picture, event)) return;
          onOpen(hotspot, event.currentTarget);
        }}>
        <img src={image(hotspot.assetId)} alt="" draggable={false} />
      </button>;
    })}
    {room2Design.decorations.map(decoration => <img key={decoration.id} className="scene-decoration"
      data-decoration={decoration.id} src={image(decoration.assetId)} alt="" draggable={false}
      style={{ ...percentBox(decoration), zIndex: decoration.zIndex }} />)}
    <button type="button" className="door" data-open={open} disabled={open && enterPending}
      aria-label={open ? 'Go to the victory room' : 'Locked door, enter the code on the keypad'}
      style={{ ...percentBox(door), zIndex: door.zIndex }}
      onClick={() => {
        if (open) { onEnter(); return; }
        setHinted(true);
        window.clearTimeout(hintTimer.current);
        hintTimer.current = window.setTimeout(() => setHinted(false), 1600);
      }}>
      <span className="door-pill">{doorLabel}</span>
    </button>
  </div>;
}
