import { lastEventId, newer, readViews, serverTimeSample } from './useSessionStream';
import type { SessionView } from '../contracts/view';

const sessionId = 'c0a80123-4567-489a-8bcd-0123456789ab';
const serverTime = '2026-11-03T10:00:00.000Z';
function view(version: number, patch: Partial<SessionView> = {}): SessionView {
  return {
    sessionId,
    version,
    status: 'Active',
    currentRoom: { key: 'room-1', puzzles: [], files: [] },
    deadlineAt: '2026-11-03T10:45:00.000Z',
    endedAt: null,
    latestResult: null,
    revealedHints: [],
    ...patch,
  };
}
function streamResponse(snapshot: SessionView, date = serverTime): Response {
  return new Response(`event: session\nid: ${snapshot.version}\ndata: ${JSON.stringify(snapshot)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream', Date: date },
  });
}

describe('task 1.7 session stream contract', () => {
  it('accepts version-only session snapshots and ignores unrelated event types', async () => {
    const accept = vi.fn();
    const response = new Response([
      'event: heartbeat\nid: 1\ndata: ignored\n\n',
      `event: session\nid: 2\ndata: ${JSON.stringify(view(2))}\n\n`,
    ].join(''));

    await readViews(response, accept);

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(view(2));
  });

  it('rejects composite cursors not emitted by task 1.7', async () => {
    const snapshot = view(2);
    const response = new Response(`event: session\nid: 2.0\ndata: ${JSON.stringify(snapshot)}\n\n`);

    await expect(readViews(response, vi.fn())).rejects.toThrow('Invalid session view');
  });

  it('keeps distinct same-version snapshots while rejecting duplicates and older versions', () => {
    const initial = view(2);
    const changedSibling = view(2, { currentRoom: { key: 'room-1', puzzles: [], files: [{ name: 'result.txt', content: 'ok' }] } });

    expect(newer(initial, initial)).toBe(false);
    expect(newer(changedSibling, initial)).toBe(true);
    expect(newer(view(1), initial)).toBe(false);
  });

  it('uses a version-only cursor and server Date sample', () => {
    expect(lastEventId()).toBeUndefined();
    expect(lastEventId(view(9))).toBe('9');
    expect(serverTimeSample(streamResponse(view(2)))).toBe(serverTime);
    expect(serverTimeSample(new Response())).toBeUndefined();
  });
});
