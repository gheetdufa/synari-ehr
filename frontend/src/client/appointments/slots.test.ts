import { describe, expect, it } from 'vitest';
import type { Slot } from '../../api/booking';
import {
  addDaysToKey,
  chunkIndexForDay,
  chunkRange,
  dayKeyOf,
  formatDayRange,
  formatDuration,
  formatLongDay,
  formatSlotTime,
  formatTimeSpan,
  groupSlotsByDay,
  timeZoneLabel,
  weekChunk,
} from './slots';

const NY = 'America/New_York';

function slot(startsAt: string, minutes = 50, location: Slot['location_type'] = 'video'): Slot {
  return {
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
    location_type: location,
    location_id: null,
  };
}

describe('addDaysToKey', () => {
  it('crosses month and year boundaries', () => {
    expect(addDaysToKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('weekChunk', () => {
  // 10pm Sep 25 in New York is already Sep 26 in UTC and in Tokyo.
  const now = new Date('2026-09-26T02:00:00Z');

  it('starts at today in the display zone and pads the request by a day on each side', () => {
    const chunk = weekChunk(0, NY, now);
    expect(chunk.days).toEqual([
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ]);
    expect(chunk.requestStart).toBe('2026-09-24');
    expect(chunk.requestEnd).toBe('2026-10-02');
    expect(chunkRange(chunk, 4, 7)).toEqual({
      clinician_id: 4,
      service_id: 7,
      start_date: '2026-09-24',
      end_date: '2026-10-02',
    });
  });

  it('uses the display zone to decide what today is', () => {
    expect(weekChunk(0, 'Asia/Tokyo', now).days[0]).toBe('2026-09-26');
  });

  it('advances by whole weeks and keeps each request within the 31-day limit', () => {
    const chunk = weekChunk(3, NY, now);
    expect(chunk.days[0]).toBe('2026-10-16');
    expect(chunk.days[6]).toBe('2026-10-22');
    const span = (Date.parse(chunk.requestEnd) - Date.parse(chunk.requestStart)) / 86_400_000;
    expect(span).toBeLessThan(31);
  });

  it('finds the chunk that shows a date', () => {
    expect(chunkIndexForDay('2026-09-25', NY, now)).toBe(0);
    expect(chunkIndexForDay('2026-10-02', NY, now)).toBe(1);
    expect(chunkIndexForDay('2026-10-22', NY, now)).toBe(3);
    expect(chunkIndexForDay('2026-10-23', NY, now)).toBeNull();
    expect(chunkIndexForDay('2026-09-24', NY, now)).toBeNull();
  });
});

describe('groupSlotsByDay', () => {
  it('groups by local date in the zone, not the UTC date', () => {
    const late = slot('2026-09-26T01:30:00Z'); // 9:30pm Sep 25 in New York
    const morning = slot('2026-09-25T13:00:00Z'); // 9:00am Sep 25
    const next = slot('2026-09-26T13:00:00Z'); // 9:00am Sep 26
    const groups = groupSlotsByDay([next, late, morning], NY);
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-09-25', '2026-09-26']);
    expect(groups[0].slots).toEqual([morning, late]);
    expect(groups[1].slots).toEqual([next]);
    expect(dayKeyOf(late.starts_at, 'UTC')).toBe('2026-09-26');
  });

  it('keeps 9:00 local on both sides of the November DST change', () => {
    const beforeChange = slot('2026-10-31T13:00:00Z'); // EDT (UTC-4)
    const afterChange = slot('2026-11-02T14:00:00Z'); // EST (UTC-5)
    const days = ['2026-10-31', '2026-11-01', '2026-11-02'];
    const groups = groupSlotsByDay([afterChange, beforeChange], NY, days);
    expect(groups).toEqual([
      { dayKey: '2026-10-31', slots: [beforeChange] },
      { dayKey: '2026-11-01', slots: [] },
      { dayKey: '2026-11-02', slots: [afterChange] },
    ]);
  });

  it('drops padded-day slots that fall outside the listed days', () => {
    const outside = slot('2026-09-24T13:00:00Z');
    const inside = slot('2026-09-25T13:00:00Z');
    const groups = groupSlotsByDay([outside, inside], NY, ['2026-09-25']);
    expect(groups).toEqual([{ dayKey: '2026-09-25', slots: [inside] }]);
  });
});

describe('labels', () => {
  it('formats a week range within and across months', () => {
    expect(formatDayRange(['2026-09-01', '2026-09-07'])).toBe('Sep 1 – 7');
    expect(formatDayRange(['2026-09-28', '2026-10-04'])).toBe('Sep 28 – Oct 4');
  });

  it('names the time zone', () => {
    expect(timeZoneLabel(NY)).toBe('Eastern Time (America/New_York)');
  });

  it('describes durations', () => {
    expect(formatDuration(50)).toBe('50 minutes');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(90)).toBe('1 hour 30 minutes');
    expect(formatDuration(120)).toBe('2 hours');
  });

  it('shows times in the given zone', () => {
    const at = slot('2026-09-25T14:00:00Z');
    expect(formatSlotTime(at.starts_at, NY)).toMatch(/^10:00\sAM$/);
    expect(formatSlotTime(at.starts_at, 'America/Los_Angeles')).toMatch(/^7:00\sAM$/);
    expect(formatTimeSpan(at.starts_at, at.ends_at, NY)).toMatch(/^10:00 – 10:50\sAM$/);
    expect(formatTimeSpan('2026-09-25T15:30:00Z', '2026-09-25T16:20:00Z', NY)).toMatch(/^11:30\sAM – 12:20\sPM$/);
  });

  it('names the local day, adding the year only when it differs', () => {
    const now = new Date('2026-09-20T12:00:00Z');
    expect(formatLongDay('2026-09-26T01:30:00Z', NY, now)).toBe('Friday, September 25');
    expect(formatLongDay('2027-01-04T15:00:00Z', NY, now)).toBe('Monday, January 4, 2027');
  });
});
