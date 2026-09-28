import { describe, expect, it } from 'vitest';
import type { DashboardSummary, TodayAppointment } from '../../api/dashboard';
import { attentionItems, greetingFor, isInProgress, participantNames, sessionTiming } from './dashboardHelpers';

function appointment(overrides: Partial<TodayAppointment>): TodayAppointment {
  return {
    id: 1,
    kind: 'appointment',
    title_label: 'Alex Rivera',
    clinician: { id: 1, name: 'Dana Lee, LCSW' },
    participants: [{ id: 10, client: { id: 2, name: 'Alex Rivera' } }],
    restricted: false,
    service_description: 'Psychotherapy, 45 min',
    starts_at: '2026-09-25T15:00:00Z',
    ends_at: '2026-09-25T15:45:00Z',
    duration_minutes: 45,
    location_type: 'video',
    status: 'scheduled',
    has_video: true,
    ...overrides,
  };
}

function people(...names: string[]): TodayAppointment['participants'] {
  return names.map((name, index) => ({ id: index + 1, client: { id: index + 1, name } }));
}

describe('greetingFor', () => {
  it.each([
    ['2026-09-25T12:00:00Z', 'Good morning'],
    ['2026-09-25T18:00:00Z', 'Good afternoon'],
    ['2026-09-26T01:00:00Z', 'Good evening'],
    ['2026-09-25T04:30:00Z', 'Good morning'],
  ])('%s in New York -> %s', (iso, greeting) => {
    expect(greetingFor(new Date(iso), 'America/New_York')).toBe(greeting);
  });
});

describe('sessionTiming', () => {
  const video = appointment({});
  it.each([
    ['2026-09-25T13:30:00Z', 'upcoming'],
    ['2026-09-25T14:00:00Z', 'open'],
    ['2026-09-25T15:20:00Z', 'open'],
    ['2026-09-25T16:45:00Z', 'open'],
    ['2026-09-25T16:46:00Z', 'closed'],
  ])('at %s the room is %s', (iso, timing) => {
    expect(sessionTiming(video, new Date(iso))).toBe(timing);
  });

  it('never offers a session for in-person, canceled or event items', () => {
    const now = new Date('2026-09-25T15:10:00Z');
    expect(sessionTiming(appointment({ has_video: false, location_type: 'in_person' }), now)).toBe('none');
    expect(sessionTiming(appointment({ status: 'attended' }), now)).toBe('none');
    expect(sessionTiming(appointment({ kind: 'event', participants: [] }), now)).toBe('none');
  });

  it('knows when an appointment is in progress', () => {
    expect(isInProgress(video, new Date('2026-09-25T15:10:00Z'))).toBe(true);
    expect(isInProgress(video, new Date('2026-09-25T15:45:00Z'))).toBe(false);
  });
});

describe('participantNames', () => {
  it.each([
    ['one client', appointment({}), ''],
    ['a couple named in the title', appointment({ title_label: 'Alex Rivera & Sam Park', participants: people('Alex Rivera', 'Sam Park') }), ''],
    ['a family session with its own title', appointment({ title_label: 'Rivera family', participants: people('Alex Rivera', 'Sam Rivera') }), 'Alex Rivera, Sam Rivera'],
    [
      'a large group',
      appointment({ title_label: 'Tuesday DBT', participants: people('A One', 'B Two', 'C Three', 'D Four', 'E Five') }),
      'A One, B Two, C Three and 2 more',
    ],
    ['busy time', appointment({ title_label: 'Busy', participants: [], restricted: true }), ''],
  ])('lists the members of %s only when the title does not', (_case, entry, expected) => {
    expect(participantNames(entry)).toBe(expected);
  });
});

describe('attentionItems', () => {
  const summary: DashboardSummary = {
    scope: 'mine',
    today: [],
    pending_requests: 2,
    unread_messages: 0,
    unread_notifications: 4,
    draft_notes: 1,
    notes_awaiting_cosign: 0,
    appointments_missing_notes: 3,
    pending_forms: 5,
    flagged_forms: 1,
    waiting_room: 0,
    outstanding_cents: null,
    client_count: 12,
  };
  const clinician = { clinical: true, clinician: true, schedules: true };

  it('links each counter to where the work is and marks urgency', () => {
    const items = Object.fromEntries(attentionItems(summary, clinician).map((item) => [item.id, item]));
    expect(items.requests).toMatchObject({ count: 2, to: '/portal/calendar?requests=1' });
    expect(items.messages).toMatchObject({ count: 0, to: '/portal/messaging' });
    expect(items['missing-notes']).toMatchObject({ count: 3, to: '/portal/notes' });
    expect(items['flagged-forms'].tone).toBe('urgent');
    expect(items['waiting-room'].tone).toBe('default');
    expect(
      attentionItems({ ...summary, waiting_room: 1, flagged_forms: 0 }, clinician).find((i) => i.id === 'waiting-room')?.tone,
    ).toBe('live');
  });

  it.each([
    ['a clinician', clinician, ['waiting-room', 'flagged-forms', 'requests', 'messages', 'missing-notes', 'draft-notes', 'pending-forms']],
    [
      'an owner who runs the practice',
      { clinical: true, clinician: false, schedules: true },
      ['flagged-forms', 'requests', 'messages', 'pending-forms'],
    ],
    ['a scheduler', { clinical: false, clinician: false, schedules: true }, ['requests', 'pending-forms']],
    ['a biller', { clinical: false, clinician: false, schedules: false }, ['pending-forms']],
  ])('shows %s only the counters that apply to them', (_who, role, ids) => {
    expect(attentionItems(summary, role).map((item) => item.id)).toEqual(ids);
  });
});
