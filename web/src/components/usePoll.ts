import { useEffect, useRef, useState } from 'react';

/**
 * Runs `fn` every `baseMs` while the tab is visible. Failures double the delay (max 60s);
 * success resets it. Pauses while hidden and fires immediately on becoming visible.
 * Restarts when `key` changes. Returns the last error (null when healthy) and `refresh`.
 */
export function usePoll(fn: () => Promise<void>, key: unknown, baseMs = 5000) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [error, setError] = useState<unknown>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let running = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(tick, Math.min(baseMs * 2 ** fails, 60_000));
    };
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        await fnRef.current();
        fails = 0;
        if (!stopped) setError(null);
      } catch (e) {
        fails++;
        if (!stopped) setError(e);
      } finally {
        running = false;
      }
      schedule();
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick();
    };

    refreshRef.current = () => void tick();
    document.addEventListener('visibilitychange', onVis);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [key, baseMs]);

  return { error, refresh: () => refreshRef.current() };
}
