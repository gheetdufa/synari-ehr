/**
 * Time-zone-correct calendar math. Every function takes the IANA zone the calendar is shown in
 * (the therapist's), works on wall-clock dates in that zone via TZDate, and hands back instants
 * or "yyyy-MM-dd" day keys. Nothing here depends on the browser's own zone.
 */
import { TZDate } from '@date-fns/tz';
import { addDays, addMonths, endOfMonth, format, startOfMonth, startOfWeek } from 'date-fns';
import type { Appointment } from '../../api/appointments';
import type { BusyBlock } from '../../api/calendarSync';

export type CalendarView = 'day' | 'week' | 'month' | 'agenda';

export const CALENDAR_VIEWS: CalendarView[] = ['day', 'week', 'month', 'agenda'];

/** Weeks start on Sunday, as on US paper calendars. */
export const WEEK_STARTS_ON = 0;

export const MINUTES_PER_DAY = 24 * 60;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_VALUE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type Instant = Date | string | number;

function toMillis(value: Instant): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return value.getTime();
}

/** The instant as a date whose getters read wall-clock time in `timeZone`. */
export function inZone(value: Instant, timeZone: string): TZDate {
  return new TZDate(toMillis(value), timeZone);
}

/** Local calendar date ("2026-09-25") of an instant in the zone. */
export function dayKey(value: Instant, timeZone: string): string {
  return format(inZone(value, timeZone), 'yyyy-MM-dd');
}

