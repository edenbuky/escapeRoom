import { afterEach, expect, it, vi } from 'vitest';
import { GameApi } from './api';

afterEach(() => vi.unstubAllGlobals());
it('restores with cookie credentials and resumes without creating a game or persisting tokens', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'access', refreshToken: '', expiresIn: 900,
    user: { id: 'owner' } }))).mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'existing' })));
  vi.stubGlobal('fetch', fetchMock);
  const api = new GameApi('/api', undefined, true);
  try {
    await api.restore();
    expect(await api.resume()).toBe('existing');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/browser/refresh');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include', body: '{}', headers: { 'X-Skillbreak-Browser': '1' } });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/sessions/resume');
  } finally { api.dispose(); }
});
it('rejects malformed successful cookie refresh payloads instead of installing invalid auth', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }))));
  const api = new GameApi('/api', undefined, true);
  try {
    await expect(api.restore()).rejects.toMatchObject({ status: 502 });
    expect(api.getAuth()).toBeNull();
  } finally { api.dispose(); }
});
it('sends distinct server commands to open and enter a room', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: 'access', expiresIn: 900, user: { id: 'owner' } })));
  vi.stubGlobal('fetch', fetchMock);
  const api = new GameApi('/api', undefined, true);
  try {
    await api.restore();
    await api.door('session', 'room-1', 'open-door');
    await api.door('session', 'room-1', 'enter');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/auth/browser/refresh', '/api/sessions/session/rooms/room-1/open-door', '/api/sessions/session/rooms/room-1/enter']);
  } finally { api.dispose(); }
});

it('serializes cookie refresh between tabs with Web Locks', async () => {
  let queued = Promise.resolve<unknown>(undefined);
  const request = vi.fn((_name: string, work: () => Promise<unknown>) => {
    const result = queued.then(work);
    queued = result.catch(() => undefined);
    return result;
  });
  vi.stubGlobal('navigator', { locks: { request } });
  let active = 0;
  let peak = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return new Response(JSON.stringify({ accessToken: 'access', expiresIn: 900, user: { id: 'owner' } }));
  }));
  const tabs = [new GameApi('/api', undefined, true), new GameApi('/api', undefined, true)];
  try {
    await Promise.all(tabs.map(tab => tab.restore()));
    expect(peak).toBe(1);
    expect(request.mock.calls.map(([name]) => name)).toEqual(['t5-auth:/api', 't5-auth:/api']);
    expect(tabs.map(tab => tab.getAuth()?.user.id)).toEqual(['owner', 'owner']);
  } finally { tabs.forEach(tab => tab.dispose()); }
});

it('synchronizes account switches and logout without broadcasting tokens or refresh loops', async () => {
  const channels: TestChannel[] = [];
  const messages: unknown[] = [];
  class TestChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) { channels.push(this); }
    postMessage(data: unknown) {
      messages.push(data);
      for (const peer of channels) if (peer !== this && peer.name === this.name) {
        queueMicrotask(() => peer.onmessage?.({ data }));
      }
    }
    close() { channels.splice(channels.indexOf(this), 1); }
  }
  vi.stubGlobal('BroadcastChannel', TestChannel);
  let owner = 'first-owner';
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/login')) owner = JSON.parse(init.body as string).username;
    return new Response(JSON.stringify({ accessToken: 'private-token', expiresIn: 900, user: { id: owner } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const tabs = [new GameApi('/api', undefined, true), new GameApi('/api', undefined, true)];
  try {
    await Promise.all(tabs.map(tab => tab.restore()));
    await tabs[0].login('second-owner', 'private-password');
    await vi.waitFor(() => expect(tabs[1].getAuth()?.user.id).toBe('second-owner'));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(3);
    await tabs[1].logout();
    await vi.waitFor(() => expect(tabs[0].getAuth()).toBeNull());
    expect(tabs[1].getAuth()).toBeNull();
    expect(messages).toEqual(['login', 'logout']);
  } finally { tabs.forEach(tab => tab.dispose()); }
  expect(channels).toHaveLength(0);
});