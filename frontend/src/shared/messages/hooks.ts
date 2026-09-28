import { useEffect, useRef, useState } from 'react';

/** The current time, refreshed every `intervalMs` so relative labels ("5m", "Today") stay right. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function pageVisible(): boolean {
  return document.visibilityState === 'visible';
}

/**
 * Marks an open thread read while the page is visible and it has unread incoming messages.
 * Each unread message id is only marked once, so a slow refetch can't cause a request loop.
 */
export function useMarkReadWhenVisible(newestUnreadId: number | null, markRead: () => Promise<unknown>): void {
  const [visible, setVisible] = useState(pageVisible);
  const markedUpTo = useRef<number | null>(null);
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;

  useEffect(() => {
    const update = () => setVisible(pageVisible());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);

  useEffect(() => {
    if (!visible || newestUnreadId === null) return;
    if (markedUpTo.current !== null && newestUnreadId <= markedUpTo.current) return;
    const previous = markedUpTo.current;
    markedUpTo.current = newestUnreadId;
    markReadRef.current().catch(() => {
      markedUpTo.current = previous;
    });
  }, [visible, newestUnreadId]);
}
