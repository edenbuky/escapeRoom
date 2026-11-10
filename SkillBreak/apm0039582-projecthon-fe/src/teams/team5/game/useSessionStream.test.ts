import { act, cleanup, renderHook } from '@testing-library/react';
import { GameApi } from './api';
import { lastEventId, newer, readViews, serverTimeSample, useSessionStream } from './useSessionStream';
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
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('keeps the last view during a stalled stream and resumes with its cursor', async () => {
    vi.useFakeTimers();
    const api = new GameApi('/api/team5');
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const request = vi.spyOn(api, 'request').mockImplementation(async (_path, init) => new Response(new ReadableStream({
      start(controller) {
        controllers.push(controller);
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    }), { headers: { 'Content-Type': 'text/event-stream', Date: serverTime } }));
    const startedAt = Date.now();
    const { result, unmount } = renderHook(() => useSessionStream(api, sessionId, 'token', startedAt));
    const send = (snapshot: SessionView) => controllers[controllers.length - 1].enqueue(new TextEncoder().encode(`event: session\nid: ${snapshot.version}\ndata: ${JSON.stringify(snapshot)}\n\n`));
    await act(async () => { send(view(2)); });
    expect(result.current.connection).toBe('live');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); controllers[0].enqueue(new TextEncoder().encode(': heartbeat\n\n')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(result.current.connection).toBe('retrying');
    expect(result.current.view).toEqual(view(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); send(view(3)); });
    expect(request.mock.calls[1][1]?.headers).toMatchObject({ 'Last-Event-ID': '2' });
    expect(result.current.connection).toBe('live');
    expect(result.current.view?.version).toBe(3);
    unmount(); api.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('retries when the server never returns stream headers', async () => {
    vi.useFakeTimers();
    const api = new GameApi('/api/team5');
    const request = vi.spyOn(api, 'request').mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const startedAt = Date.now();
    const { result, unmount } = renderHook(() => useSessionStream(api, sessionId, 'token', startedAt));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.connection).toBe('retrying');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(request).toHaveBeenCalledTimes(2);
    unmount(); api.dispose();
  });
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
