import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { GameApi, type AuthTokens } from './api';
const AuthContext = createContext<{ api: GameApi; auth: AuthTokens | null; unavailable: boolean; restoring: boolean; restoreError: boolean; retryRestore: () => void } | null>(null);
export function AuthProvider({ apiBase, children }: { apiBase: string; children: ReactNode }) {
  const [api] = useState(() => new GameApi(apiBase, undefined, true));
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const auth = useSyncExternalStore(api.subscribe, api.getAuth, () => null);
  const unavailable = useSyncExternalStore(api.subscribe, api.getUnavailable, () => false);
  useEffect(() => {
    if (!unavailable) return;
    let alive = true;
    let delay = 1000;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function probe() {
      if (!alive || pending) return;
      clearTimeout(timer);
      pending = true;
      const healthy = await api.checkConnection();
      pending = false;
      if (alive && !healthy) { delay = Math.min(delay * 2, 10000); timer = setTimeout(() => { void probe(); }, delay); }
    }
    const online = () => { void probe(); };
    timer = setTimeout(online, delay);
    window.addEventListener('online', online);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('online', online); };
  }, [api, unavailable]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let pending = false;
    setRestoring(true); setRestoreError(false);
    async function restore() {
      if (!alive || pending) return;
      clearTimeout(timer);
      if (api.getAuth()) { setRestoreError(false); setRestoring(false); return; }
      pending = true;
      try { await api.restore(); if (alive) setRestoreError(false); }
      catch {
        if (alive && !api.getAuth()) {
          setRestoreError(true);
          timer = setTimeout(() => { void restore(); }, delay);
          delay = Math.min(delay * 2, 10000);
        }
      } finally { pending = false; if (alive) setRestoring(false); }
    }
    const online = () => { void restore(); };
    void restore();
    window.addEventListener('online', online);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('online', online); };
  }, [api, attempt]);
  useEffect(() => { if (auth) { setRestoreError(false); setRestoring(false); } }, [auth]);
  useEffect(() => () => api.dispose(), [api]);
  return <AuthContext.Provider value={{ api, auth, unavailable, restoring, restoreError, retryRestore: () => setAttempt(value => value + 1) }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required');
  return context;
}