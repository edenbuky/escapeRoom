import room1Design from './room-1.design.json';
import { ROOM_1_ASSETS } from './room-assets';

describe('room-one design data', () => {
  it('uses the 4:3 stage and references only available Team 5 assets', () => {
    expect(room1Design.stage.aspectRatio).toEqual([4, 3]);
    const referencedAssets = [
      room1Design.stage.backgrounds.closed,
      room1Design.stage.backgrounds.open,
      ...room1Design.hotspots.flatMap(hotspot => hotspot.assetId ? [hotspot.assetId] : []),
      ...room1Design.decorations.map(decoration => decoration.assetId),
      ...Object.values(room1Design.puzzleScreens),
    ];
    expect(referencedAssets.every(assetId => assetId in ROOM_1_ASSETS)).toBe(true);
  });

  it('keeps puzzle identity separate from editable character display names', () => {
    expect(room1Design.hotspots.map(hotspot => hotspot.puzzleId)).toEqual([
      'idan-db', 'dana-login', 'hash-cracker',
    ]);
    expect(room1Design.characters.dana.displayName).toBe('Dana');
    expect(room1Design.puzzleScreens['dana-login']).toBe('login-screen');
    expect(Object.keys(ROOM_1_ASSETS).every(assetId => !assetId.includes('dana'))).toBe(true);
  });

  it('maps generic desktop assets to their specific puzzle location', () => {
    expect(room1Design.desktopAssets['dana-login']).toEqual({
      desktop: 'computer-open-empty',
      openRoomFile: 'open-room-file',
    });
  });

  it('keeps hotspot bounds normalized and puzzle IDs unique', () => {
    expect(new Set(room1Design.hotspots.map(hotspot => hotspot.puzzleId)).size)
      .toBe(room1Design.hotspots.length);
    for (const hotspot of room1Design.hotspots) {
      expect(hotspot.left).toBeGreaterThanOrEqual(0);
      expect(hotspot.top).toBeGreaterThanOrEqual(0);
      expect(hotspot.left + hotspot.width).toBeLessThanOrEqual(100);
    }
  });

  it('layers both computer hotspots in front of the chairs', () => {
    const chairs = Math.max(...room1Design.decorations
      .filter(decoration => ['idanChair', 'danaChair'].includes(decoration.id))
      .map(decoration => decoration.zIndex));
    const computers = room1Design.hotspots.filter(hotspot =>
      hotspot.puzzleId === 'idan-db' || hotspot.puzzleId === 'dana-login');
    expect(computers).toHaveLength(2);
    expect(computers.every(hotspot => hotspot.zIndex > chairs)).toBe(true);
  });
});