export function isDayKey(value: string | null | undefined): value is string {
  if (!value || !DAY_KEY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Local midnight of a day key, in the zone. */
export function startOfDayKey(key: string, timeZone: string): TZDate {
  const [year, month, day] = key.split('-').map(Number);
  return new TZDate(year, month - 1, day, timeZone);
}

/** Minutes since local midnight of an instant, in the zone (wall clock). */
export function wallMinutes(value: Instant, timeZone: string): number {
  const local = inZone(value, timeZone);
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * UTC ISO string for a wall-clock date and time in the zone. Times skipped by a DST change
 * (e.g. 2:30 on a spring-forward night) resolve to the first valid instant after the gap.
 */
export function zonedDateTimeToIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const local = new TZDate(year, month - 1, day, hours, minutes, timeZone);
  return new Date(local.getTime()).toISOString();
}

export function isTimeValue(value: string): boolean {
  return TIME_VALUE.test(value);
}

/** "HH:mm" wall-clock time of an instant in the zone, for <input type="time">. */
export function timeValue(value: Instant, timeZone: string): string {
  return format(inZone(value, timeZone), 'HH:mm');
}

export interface VisibleRange {
  /** First local midnight shown (inclusive). */
  start: TZDate;
  /** Local midnight after the last day shown (exclusive). */
  end: TZDate;
  /** Each day shown, at local midnight. */
  days: TZDate[];
}

function daysBetween(start: TZDate, end: TZDate): TZDate[] {
  const days: TZDate[] = [];
  for (let day = start; day.getTime() < end.getTime(); day = addDays(day, 1)) days.push(day);
  return days;
}

/** The days a view shows around an anchor date. Month views cover whole weeks; the agenda starts on the anchor. */
export function visibleRange(view: CalendarView, anchor: string, timeZone: string): VisibleRange {
  const day = startOfDayKey(anchor, timeZone);
  let start: TZDate;
  let end: TZDate;
  if (view === 'day') {
    start = day;
    end = addDays(day, 1);
  } else if (view === 'month') {
    start = startOfWeek(startOfMonth(day), { weekStartsOn: WEEK_STARTS_ON });
    end = addDays(startOfWeek(endOfMonth(day), { weekStartsOn: WEEK_STARTS_ON }), 7);
  } else if (view === 'agenda') {
    start = day;
    end = addDays(day, 7);
  } else {
    start = startOfWeek(day, { weekStartsOn: WEEK_STARTS_ON });
    end = addDays(start, 7);
  }
  return { start, end, days: daysBetween(start, end) };
}

/** The anchor date one view-length earlier (-1) or later (+1). */
export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1, timeZone: string): string {
  const day = startOfDayKey(anchor, timeZone);
  if (view === 'day') return format(addDays(day, direction), 'yyyy-MM-dd');
  if (view === 'month') return format(addMonths(startOfMonth(day), direction), 'yyyy-MM-dd');
  return format(addDays(day, 7 * direction), 'yyyy-MM-dd');
}

/** Heading for the visible range: "Sep 20 – 26, 2026", "September 2026", "Friday, September 25, 2026". */
export function rangeLabel(view: CalendarView, anchor: string, timeZone: string): string {
  const day = startOfDayKey(anchor, timeZone);
  if (view === 'day') return format(day, 'EEEE, MMMM d, yyyy');
  if (view === 'month') return format(day, 'MMMM yyyy');
  const { start, end } = visibleRange(view, anchor, timeZone);
  const last = addDays(end, -1);
  if (start.getFullYear() !== last.getFullYear()) {
    return `${format(start, 'MMM d, yyyy')} – ${format(last, 'MMM d, yyyy')}`;
  }
  if (start.getMonth() !== last.getMonth()) {
    return `${format(start, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`;
  }
  return `${format(start, 'MMM d')} – ${format(last, 'd, yyyy')}`;
}

/** One appointment's portion of one day, in wall-clock minutes since local midnight. */
export interface DaySegment {
  appointment: Appointment;
  startMinute: number;
  endMinute: number;
  /** The appointment began on an earlier day. */
  continuesBefore: boolean;
  /** The appointment runs past this day's end. */
  continuesAfter: boolean;
}

type DayPortion = Omit<DaySegment, 'appointment'>;

/**
 * The part of [startIso, endIso) that falls on `day` (a local midnight), or null. Positions use
 * the wall clock so blocks line up with the hour labels on 23- and 25-hour DST days; when a
 * fall-back repeat makes the wall-clock end precede the start, the real duration is used instead.
 */
function portionOfDay(startIso: string, endIso: string, day: TZDate, timeZone: string): DayPortion | null {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (start >= dayEnd || end <= dayStart) return null;
  const continuesBefore = start < dayStart;
  const continuesAfter = end > dayEnd;
  const startMinute = continuesBefore ? 0 : wallMinutes(start, timeZone);
  let endMinute = end >= dayEnd ? MINUTES_PER_DAY : wallMinutes(end, timeZone);
  if (endMinute <= startMinute) {
    const realMinutes = Math.round((Math.min(end, dayEnd) - Math.max(start, dayStart)) / 60_000);
    endMinute = Math.min(MINUTES_PER_DAY, startMinute + realMinutes);
  }
  return { startMinute, endMinute, continuesBefore, continuesAfter };
}

/** The part of each appointment that falls on `day` (a local midnight), in start order. */
export function segmentsForDay(appointments: Appointment[], day: TZDate, timeZone: string): DaySegment[] {
  const segments: DaySegment[] = [];
  for (const appointment of appointments) {
    const portion = portionOfDay(appointment.starts_at, appointment.ends_at, day, timeZone);
    if (portion) segments.push({ appointment, ...portion });
  }
  return segments.sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
}

/** One busy time from a connected calendar on one day, in wall-clock minutes. */
export interface BusySegment extends DayPortion {
  block: BusyBlock;
}

/** The part of each busy time that falls on `day` (a local midnight), in start order. */
export function busySegmentsForDay(blocks: BusyBlock[], day: TZDate, timeZone: string): BusySegment[] {
  const segments: BusySegment[] = [];
  for (const block of blocks) {
    const portion = portionOfDay(block.starts_at, block.ends_at, day, timeZone);
    if (portion) segments.push({ block, ...portion });
  }
  return segments.sort((a, b) => a.startMinute - b.startMinute);
}

export interface PositionedSegment extends DaySegment {
  /** Zero-based column within its overlap group. */
  column: number;
  /** Number of columns its overlap group needs. */
  columns: number;
}

/**
 * Side-by-side layout: segments that overlap (directly or through a chain) form a group; each
 * takes the first free column, and every member of a group shares the group's column count.
 * `minMinutes` is the shortest height a block is drawn with, so tiny blocks don't collide visually.
 */
export function layoutSegments(segments: DaySegment[], minMinutes = 0): PositionedSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
  const placed: PositionedSegment[] = [];
  let group: PositionedSegment[] = [];
  let columnEnds: number[] = [];
  let groupEnd = -1;

  const closeGroup = () => {
    for (const item of group) item.columns = columnEnds.length;
    group = [];
    columnEnds = [];
  };

  for (const segment of sorted) {
    const visualEnd = Math.max(segment.endMinute, segment.startMinute + minMinutes);
    if (segment.startMinute >= groupEnd) {
      closeGroup();
      groupEnd = -1;
    }
    let column = columnEnds.findIndex((end) => end <= segment.startMinute);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(visualEnd);
    } else {
      columnEnds[column] = visualEnd;
    }
    const item: PositionedSegment = { ...segment, column, columns: 1 };
    group.push(item);
    placed.push(item);
    groupEnd = Math.max(groupEnd, visualEnd);
  }
  closeGroup();
  return placed;
}

