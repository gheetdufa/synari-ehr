import type { LocationType } from '../../api/appointments';
import type { AvailabilityBlock, AvailabilityBlockInput, Weekday } from '../../api/availability';
import type { Location } from '../../api/practice';

export const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WORKWEEK: Weekday[] = [0, 1, 2, 3, 4];
export const MAX_BLOCKS = 100;

/** One editable time range; `key` is only for React and never sent to the API. */
export interface AvailabilityRow {
  key: number;
  weekday: Weekday;
  start_time: string;
  end_time: string;
  location_type: LocationType;
  location_id: number | null;
}

let nextKey = 1;

export function newRow(
  weekday: Weekday,
  start_time: string,
  end_time: string,
  location_type: LocationType,
  location_id: number | null = null,
): AvailabilityRow {
  return { key: nextKey++, weekday, start_time, end_time, location_type, location_id };
}

export function rowsFromBlocks(blocks: AvailabilityBlock[]): AvailabilityRow[] {
  return blocks.map((block) => newRow(block.weekday, block.start_time, block.end_time, block.location_type, block.location_id));
}

/** One entry in a row's location menu: how the visit happens and, in person, which office. */
export interface LocationChoice {
  key: string;
  label: string;
  location_type: LocationType;
  location_id: number | null;
}

/** The menu value for a row's location. */
export function choiceKey(row: Pick<AvailabilityRow, 'location_type' | 'location_id'>): string {
  if (row.location_type !== 'in_person') return row.location_type;
  return row.location_id === null ? 'in_person' : `in_person:${row.location_id}`;
}

/**
 * Where bookable time can be: video (in the video office, so claims get its place of service),
 * each office in use, or phone. Without offices, "In person" has none.
 */
export function locationChoices(locations: Location[]): LocationChoice[] {
  const active = locations.filter((location) => location.is_active);
  const offices = active.filter((location) => !location.is_video);
  const inPerson: LocationChoice[] =
    offices.length > 0
      ? offices.map((office) => ({
          key: `in_person:${office.id}`,
          label: `In person · ${office.name}`,
          location_type: 'in_person',
          location_id: office.id,
        }))
      : [{ key: 'in_person', label: 'In person', location_type: 'in_person', location_id: null }];
  return [
    { key: 'video', label: 'Video', location_type: 'video', location_id: active.find((location) => location.is_video)?.id ?? null },
    ...inPerson,
    { key: 'phone', label: 'Phone', location_type: 'phone', location_id: null },
  ];
}

function byDayThenStart(a: AvailabilityBlockInput, b: AvailabilityBlockInput): number {
  return a.weekday - b.weekday || a.start_time.localeCompare(b.start_time) || a.end_time.localeCompare(b.end_time);
}

/** The API payload: rows without their keys, ordered by day and start time. */
export function blocksFromRows(rows: AvailabilityRow[]): AvailabilityBlockInput[] {
  return rows
    .map(({ weekday, start_time, end_time, location_type, location_id }) => ({
      weekday,
      start_time,
      end_time,
      location_type,
      location_id,
    }))
    .sort(byDayThenStart);
}

/** Order-insensitive fingerprint used to tell whether the week has unsaved changes. */
export function serializeRows(rows: AvailabilityRow[]): string {
  return JSON.stringify(blocksFromRows(rows));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Problems keyed by row key: missing times, end before start, and overlaps on the same day. */
export function validateRows(rows: AvailabilityRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  for (const row of rows) {
    if (!HHMM.test(row.start_time) || !HHMM.test(row.end_time)) errors[row.key] = 'Enter a start and end time';
    else if (row.end_time <= row.start_time) errors[row.key] = 'End time must be after the start time';
  }
  for (const weekday of WEEKDAYS) {
    const day = rows
      .filter((row) => row.weekday === weekday && !errors[row.key])
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    let latestEnd = '';
    for (const row of day) {
      if (latestEnd && row.start_time < latestEnd) errors[row.key] = 'Overlaps another time range on this day';
      if (row.end_time > latestEnd) latestEnd = row.end_time;
    }
  }
  return errors;
}

function addMinutes(time: string, minutes: number): string {
  const [hours, mins] = time.split(':').map(Number);
  const total = Math.min(hours * 60 + mins + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** A sensible next range for a day: 9-5 when empty, otherwise the hour after the last range. */
export function suggestedRange(dayRows: AvailabilityRow[]): { start_time: string; end_time: string } {
  const latest = dayRows
    .map((row) => row.end_time)
    .filter((time) => HHMM.test(time))
    .sort()
    .pop();
  if (!latest || latest >= '23:00') return { start_time: '09:00', end_time: '17:00' };
  return { start_time: latest, end_time: addMinutes(latest, 60) };
}

/** Replace the ranges on `targets` with copies of `source` day's ranges. */
export function copyDay(rows: AvailabilityRow[], source: Weekday, targets: Weekday[]): AvailabilityRow[] {
  const template = rows.filter((row) => row.weekday === source);
  const others = targets.filter((day) => day !== source);
  const kept = rows.filter((row) => !others.includes(row.weekday));
  const copies = others.flatMap((day) =>
    template.map((row) => newRow(day, row.start_time, row.end_time, row.location_type, row.location_id)),
  );
  return [...kept, ...copies];
}

/** Total bookable hours in the week (for the summary line). */
export function weeklyHours(rows: AvailabilityRow[]): number {
  return rows.reduce((total, row) => {
    if (!HHMM.test(row.start_time) || !HHMM.test(row.end_time) || row.end_time <= row.start_time) return total;
    const [sh, sm] = row.start_time.split(':').map(Number);
    const [eh, em] = row.end_time.split(':').map(Number);
    return total + (eh * 60 + em - (sh * 60 + sm)) / 60;
  }, 0);
}
