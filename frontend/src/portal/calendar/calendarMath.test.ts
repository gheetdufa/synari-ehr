import { describe, expect, it } from 'vitest';
import type { Appointment } from '../../api/appointments';
import { testAppointment } from '../../test/appointments';
import {
  appointmentsByDay,
  busySegmentsForDay,
  dayKey,
  defaultStart,
  formatTimeRange,
  hourBounds,
  isDayKey,
  layoutSegments,
  rangeLabel,
  segmentsForDay,
  shiftAnchor,
  startOfDayKey,
  timeValue,
  visibleRange,
  zonedDateTimeToIso,
  type DaySegment,
} from './calendarMath';

const NY = 'America/New_York';

function appointment(id: number, startsAt: string, endsAt: string): Appointment {
  const duration = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  return testAppointment({ id, starts_at: startsAt, ends_at: endsAt, duration_minutes: duration, created_at: startsAt });
}

function segment(startMinute: number, endMinute: number, id = startMinute): DaySegment {
  return {
    appointment: appointment(id, '2026-09-25T14:00:00Z', '2026-09-25T15:00:00Z'),
    startMinute,
    endMinute,
    continuesBefore: false,
    continuesAfter: false,
  };
}

const iso = (date: Date) => new Date(date.getTime()).toISOString();

describe('day keys and wall-clock conversion', () => {
  it('reads the local date in the calendar zone, not UTC', () => {
    expect(dayKey('2026-09-26T02:30:00Z', NY)).toBe('2026-09-25');
    expect(dayKey('2026-09-26T02:30:00Z', 'Asia/Tokyo')).toBe('2026-09-26');
  });

  it('validates day keys', () => {
    expect(isDayKey('2026-02-28')).toBe(true);
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('26-2-1')).toBe(false);
    expect(isDayKey(null)).toBe(false);
  });

  it('converts a local date and time to UTC with the right offset for that date', () => {
    expect(zonedDateTimeToIso('2026-09-25', '10:00', NY)).toBe('2026-09-25T14:00:00.000Z');
    expect(zonedDateTimeToIso('2026-12-01', '10:00', NY)).toBe('2026-12-01T15:00:00.000Z');
    expect(zonedDateTimeToIso('2026-09-25', '10:00', 'Asia/Kolkata')).toBe('2026-09-25T04:30:00.000Z');
  });

  it('moves a wall time inside the spring-forward gap past the gap', () => {
    expect(zonedDateTimeToIso('2026-03-08', '02:30', NY)).toBe('2026-03-08T07:30:00.000Z');
    expect(timeValue('2026-03-08T07:30:00.000Z', NY)).toBe('03:30');
  });
});

