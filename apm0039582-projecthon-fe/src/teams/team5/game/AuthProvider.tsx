import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { GameApi, type AuthTokens } from './api';
const AuthContext = createContext<{ api: GameApi; auth: AuthTokens | null } | null>(null);
export function AuthProvider({ apiBase, children }: { apiBase: string; children: ReactNode }) {
  const [api] = useState(() => new GameApi(apiBase));
  const auth = useSyncExternalStore(api.subscribe, api.getAuth, () => null);
  useEffect(() => () => api.dispose(), [api]);
  return <AuthContext.Provider value={{ api, auth }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required');
  return context;
}