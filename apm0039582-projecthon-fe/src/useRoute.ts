import { useCallback, useEffect, useState } from 'react';

/** Minimal History-API router; the nginx SPA fallback serves index.html for every path. */
export function useRoute() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setPathname(to);
  }, []);

  return { pathname, navigate };
}
