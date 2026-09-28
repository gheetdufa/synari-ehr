import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

const WARNING_MS = 60_000;
const CHECK_EVERY_MS = 5_000;
const STORAGE_KEY = 'synari.lastActivity';
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

function readLastActivity(): number {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) || Date.now();
  } catch {
    return Date.now();
  }
}

function recordActivity(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable (private mode); the timer still works per tab.
  }
}

/**
 * Signs the user out after `limitMinutes` (the server's limit for the session) without activity
 * in any tab, with a one-minute warning. Protects screens with health information left open on
 * shared or unattended devices.
 */
export function IdleTimeout({ limitMinutes, onTimeout }: { limitMinutes: number; onTimeout: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const limitMs = limitMinutes * 60_000;

  useEffect(() => {
    recordActivity();
    let lastWrite = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite > 10_000) {
        lastWrite = now;
        recordActivity();
      }
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const idleFor = Date.now() - readLastActivity();
      if (idleFor >= limitMs) {
        window.clearInterval(timer);
        onTimeoutRef.current();
        return;
      }
      const remaining = limitMs - idleFor;
      setSecondsLeft(remaining <= WARNING_MS ? Math.ceil(remaining / 1000) : null);
    }, CHECK_EVERY_MS);
    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, onActivity));
      window.clearInterval(timer);
    };
  }, [limitMs]);

  const stay = () => {
    recordActivity();
    setSecondsLeft(null);
  };

  return (
    <Modal
      open={secondsLeft !== null}
      onClose={stay}
      title="Are you still there?"
      size="sm"
      footer={<Button onClick={stay}>Stay signed in</Button>}
    >
      <p className="text-sm text-sage-700">
        For privacy, you'll be signed out in about {secondsLeft} seconds because of inactivity.
      </p>
    </Modal>
  );
}
