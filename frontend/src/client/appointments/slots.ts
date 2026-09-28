import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { Slot, SlotRange } from '../../api/booking';

/** How far ahead clients can browse open times, in weekly chunks. */
export const BOOKING_WEEKS = 4;

/** One week of the slot picker: seven local dates in the display zone, plus the range to request. */
export interface WeekChunk {
  index: number;
  /** The seven local dates shown (yyyy-MM-dd), first to last. */
  days: string[];
  /**
   * Dates sent to /slots. Those are the clinician's local dates, which can differ from the display
   * zone's by up to a day, so the request is padded by a day on each side and the result is
   * filtered back to `days`.
   */
  requestStart: string;
  requestEnd: string;
}

export interface SlotDay {
  dayKey: string;
  slots: Slot[];
}

/** Shift a yyyy-MM-dd date by whole days (calendar arithmetic, no time zones involved). */
export function addDaysToKey(dayKey: string, amount: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

/** The local date (yyyy-MM-dd) of an instant in a time zone. */
export function dayKeyOf(instant: string | Date, timeZone: string): string {
  const time = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  return format(new TZDate(time, timeZone), 'yyyy-MM-dd');
}

/** Week `index` (0 = the week starting today) of the booking window, in the display zone. */
export function weekChunk(index: number, timeZone: string, now: Date = new Date()): WeekChunk {
  const first = addDaysToKey(dayKeyOf(now, timeZone), index * 7);
  const days = Array.from({ length: 7 }, (_, offset) => addDaysToKey(first, offset));
  return {
    index,
    days,
    requestStart: addDaysToKey(first, -1),
    requestEnd: addDaysToKey(first, 7),
  };
}

/** The /slots query for a chunk, clinician and service. */
export function chunkRange(chunk: WeekChunk, clinicianId: number, serviceId: number): SlotRange {
  return { clinician_id: clinicianId, service_id: serviceId, start_date: chunk.requestStart, end_date: chunk.requestEnd };
}

/** Which chunk (0..BOOKING_WEEKS-1) shows a local date, or null if it's outside the window. */
export function chunkIndexForDay(dayKey: string, timeZone: string, now: Date = new Date()): number | null {
  const today = dayKeyOf(now, timeZone);
  const days = Math.round((Date.parse(`${dayKey}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0 || days >= BOOKING_WEEKS * 7) return null;
  return Math.floor(days / 7);
}

/**
 * Slots grouped by their local date in `timeZone`, soonest first. With `days`, every listed day
 * appears (possibly empty) in that order and slots on other days are dropped.
 */
export function groupSlotsByDay(slots: Slot[], timeZone: string, days?: string[]): SlotDay[] {
  const byDay = new Map<string, Slot[]>();
  for (const day of days ?? []) byDay.set(day, []);
  const sorted = [...slots].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  for (const slot of sorted) {
    const key = dayKeyOf(slot.starts_at, timeZone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(slot);
    else if (!days) byDay.set(key, [slot]);
  }
  return Array.from(byDay, ([dayKey, daySlots]) => ({ dayKey, slots: daySlots }));
}

/** A local date formatted for display ("Thu, Sep 25" by default). */
export function formatDayKey(dayKey: string, options: Intl.DateTimeFormatOptions = {}): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** "Sep 25 – Oct 1" for a run of local dates. */
export function formatDayRange(days: string[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const lastLabel = formatDayKey(last, { weekday: undefined, month: sameMonth ? undefined : 'short' });
  return `${formatDayKey(first, { weekday: undefined })} – ${lastLabel}`;
}

/** A readable name for a time zone ("Eastern Time"), falling back to the IANA id. */
export function timeZoneName(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((item) => item.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "Eastern Time (America/New_York)", or just the id when there's no friendlier name. */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  const name = timeZoneName(timeZone, at);
  return name === timeZone ? timeZone : `${name} (${timeZone})`;
}

/** "50 minutes", "1 hour", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`;
  const minutePart = rest === 1 ? '1 minute' : `${rest} minutes`;
  if (hours === 0) return minutePart;
  return rest === 0 ? hourPart : `${hourPart} ${minutePart}`;
}

/** "10:00 AM" in the zone. */
export function formatSlotTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

const PERIOD = /\s?(AM|PM)$/;

/** "10:00 – 10:50 AM", or "11:30 AM – 12:20 PM" when the period changes, in the zone. */
export function formatTimeSpan(startIso: string, endIso: string, timeZone: string): string {
  const start = formatSlotTime(startIso, timeZone);
  const end = formatSlotTime(endIso, timeZone);
  const samePeriod = PERIOD.exec(start)?.[1] === PERIOD.exec(end)?.[1];
  return samePeriod ? `${start.replace(PERIOD, '')} – ${end}` : `${start} – ${end}`;
}

/** "Thursday, September 25" in the zone, with the year added when it isn't the current one. */
export function formatLongDay(iso: string, timeZone: string, now: Date = new Date()): string {
  const yearOf = (date: Date) => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(date);
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: yearOf(date) === yearOf(now) ? undefined : 'numeric',
  }).format(date);
}
