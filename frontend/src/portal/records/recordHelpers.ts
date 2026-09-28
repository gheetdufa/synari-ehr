import { useEffect, useRef } from 'react';
import type { AmendmentStatus, RecordRequestStatus } from '../../api/records';

/** Classes that mark the request a notification linked to. */
export const HIGHLIGHT_CLASSES = 'bg-primary-50/70 ring-2 ring-inset ring-primary-300';

/**
 * For the item a notification linked to: scrolls it into view and moves focus to it once it's on
 * screen. Returns the ref to put on the item.
 */
export function useHighlight<T extends HTMLElement>(highlighted: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView?.({ block: 'center' });
    ref.current.focus({ preventScroll: true });
  }, [highlighted]);
  return ref;
}

/** A positive integer id from a query parameter, or undefined. */
export function idParam(value: string | null): number | undefined {
  const id = Number(value);
  return value && Number.isInteger(id) && id > 0 ? id : undefined;
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Nudges start when this many days are left (day 20 of the 30-day deadline). */
export const DUE_SOON_DAYS = 10;

export const RECORD_STATUS_LABELS: Record<RecordRequestStatus, string> = {
  open: 'Open',
  fulfilled: 'Fulfilled',
  denied: 'Denied',
};

export const AMENDMENT_STATUS_LABELS: Record<AmendmentStatus, string> = {
  open: 'Open',
  accepted: 'Accepted',
  denied: 'Denied',
};

export const STATUS_TONES: Record<RecordRequestStatus | AmendmentStatus, Tone> = {
  open: 'info',
  fulfilled: 'success',
  accepted: 'success',
  denied: 'neutral',
};

/** "Due today", "Due in 3 days", "Due tomorrow", "Overdue by 2 days". */
export function dueText(daysLeft: number): string {
  if (daysLeft < 0) {
    const late = -daysLeft;
    return `Overdue by ${late} ${late === 1 ? 'day' : 'days'}`;
  }
  if (daysLeft === 0) return 'Due today';
  if (daysLeft === 1) return 'Due tomorrow';
  return `Due in ${daysLeft} days`;
}

/** Red once overdue, amber from day 20 (10 days left), plain otherwise. */
export function dueTone(daysLeft: number): Tone {
  if (daysLeft < 0) return 'danger';
  if (daysLeft <= DUE_SOON_DAYS) return 'warning';
  return 'neutral';
}

interface Deadlined {
  id: number;
  status: string;
  due_on: string;
  received_at: string;
}

/** Open requests first, soonest deadline first; then closed ones, newest first. */
export function byDeadline<T extends Deadlined>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aOpen = a.status === 'open';
    const bOpen = b.status === 'open';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (aOpen) return a.due_on.localeCompare(b.due_on) || a.id - b.id;
    return b.received_at.localeCompare(a.received_at) || b.id - a.id;
  });
}
