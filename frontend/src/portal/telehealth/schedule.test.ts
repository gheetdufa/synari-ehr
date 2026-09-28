import { describe, expect, it } from 'vitest';
import { videoAppointment as appointment } from '../../telehealth/appointment.fixture';
import { dayKey, groupByDay, scheduleRange, videoAppointments } from './schedule';

const ZONE = 'America/New_York';

describe('scheduleRange', () => {
  it('runs from local midnight today for eight days', () => {
    // 01:30 UTC on Oct 6 is still Oct 5 in New York (EDT, UTC-4).
    const range = scheduleRange(ZONE, new Date('2026-10-06T01:30:00Z').getTime());
    expect(new Date(range.start).toISOString()).toBe('2026-10-05T04:00:00.000Z');
    expect(new Date(range.end).toISOString()).toBe('2026-10-13T04:00:00.000Z');
  });
});

describe('dayKey', () => {
  it('uses the practice time zone, not UTC', () => {
    expect(dayKey('2026-10-06T01:30:00Z', ZONE)).toBe('2026-10-05');
    expect(dayKey('2026-10-06T01:30:00Z', 'UTC')).toBe('2026-10-06');
  });
});

describe('videoAppointments', () => {
  const colleague = { id: 2, name: 'Jordan Park, LMFT' };
  const all = [
    appointment(1, '2026-10-05T16:00:00Z'),
    appointment(2, '2026-10-05T14:00:00Z'),
    appointment(3, '2026-10-05T15:00:00Z', { has_video: false, location_type: 'in_person' }),
    appointment(4, '2026-10-05T17:00:00Z', { status: 'canceled' }),
    appointment(5, '2026-10-05T18:00:00Z', { kind: 'event', participants: [] }),
    appointment(6, '2026-10-05T13:00:00Z', { clinician: colleague }),
    appointment(7, '2026-10-05T12:00:00Z', { clinician: colleague, restricted: true, participants: [], title_label: 'Busy' }),
  ];

  it("keeps one clinician's upcoming video appointments, soonest first", () => {
    expect(videoAppointments(all, 1).map((a) => a.id)).toEqual([2, 1]);
  });

  it("keeps everyone's, leaving out appointments whose clients you can't see", () => {
    expect(videoAppointments(all, null).map((a) => a.id)).toEqual([6, 2, 1]);
  });
});

describe('groupByDay', () => {
  it('labels today and tomorrow and names later days', () => {
    const now = new Date('2026-10-05T12:00:00Z').getTime();
    const groups = groupByDay(
      [
        appointment(1, '2026-10-05T14:00:00Z'),
        appointment(2, '2026-10-05T20:00:00Z'),
        appointment(3, '2026-10-06T14:00:00Z'),
        appointment(4, '2026-10-08T14:00:00Z'),
      ],
      ZONE,
      now,
    );
    expect(groups.map((g) => [g.label, g.appointments.map((a) => a.id)])).toEqual([
      ['Today', [1, 2]],
      ['Tomorrow', [3]],
      ['Thursday, Oct 8', [4]],
    ]);
    expect(groups[0].isToday).toBe(true);
  });
});
