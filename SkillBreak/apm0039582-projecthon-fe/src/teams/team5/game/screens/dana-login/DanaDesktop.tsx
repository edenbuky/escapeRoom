import { ROOM_1_ASSETS, type RoomAssetId } from '../../room-design/room-assets';
import room1Design from '../../room-design/room-1.design.json';
import { DeviceScreen } from '../shared/DeviceScreen';

const dana = room1Design.characters.dana.displayName;
const desktopAssets = room1Design.desktopAssets['dana-login'];

/** The unlocked desktop. Its open-room file is the only way to open the door; the room change itself comes from the session view. */
export function DanaDesktop({ openRoom, pending = false }: { openRoom: () => void; pending?: boolean }) {
  return <>
    <div className="modal-title">{dana}'s computer · Desktop</div>
    <DeviceScreen image={ROOM_1_ASSETS[desktopAssets.desktop as RoomAssetId]} label={`${dana}'s desktop`} className="dana-desktop">
      <button type="button" className="dana-file" aria-label="Open room" disabled={pending} onClick={openRoom}>
        <img src={ROOM_1_ASSETS[desktopAssets.openRoomFile as RoomAssetId]} alt="" draggable={false} />
      </button>
    </DeviceScreen>
  </>;
}