describe('visible ranges', () => {
  it('spans Sunday to Sunday for a week', () => {
    const range = visibleRange('week', '2026-09-25', NY);
    expect(iso(range.start)).toBe('2026-09-20T04:00:00.000Z');
    expect(iso(range.end)).toBe('2026-09-27T04:00:00.000Z');
    expect(range.days.map((day) => dayKey(day, NY))).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
    ]);
  });

  it('keeps every day at local midnight across the fall-back change', () => {
    const range = visibleRange('week', '2026-11-04', NY);
    expect(iso(range.start)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(range.days[1])).toBe('2026-11-02T05:00:00.000Z');
    expect(iso(range.end)).toBe('2026-11-08T05:00:00.000Z');
    expect(range.days).toHaveLength(7);
  });

  it('gives the spring-forward day 23 hours', () => {
    const range = visibleRange('day', '2026-03-08', NY);
    expect(iso(range.start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(range.end)).toBe('2026-03-09T04:00:00.000Z');
    expect((range.end.getTime() - range.start.getTime()) / 3_600_000).toBe(23);
  });

  it('covers whole weeks for a month', () => {
    const range = visibleRange('month', '2026-09-14', NY);
    expect(dayKey(range.start, NY)).toBe('2026-08-30');
    expect(dayKey(range.days[range.days.length - 1], NY)).toBe('2026-10-03');
    expect(range.days).toHaveLength(35);
  });

  it('shows seven days from the anchor in the agenda', () => {
    const range = visibleRange('agenda', '2026-09-25', NY);
    expect(dayKey(range.start, NY)).toBe('2026-09-25');
    expect(dayKey(range.days[6], NY)).toBe('2026-10-01');
    expect(rangeLabel('agenda', '2026-09-25', NY)).toBe('Sep 25 – Oct 1, 2026');
  });

  it('shifts anchors by a view length', () => {
    expect(shiftAnchor('day', '2026-03-08', 1, NY)).toBe('2026-03-09');
    expect(shiftAnchor('week', '2026-09-25', -1, NY)).toBe('2026-09-18');
    expect(shiftAnchor('month', '2026-01-31', 1, NY)).toBe('2026-02-01');
    expect(shiftAnchor('month', '2026-01-15', -1, NY)).toBe('2025-12-01');
  });

  it('labels ranges', () => {
    expect(rangeLabel('week', '2026-09-25', NY)).toBe('Sep 20 – 26, 2026');
    expect(rangeLabel('week', '2026-09-30', NY)).toBe('Sep 27 – Oct 3, 2026');
    expect(rangeLabel('week', '2026-12-30', NY)).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(rangeLabel('month', '2026-09-25', NY)).toBe('September 2026');
    expect(rangeLabel('day', '2026-09-25', NY)).toBe('Friday, September 25, 2026');
  });
});

describe('positioning appointments on a day', () => {
  it('positions by wall-clock minutes in the calendar zone', () => {
    const day = startOfDayKey('2026-09-25', NY);
    const [only] = segmentsForDay([appointment(1, '2026-09-25T14:00:00Z', '2026-09-25T14:50:00Z')], day, NY);
    expect(only.startMinute).toBe(600);
    expect(only.endMinute).toBe(650);
  });

  it('lines up with the hour labels on the spring-forward day', () => {
    const day = startOfDayKey('2026-03-08', NY);
    // 1:30 EST to 3:30 EDT is one real hour, drawn from the 1:30 to the 3:30 line.
    const [only] = segmentsForDay([appointment(1, '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z')], day, NY);
    expect(only.startMinute).toBe(90);
    expect(only.endMinute).toBe(210);
  });

  it('falls back to the real duration when the wall clock repeats', () => {
    const day = startOfDayKey('2026-11-01', NY);
    // 1:30 EDT to 1:10 EST: 40 real minutes.
    const [only] = segmentsForDay([appointment(1, '2026-11-01T05:30:00Z', '2026-11-01T06:10:00Z')], day, NY);
    expect(only.startMinute).toBe(90);
    expect(only.endMinute).toBe(130);
  });

  it('clips appointments that cross midnight', () => {
    const overnight = appointment(1, '2026-09-26T02:00:00Z', '2026-09-26T06:00:00Z'); // 22:00–02:00 EDT
    const [first] = segmentsForDay([overnight], startOfDayKey('2026-09-25', NY), NY);
    const [second] = segmentsForDay([overnight], startOfDayKey('2026-09-26', NY), NY);
    expect(first).toMatchObject({ startMinute: 1320, endMinute: 1440, continuesAfter: true, continuesBefore: false });
    expect(second).toMatchObject({ startMinute: 0, endMinute: 120, continuesAfter: false, continuesBefore: true });
  });

  it('places busy times from connected calendars the same way, split at midnight', () => {
    const block = { id: 9, clinician_id: 1, starts_at: '2026-09-26T03:00:00Z', ends_at: '2026-09-26T05:00:00Z' };
    const later = { id: 8, clinician_id: 1, starts_at: '2026-09-25T20:00:00Z', ends_at: '2026-09-25T21:00:00Z' };
    const segments = busySegmentsForDay([block, later], startOfDayKey('2026-09-25', NY), NY);
    expect(segments.map((segment) => [segment.block.id, segment.startMinute, segment.endMinute])).toEqual([
      [8, 960, 1020],
      [9, 1380, 1440],
    ]);
    expect(busySegmentsForDay([block], startOfDayKey('2026-09-26', NY), NY)[0]).toMatchObject({
      startMinute: 0,
      endMinute: 60,
      continuesBefore: true,
    });
    expect(busySegmentsForDay([block], startOfDayKey('2026-09-24', NY), NY)).toEqual([]);
  });

  it('skips appointments on other days', () => {
    const day = startOfDayKey('2026-09-25', NY);
    expect(segmentsForDay([appointment(1, '2026-09-24T14:00:00Z', '2026-09-24T15:00:00Z')], day, NY)).toEqual([]);
  });

  it('groups appointments by each local day they touch', () => {
    const { days } = visibleRange('week', '2026-09-25', NY);
    const byDay = appointmentsByDay(
      [
        appointment(2, '2026-09-26T02:00:00Z', '2026-09-26T06:00:00Z'),
        appointment(1, '2026-09-21T13:00:00Z', '2026-09-21T14:00:00Z'),
      ],
      days,
    );
    expect(byDay.get('2026-09-21')?.map((a) => a.id)).toEqual([1]);
    expect(byDay.get('2026-09-25')?.map((a) => a.id)).toEqual([2]);
    expect(byDay.get('2026-09-26')?.map((a) => a.id)).toEqual([2]);
    expect(byDay.get('2026-09-22')).toEqual([]);
  });
});

