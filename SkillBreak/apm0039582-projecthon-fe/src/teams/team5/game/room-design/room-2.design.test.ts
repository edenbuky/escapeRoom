import room2Design from './room-2.design.json';
import { ROOM_2_ASSETS } from './room-assets';
import { ROOM_2_PUZZLE_KEYS } from '../../contracts/keys';

describe('room-two design data', () => {
  it('uses the 4:3 stage and references only available Room 2 assets', () => {
    expect(room2Design.stage.aspectRatio).toEqual([4, 3]);
    const referencedAssets = [
      room2Design.stage.backgrounds.closed,
      room2Design.stage.backgrounds.open,
      room2Design.desktop.image,
      ...room2Design.desktop.files.map(file => file.assetId),
      ...room2Design.hotspots.map(hotspot => hotspot.assetId),
      ...room2Design.decorations.map(decoration => decoration.assetId),
    ];
    expect(referencedAssets.every(assetId => assetId in ROOM_2_ASSETS)).toBe(true);
  });

  it('copies the design HTML hotspot boxes and z-order', () => {
    const boxes = Object.fromEntries(room2Design.hotspots.map(({ id, left, top, width, zIndex }) => [id, [left, top, width, zIndex]]));
    expect(boxes).toEqual({
      board: [37.4, 1.7, 36.5, 1], netanel: [35, 32, 22, 4], rsa: [20, 54.5, 27, 2], tls: [49, 53.4, 29.6, 2], keypad: [84, 37, 12, 5],
    });
    expect(room2Design.hotspots.find(hotspot => hotspot.id === 'board')).toMatchObject({ height: 37.6, surface: 'wall' });
    expect(room2Design.decorations.map(({ left, top, width, height }) => [left, top, width, height])).toEqual([
      [46.5, 36.5, 12.1, 14.5], [64.2, 35.2, 6.5, 6.3], [54.5, 27.5, 11.5, 23],
    ]);
    expect(room2Design.door).toMatchObject({ left: 79.2, top: 3, width: 20, height: 88 });
  });

  it('keeps puzzle identity separate from the display names', () => {
    expect(room2Design.hotspots.map(hotspot => hotspot.puzzleId)).toEqual([
      null, ROOM_2_PUZZLE_KEYS.git, ROOM_2_PUZZLE_KEYS.rsa, ROOM_2_PUZZLE_KEYS.tls, ROOM_2_PUZZLE_KEYS.door,
    ]);
    expect(room2Design.characters.nathanel.displayName).toBe('Nathanel');
    expect(Object.keys(ROOM_2_ASSETS).every(assetId => !assetId.includes('nathanel') && !assetId.includes('netanel'))).toBe(true);
  });

  it('places the two desktop files where the design does', () => {
    expect(room2Design.desktop.files.map(file => [file.className, file.label, file.screen])).toEqual([
      ['git-file', 'project_cibus_payment', 'nethanel-git'], ['pcap-file', 'Cibus_payment_try.pcap', 'capture-viewer'],
    ]);
  });

  it('keeps hotspot bounds normalized and ids unique', () => {
    expect(new Set(room2Design.hotspots.map(hotspot => hotspot.id)).size).toBe(room2Design.hotspots.length);
    for (const hotspot of room2Design.hotspots) {
      expect(hotspot.left + hotspot.width).toBeLessThanOrEqual(100);
    }
  });
});
