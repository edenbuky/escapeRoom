import computerOpenEmpty from '../../assets/room-1/computer-open-empty.png';
import frontTableOverlay from '../../assets/room-1/front-table-overlay.png';
import hashCrackerHotspot from '../../assets/room-1/hash-cracker-hotspot.png';
import hashCrackerStreight from '../../assets/room-1/hash-cracker-streight.png';
import loginScreen from '../../assets/room-1/login-screen.png';
import officeChairDarkMesh from '../../assets/room-1/office-chair-dark-mesh.png';
import officeChairRedMesh from '../../assets/room-1/office-chair-red-mesh.png';
import officeShelf from '../../assets/room-1/office-shelf.png';
import openRoomFile from '../../assets/room-1/open-room-file.png';
import roomBackgroundClosed from '../../assets/room-1/room-background-closed.png';
import roomBackgroundOpen from '../../assets/room-1/room-background-open.png';
import sqlTerminalHotspot from '../../assets/room-1/room1-sql-computer.gif';
import boardFront from '../../assets/room-2/boardFront.webp';
import gitFile from '../../assets/room-2/gitFile.webp';
import keypad from '../../assets/room-2/keypad.webp';
import keypadFront from '../../assets/room-2/keypadFront.webp';
import lampRoom2 from '../../assets/room-2/lampRoom2.webp';
import netanel from '../../assets/room-2/netanel.webp';
import netanelEmpty from '../../assets/room-2/netanelEmpty.webp';
import netanelFront from '../../assets/room-2/netanelFront.webp';
import pcapFile from '../../assets/room-2/pcapFile.webp';
import plantMainRoom2 from '../../assets/room-2/plantMainRoom2.webp';
import plantSmallRoom2 from '../../assets/room-2/plantSmallRoom2.webp';
import room2CleanClosed from '../../assets/room-2/room2CleanClosed.webp';
import room2CleanOpen from '../../assets/room-2/room2CleanOpen.webp';
import rsa from '../../assets/room-2/rsa.webp';
import rsaFront from '../../assets/room-2/rsaFront.webp';
import tls from '../../assets/room-2/tls.webp';
import tlsFront from '../../assets/room-2/tlsFront.webp';
import victory from '../../assets/room-2/victory.webp';

export const ROOM_1_ASSETS = {
  'computer-open-empty': computerOpenEmpty,
  'front-table-overlay': frontTableOverlay,
  'hash-cracker-hotspot': hashCrackerHotspot,
  'hash-cracker-streight': hashCrackerStreight,
  'login-screen': loginScreen,
  'office-chair-dark-mesh': officeChairDarkMesh,
  'office-chair-red-mesh': officeChairRedMesh,
  'office-shelf': officeShelf,
  'open-room-file': openRoomFile,
  'room-background-closed': roomBackgroundClosed,
  'room-background-open': roomBackgroundOpen,
  'sql-terminal-hotspot': sqlTerminalHotspot,
} as const;

export type RoomAssetId = keyof typeof ROOM_1_ASSETS;


/** Room 2 pictures, extracted unchanged from the design HTML; ids describe the object, not the character. */
export const ROOM_2_ASSETS = {
  'room-background-closed': room2CleanClosed,
  'room-background-open': room2CleanOpen,
  'task-board': boardFront,
  'computer-hotspot': netanel,
  'computer-empty': netanelEmpty,
  'computer-desktop': netanelFront,
  'git-file': gitFile,
  'capture-file': pcapFile,
  'rsa-decryptor-hotspot': rsa,
  'rsa-decryptor-front': rsaFront,
  'tls-decryptor-hotspot': tls,
  'tls-decryptor-front': tlsFront,
  'keypad-hotspot': keypad,
  'keypad-front': keypadFront,
  'plant-main': plantMainRoom2,
  'plant-small': plantSmallRoom2,
  lamp: lampRoom2,
  victory,
} as const;

export type Room2AssetId = keyof typeof ROOM_2_ASSETS;