describe('side-by-side layout', () => {
  it('puts overlapping appointments in columns and shares the column count', () => {
    const placed = layoutSegments([segment(540, 600, 1), segment(570, 630, 2), segment(600, 660, 3), segment(720, 780, 4)]);
    const byId = new Map(placed.map((item) => [item.appointment.id, item]));
    expect(byId.get(1)).toMatchObject({ column: 0, columns: 2 });
    expect(byId.get(2)).toMatchObject({ column: 1, columns: 2 });
    expect(byId.get(3)).toMatchObject({ column: 0, columns: 2 });
    expect(byId.get(4)).toMatchObject({ column: 0, columns: 1 });
  });

  it('uses three columns when three overlap at once', () => {
    const placed = layoutSegments([segment(540, 660, 1), segment(560, 600, 2), segment(580, 620, 3)]);
    expect(placed.map((item) => [item.column, item.columns])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it('treats back-to-back appointments as not overlapping', () => {
    const placed = layoutSegments([segment(540, 590, 1), segment(590, 640, 2)]);
    expect(placed.every((item) => item.columns === 1 && item.column === 0)).toBe(true);
  });

  it('keeps tiny blocks from colliding when drawn at the minimum height', () => {
    const placed = layoutSegments([segment(540, 545, 1), segment(550, 560, 2)], 20);
    expect(placed.map((item) => item.column)).toEqual([0, 1]);
  });
});

describe('grid helpers', () => {
  it('spans 6 AM to 10 PM unless something falls outside', () => {
    expect(hourBounds([segment(600, 660)])).toEqual({ startHour: 6, endHour: 22 });
    expect(hourBounds([segment(330, 390), segment(1350, 1400)])).toEqual({ startHour: 5, endHour: 24 });
  });

  it('formats time ranges compactly', () => {
    expect(formatTimeRange('2026-09-25T14:00:00Z', '2026-09-25T14:50:00Z', NY)).toBe('10:00 – 10:50 AM');
    expect(formatTimeRange('2026-09-25T15:30:00Z', '2026-09-25T16:20:00Z', NY)).toMatch(/^11:30\sAM – 12:20\sPM$/);
  });

  it('suggests the next half hour today and 9 AM on other days', () => {
    const now = new Date('2026-09-25T14:10:00Z'); // 10:10 EDT
    expect(defaultStart('2026-09-25', NY, now)).toBe('2026-09-25T14:30:00.000Z');
    expect(defaultStart('2026-09-28', NY, now)).toBe('2026-09-28T13:00:00.000Z');
  });
});
