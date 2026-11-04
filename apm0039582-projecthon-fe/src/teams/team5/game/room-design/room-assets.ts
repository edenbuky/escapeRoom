import computerOpenEmpty from '../../assets/room-1/danas-computer-open-empty.png';
import frontTableOverlay from '../../assets/room-1/front-table-overlay.png';
import hashCrackerHotspot from '../../assets/room-1/hash-cracker-hotspot.png';
import hashCrackerStreight from '../../assets/room-1/hash-cracker-streight.png';
import loginScreen from '../../assets/room-1/login-screen.png';
import officeChairDarkMesh from '../../assets/room-1/office-chair-dark-mesh.png';
import officeChairRedMesh from '../../assets/room-1/office-chair-red-mesh.png';
import officeShelf from '../../assets/room-1/office-shelf.png';
import openDoorsFile from '../../assets/room-1/open-doors-file-in-danas-computer.png';
import roomBackgroundClosed from '../../assets/room-1/room-background-closed.png';
import roomBackgroundOpen from '../../assets/room-1/room-background-open.png';
import sqlTerminalHotspot from '../../assets/room-1/sql-terminal-hotspot.png';

export const ROOM_1_ASSETS = {
  'computer-open-empty': computerOpenEmpty,
  'front-table-overlay': frontTableOverlay,
  'hash-cracker-hotspot': hashCrackerHotspot,
  'hash-cracker-streight': hashCrackerStreight,
  'login-screen': loginScreen,
  'office-chair-dark-mesh': officeChairDarkMesh,
  'office-chair-red-mesh': officeChairRedMesh,
  'office-shelf': officeShelf,
  'open-doors-file': openDoorsFile,
  'room-background-closed': roomBackgroundClosed,
  'room-background-open': roomBackgroundOpen,
  'sql-terminal-hotspot': sqlTerminalHotspot,
} as const;

export type RoomAssetId = keyof typeof ROOM_1_ASSETS;
