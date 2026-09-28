/**
 * Pure helpers behind the message thread: who wrote each message as the viewer sees it, day
 * separators and sender grouping in the viewer's time zone, read receipts, unread detection,
 * and merging paged thread data.
 */
import type { MessageBase, RiskLevel, SenderRole } from '../../api/messages';

/** Any message the shared thread can show; staff see who sent it and its risk screening. */
export type ThreadMessage = MessageBase & {
  sent_by_me?: boolean;
  risk_level?: RiskLevel;
  sender_staff_id?: number | null;
  sender_contact_id?: number | null;
};

/** Consecutive messages from one sender merge into a group when sent this close together. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Who wrote a message, as the person reading the thread sees it. */
export interface Sender {
  /** The viewer wrote it (a clinician also owns the automatic replies in their conversations). */
  own: boolean;
  /** "You", a staff member, a contact writing for the client, or the client. */
  name: string;
  /** Name the sender above their messages: anyone but the viewer and their usual counterpart. */
  showName: boolean;
}

export type DescribeSender = (message: ThreadMessage) => Sender;

/**
 * Senders as a staff member sees a conversation. The client is the usual counterpart; anyone
 * else (a colleague replying, the client's parent writing for them) is named.
 */
export function staffViewSender({
  staffId,
  conversationClinicianId,
  clientName,
}: {
  staffId: number;
  conversationClinicianId: number;
  clientName: string;
}): DescribeSender {
  return (message) => {
    if (message.sender_role === 'client') {
      return message.sender_name === null
        ? { own: false, name: clientName, showName: false }
        : { own: false, name: message.sender_name, showName: true };
    }
    const own = message.is_automatic ? conversationClinicianId === staffId : message.sender_staff_id === staffId;
    if (own) return { own, name: 'You', showName: false };
    return { own, name: message.sender_name ?? 'Practice staff', showName: !message.is_automatic };
  };
}

/**
 * Senders as the client portal sees a conversation. The conversation's clinician is the usual
 * counterpart; other staff and, for a signed-in parent, the client's own messages are named.
 */
export function portalViewSender({
  clinicianName,
  clientFirstName,
}: {
  clinicianName: string;
  clientFirstName: string;
}): DescribeSender {
  return (message) => {
    if (message.sender_role === 'staff') {
      const name = message.sender_name ?? clinicianName;
      return { own: false, name, showName: !message.is_automatic && name !== clinicianName };
    }
    if (message.sent_by_me) return { own: true, name: 'You', showName: false };
    return { own: false, name: message.sender_name ?? clientFirstName, showName: true };
  };
}

function sameSender(a: ThreadMessage, b: ThreadMessage): boolean {
  return (
    a.sender_role === b.sender_role &&
    a.sender_name === b.sender_name &&
    (a.sender_staff_id ?? null) === (b.sender_staff_id ?? null) &&
    (a.sender_contact_id ?? null) === (b.sender_contact_id ?? null)
  );
}

export type ThreadItem<M extends ThreadMessage = ThreadMessage> =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'group';
      key: string;
      senderRole: SenderRole;
      automatic: boolean;
      messages: M[];
      /** False while the conversation continues within GROUP_WINDOW_MS, to avoid a timestamp per group. */
      showTime: boolean;
    };

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day ("2026-09-25") an instant falls on in the given time zone. */
export function dayKey(iso: string | number, timeZone?: string): string {
  const cacheKey = timeZone ?? '';
  let formatter = dayKeyFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayKeyFormatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(iso));
}

/** Whole calendar days from `iso`'s day to `now`'s day in the zone (0 = same day). */
export function daysAgo(iso: string, timeZone: string | undefined, now: number): number {
  const toUtc = (key: string) => {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(dayKey(now, timeZone)) - toUtc(dayKey(iso, timeZone))) / DAY_MS);
}

