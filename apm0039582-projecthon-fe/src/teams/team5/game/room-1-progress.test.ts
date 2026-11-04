import { markPasswordCracked, readRoom1Progress, setDanaDesktopOpen } from './room-1-progress';

const first = '00000000-0000-4000-8000-0000000000a1';
const second = '00000000-0000-4000-8000-0000000000a2';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  sessionStorage.clear();
});

describe('room-1 progress', () => {
  it('starts empty and keeps each session separate', () => {
    expect(readRoom1Progress(first)).toEqual({ passwordCracked: false, danaDesktopOpen: false });
    markPasswordCracked(first);
    setDanaDesktopOpen(first, true);
    expect(readRoom1Progress(first)).toEqual({ passwordCracked: true, danaDesktopOpen: true });
    expect(readRoom1Progress(second)).toEqual({ passwordCracked: false, danaDesktopOpen: false });
    setDanaDesktopOpen(first, false);
    expect(readRoom1Progress(first)).toEqual({ passwordCracked: true, danaDesktopOpen: false });
  });

  it('survives a reload through sessionStorage', async () => {
    const before = await import('./room-1-progress');
    before.markPasswordCracked(second);
    before.setDanaDesktopOpen(second, true);
    vi.resetModules();
    const after = await import('./room-1-progress');
    expect(after).not.toBe(before);
    expect(after.readRoom1Progress(second)).toEqual({ passwordCracked: true, danaDesktopOpen: true });
  });

  it('still works in the page when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const progress = await import('./room-1-progress');
    expect(progress.readRoom1Progress(first)).toEqual({ passwordCracked: false, danaDesktopOpen: false });
    progress.markPasswordCracked(first);
    expect(progress.readRoom1Progress(first)).toEqual({ passwordCracked: true, danaDesktopOpen: false });
  });

  it('ignores unreadable saved data', async () => {
    sessionStorage.setItem(`t5-room-1-progress:${first}`, '{not json');
    const progress = await import('./room-1-progress');
    expect(progress.readRoom1Progress(first)).toEqual({ passwordCracked: false, danaDesktopOpen: false });
  });
});
