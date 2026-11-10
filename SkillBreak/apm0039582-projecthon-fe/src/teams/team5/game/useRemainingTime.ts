import { useEffect, useState } from 'react';

export function useRemainingTime(deadlineAt?: string, serverTime?: string) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const sample = Date.parse(deadlineAt ?? '') - Date.parse(serverTime ?? '');
    if (!Number.isFinite(sample)) { setRemaining(null); return; }
    const received = performance.now();
    const tick = () => setRemaining(Math.max(0, sample - (performance.now() - received)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadlineAt, serverTime]);
  return remaining;
}