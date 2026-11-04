import { useEffect, useRef, useState } from 'react';
import { createParser } from '../vendor/eventsource-parser';
import type { SessionView } from '../contracts/view';
import { ApiError, GameApi } from './api';

export function newer(view: SessionView, previous?: SessionView): boolean {
  return !previous || view.version > previous.version
    || (view.version === previous.version && JSON.stringify(view) !== JSON.stringify(previous));
}
export function lastEventId(view?: SessionView): string | undefined {
  return view ? String(view.version) : undefined;
}
export function serverTimeSample(response: Response): string | undefined {
  const date = response.headers.get('date');
  const sampledTime = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(sampledTime) ? new Date(sampledTime).toISOString() : undefined;
}
export async function readViews(response: Response, accept: (view: SessionView) => void) {
  if (!response.body) throw new Error('Missing stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({ onEvent(event) {
    if (event.event !== 'session') return;
    const view = JSON.parse(event.data) as SessionView;
    if (typeof view.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(view.sessionId)
      || !Number.isSafeInteger(view.version) || view.version < 1 || event.id !== String(view.version)
      || !['Active', 'Escaped', 'Expired', 'Abandoned'].includes(view.status)
      || !view.currentRoom || typeof view.currentRoom.key !== 'string'
      || !Array.isArray(view.currentRoom.puzzles) || !Array.isArray(view.currentRoom.files)
      || !Number.isFinite(Date.parse(view.deadlineAt))
      || !(view.endedAt === null || Number.isFinite(Date.parse(view.endedAt)))
      || !Array.isArray(view.revealedHints)) throw new Error('Invalid session view');
    accept(view);
  } });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { parser.feed(decoder.decode()); break; }
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
export function useSessionStream(api: GameApi, sessionId: string | null, token: string | undefined, startedAt: number) {
  const [view, setView] = useState<SessionView>();
  const [serverTime, setServerTime] = useState<string>();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'retrying'>('connecting');
  const [error, setError] = useState<string>();
  const latest = useRef<SessionView>();
  useEffect(() => {
    if (latest.current?.sessionId !== sessionId) { latest.current = undefined; setView(undefined); }
    setError(undefined);
    if (!sessionId || !token) return;
    const controller = new AbortController();
    const { signal } = controller;
    const activeSessionId = sessionId;
    async function connect() {
      let retry = 1000;
      while (!signal.aborted) {
        setConnection(latest.current ? 'retrying' : 'connecting');
        try {
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          const cursor = lastEventId(latest.current);
          if (cursor) headers['Last-Event-ID'] = cursor;
          const response = await api.request(`/sessions/${encodeURIComponent(activeSessionId)}/stream`, { headers, signal });
          if (signal.aborted) { await response.body?.cancel(); return; }
          if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid stream');
          setServerTime(serverTimeSample(response));
          await readViews(response, next => {
            if (signal.aborted || next.sessionId !== activeSessionId) return;
            setConnection('live'); retry = 1000;
            if (newer(next, latest.current)) { latest.current = next; setView(next); }
          });
        } catch (failure) {
          if (signal.aborted) return;
          if (failure instanceof ApiError && ([401, 403].includes(failure.status)
            || (failure.status === 404 && (latest.current || Date.now() - startedAt >= 15000)))) {
            setError(failure.status === 403 ? 'Session access denied.' : failure.status === 404 ? 'The session could not be started.' : 'Please sign in again.');
            return;
          }
        }
        if (!signal.aborted) { setConnection('retrying'); await pause(retry, signal); retry = Math.min(10000, retry * 2); }
      }
    }
    void connect();
    return () => controller.abort();
  }, [api, sessionId, token, startedAt]);
  return { view, serverTime, connection, error };
}