function sameYear(iso: string, timeZone: string | undefined, now: number): boolean {
  return dayKey(iso, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
}

/** Separator label: "Today", "Yesterday", a weekday this week, else a date. */
export function dayLabel(iso: string, timeZone: string | undefined, now: number): string {
  const days = daysAgo(iso, timeZone, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = new Date(iso);
  if (days > 1 && days < 7) return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
  if (sameYear(iso, timeZone, now)) {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

/** Compact time for inbox rows: "Now", "12m", "3:42 PM", "Yesterday", "Mon", "Sep 3". */
export function formatListTime(iso: string, timeZone: string | undefined, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Now';
  const days = daysAgo(iso, timeZone, now);
  if (minutes < 60 && days === 0) return `${minutes}m`;
  const date = new Date(iso);
  if (days === 0) return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  if (sameYear(iso, timeZone, now)) {
    return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

/** "just now", "5m ago", "3h ago", "2d ago", else a date in the zone. */
export function relativeTime(iso: string, timeZone: string | undefined, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(iso),
  );
}

/**
 * Thread rows in display order: a separator whenever the day changes in the viewer's zone, and
 * groups of consecutive messages from one sender sent within GROUP_WINDOW_MS of each other.
 * Automatic replies always stand alone so their label stays with them. A group shows its time
 * only when the conversation pauses (or the day ends) after it.
 */
export function buildThreadItems<M extends ThreadMessage>(
  messages: M[],
  timeZone: string | undefined,
  now: number,
): ThreadItem<M>[] {
  const items: ThreadItem<M>[] = [];
  let currentDay: string | null = null;
  let group: Extract<ThreadItem<M>, { kind: 'group' }> | null = null;
  for (const message of messages) {
    const day = dayKey(message.created_at, timeZone);
    if (day !== currentDay) {
      currentDay = day;
      group = null;
      items.push({ kind: 'day', key: `day-${day}`, label: dayLabel(message.created_at, timeZone, now) });
    }
    const previous = group?.messages[group.messages.length - 1];
    const joins =
      group !== null &&
      previous !== undefined &&
      !group.automatic &&
      !message.is_automatic &&
      sameSender(previous, message) &&
      new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() <= GROUP_WINDOW_MS;
    if (joins && group) {
      group.messages.push(message);
      continue;
    }
    if (group && previous) {
      group.showTime = new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() > GROUP_WINDOW_MS;
    }
    group = {
      kind: 'group',
      key: `group-${message.id}`,
      senderRole: message.sender_role,
      automatic: message.is_automatic,
      messages: [message],
      showTime: true,
    };
    items.push(group);
  }
  return items;
}

export interface ReadReceipts {
  /** The latest message from the viewer's side that the other side has read. */
  readId: number | null;
  /** The latest message from the viewer's side when it hasn't been read yet. */
  sentId: number | null;
}

/**
 * Where to show "Read" and "Sent" under messages from the viewer's side of the conversation
 * (the practice or the client), skipping automatic replies and removed messages.
 */
export function readReceipts(messages: ThreadMessage[], viewerSide: SenderRole): ReadReceipts {
  let readId: number | null = null;
  let lastSent: ThreadMessage | null = null;
  for (const message of messages) {
    if (message.sender_role !== viewerSide || message.is_automatic || message.removed) continue;
    lastSent = message;
    if (message.read_by_recipient) readId = message.id;
  }
  const sentId = lastSent && !lastSent.read_by_recipient ? lastSent.id : null;
  return { readId, sentId };
}

/** The newest message from the other side that hasn't been read, or null when all are read. */
export function newestUnreadIncomingId(messages: ThreadMessage[], viewerSide: SenderRole): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sender_role !== viewerSide && !message.removed && !message.read_by_recipient) return message.id;
  }
  return null;
}

/** True when a client message was screened as possible crisis language. */
export function isFlagged(message: ThreadMessage): boolean {
  return message.sender_role === 'client' && (message.risk_level === 'high' || message.risk_level === 'moderate');
}

/**
 * One oldest-first list from infinite-query pages (newest page first, each page oldest-first),
 * without duplicates if pages overlap after new messages arrive.
 */
export function mergePages<M extends { id: number }>(pages: M[][]): M[] {
  const byId = new Map<number, M>();
  for (const page of pages) for (const message of page) byId.set(message.id, message);
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

/** The before_id for the next older page, or undefined when the page shows the thread's start. */
export function nextBeforeId(page: { id: number }[], pageSize: number): number | undefined {
  return page.length < pageSize || page.length === 0 ? undefined : page[0].id;
}

/** Replace a message wherever it is in the pages, or append it to the newest page. */
export function upsertIntoPages<M extends { id: number }>(pages: M[][], message: M): M[][] {
  if (pages.some((page) => page.some((existing) => existing.id === message.id))) {
    return pages.map((page) => page.map((existing) => (existing.id === message.id ? message : existing)));
  }
  if (pages.length === 0) return [[message]];
  return pages.map((page, index) => (index === 0 ? [...page, message] : page));
}
