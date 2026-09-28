import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs` so time-dependent UI (join buttons) appears on time. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