/** Hours the time grid spans: 6:00–22:00, stretched to fit anything earlier or later. */
export function hourBounds(segments: DaySegment[], defaults: { start: number; end: number } = { start: 6, end: 22 }) {
  let startHour = defaults.start;
  let endHour = defaults.end;
  for (const segment of segments) {
    startHour = Math.min(startHour, Math.floor(segment.startMinute / 60));
    endHour = Math.max(endHour, Math.ceil(segment.endMinute / 60));
  }
  return { startHour, endHour };
}

/** Appointments overlapping each day of the range, keyed by day key, in start order. */
export function appointmentsByDay(appointments: Appointment[], days: TZDate[]): Map<string, Appointment[]> {
  const byDay = new Map<string, Appointment[]>();
  const sorted = [...appointments].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  for (const day of days) {
    const dayStart = day.getTime();
    const dayEnd = addDays(day, 1).getTime();
    byDay.set(
      format(day, 'yyyy-MM-dd'),
      sorted.filter((a) => Date.parse(a.starts_at) < dayEnd && Date.parse(a.ends_at) > dayStart),
    );
  }
  return byDay;
}

/** Split a month range's days into rows of seven. */
export function weeksOf(days: TZDate[]): TZDate[][] {
  const weeks: TZDate[][] = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return weeks;
}

/**
 * A sensible start for a new appointment: the next half hour when the anchor is today, else 9:00
 * on the anchor day.
 */
export function defaultStart(anchor: string, timeZone: string, now: Date): string {
  if (dayKey(now, timeZone) !== anchor) return zonedDateTimeToIso(anchor, '09:00', timeZone);
  const local = inZone(now, timeZone);
  const minutes = local.getHours() * 60 + local.getMinutes();
  const next = Math.ceil((minutes + 1) / 30) * 30;
  if (next >= MINUTES_PER_DAY) return zonedDateTimeToIso(anchor, '23:30', timeZone);
  const hh = String(Math.floor(next / 60)).padStart(2, '0');
  const mm = String(next % 60).padStart(2, '0');
  return zonedDateTimeToIso(anchor, `${hh}:${mm}`, timeZone);
}

function withoutPeriod(label: string): string {
  return label.replace(/\s?(AM|PM)$/, '');
}

/** "10:00 – 10:50 AM", or "11:30 AM – 12:20 PM" when the period changes. */
export function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const start = formatter.format(new Date(startIso));
  const end = formatter.format(new Date(endIso));
  const period = (label: string) => /(AM|PM)$/.exec(label)?.[1];
  return period(start) === period(end) ? `${withoutPeriod(start)} – ${end}` : `${start} – ${end}`;
}

/** Short time for dense cells: "9a", "10:30a", "12p". */
export function compactTime(iso: string, timeZone: string): string {
  const local = inZone(iso, timeZone);
  const hours = local.getHours();
  const minutes = local.getMinutes();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? 'a' : 'p';
  return minutes === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/** Hour label for the grid gutter: "6 AM", "12 PM". */
export function hourLabel(hour: number): string {
  const normalized = hour % 24;
  const hour12 = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${hour12} ${normalized < 12 ? 'AM' : 'PM'}`;
}

/** Abbreviated zone name at an instant ("EDT"), for the grid's corner. */
export function zoneAbbreviation(timeZone: string, at: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((item) => item.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

/** Friendly zone name ("Eastern Time"), falling back to the IANA id. */
export function zoneName(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((item) => item.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
