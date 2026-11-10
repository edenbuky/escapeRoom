import room2Design from '../../room-design/room-2.design.json';
import { ROOM_2_ASSETS, type Room2AssetId } from '../../room-design/room-assets';

const nathanel = room2Design.characters.nathanel.displayName;
const { desktop } = room2Design;

/**
 * Nathanel's computer close-up (design showNetanelDesktop): the empty file explorer with the two file icons laid over it.
 * Each icon names the screen it opens; the room frame decides whether that screen is registered yet.
 */
export function NathanelDesktop({ openFile }: { openFile: (screen: string) => void }) {
  return <>
    <div className="modal-title">{nathanel}'s {desktop.title}</div>
    <div className="desktop-scene">
      <img className="desktop-screen" src={ROOM_2_ASSETS[desktop.image as Room2AssetId]} alt={`${nathanel}'s ${desktop.imageAlt}`} draggable={false} />
      {desktop.files.map(file => <button key={file.id} type="button" className={`desktop-file ${file.className}`}
        aria-label={`Open ${file.label}`} onClick={() => openFile(file.screen)}>
        <img src={ROOM_2_ASSETS[file.assetId as Room2AssetId]} alt="" draggable={false} />
        <span>{file.label}</span>
      </button>)}
    </div>
    <div className="modal-note">{desktop.note}</div>
  </>;
}
