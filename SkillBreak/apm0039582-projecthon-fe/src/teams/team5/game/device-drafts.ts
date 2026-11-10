import { createContext, useContext, useEffect, useState } from 'react';

export const DraftOwner = createContext('');
const prefix = 't5-draft:';
const fallback = new Map<string, string>();
function read(key: string) {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return localStorage.getItem(key) ?? ''; } catch { return fallback.get(key) ?? ''; }
}
export function clearDrafts(sessionId?: string) {
  const matches = (key: string) => key.startsWith(prefix) && (!sessionId || key.includes(`:${sessionId}:`));
  for (const key of fallback.keys()) if (matches(key)) fallback.delete(key);
  try { for (const key of Object.keys(localStorage)) if (matches(key)) localStorage.removeItem(key); } catch { return notify(); }
  notify();
}
function notify() {
  window.dispatchEvent(new Event('t5-drafts-changed'));
}
export function useDeviceDraft(sessionId: string, field: string): [string, (value: string) => void] {
  const owner = useContext(DraftOwner);
  const key = `${prefix}${owner}:${sessionId}:${field}`;
  const [value, setValue] = useState(() => read(key));
  useEffect(() => {
    const update = () => setValue(read(key));
    update();
    window.addEventListener('storage', update);
    window.addEventListener('t5-drafts-changed', update);
    return () => { window.removeEventListener('storage', update); window.removeEventListener('t5-drafts-changed', update); };
  }, [key]);
  return [value, next => {
    try { localStorage.setItem(key, next); fallback.delete(key); } catch { fallback.set(key, next); }
    setValue(next);
    notify();
  }];
}