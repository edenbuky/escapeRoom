import { ROOM_1_ASSETS } from '../../room-design/room-assets';
import room1Design from '../../room-design/room-1.design.json';
import { DeviceScreen } from '../shared/DeviceScreen';

const dana = room1Design.characters.dana.displayName;

/** The unlocked desktop. Its open-room file is the only way to open the door; the room change itself comes from the session view. */
export function DanaDesktop({ openRoom }: { openRoom: () => void }) {
  return <>
    <div className="modal-title">{dana}'s computer · Desktop</div>
    <DeviceScreen image={ROOM_1_ASSETS['computer-open-empty']} label={`${dana}'s desktop`} className="dana-desktop">
      <button type="button" className="dana-file" aria-label="Open room" onClick={openRoom}>
        <img src={ROOM_1_ASSETS['open-doors-file']} alt="" draggable={false} />
      </button>
    </DeviceScreen>
    <div className="modal-note">Click open room to open the door and move to the second room</div>
  </>;
}
