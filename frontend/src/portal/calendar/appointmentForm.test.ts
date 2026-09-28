import { describe, expect, it } from 'vitest';
import type { Appointment } from '../../api/appointments';
import type { Location, Service } from '../../api/practice';
import { testAppointment, testParticipant } from '../../test/appointments';
import {
  addParticipant,
  hasChanges,
  locationFor,
  newAppointmentValues,
  recurrenceFromValues,
  removeParticipant,
  toCreatePayload,
  toUpdatePayload,
  validateValues,
  valuesFromAppointment,
  withBilledClient,
  withGroup,
  withKind,
  withService,
  type AppointmentFormValues,
  type RepeatOption,
} from './appointmentForm';

const NY = 'America/New_York';

const SERVICE: Service = {
  id: 7,
  code: '90834',
  description: 'Psychotherapy, 45 min',
  duration_minutes: 45,
  rate_cents: 15000,
  is_default: true,
  is_active: true,
  bookable_online: true,
  bookable_by_new_clients: true,
};

const INTAKE: Service = { ...SERVICE, id: 8, code: '90791', description: 'Intake', duration_minutes: 60, rate_cents: 20000 };
const GROUP_THERAPY: Service = { ...SERVICE, id: 9, code: '90853', description: 'Group psychotherapy', duration_minutes: 90 };

const ALEX = { id: 3, name: 'Alex Rivera' };
const SAM = { id: 4, name: 'Sam Rivera' };
const JO = { id: 5, name: 'Jo Park' };

function office(id: number, overrides: Partial<Location> = {}): Location {
  return {
    id,
    name: `Office ${id}`,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    postal_code: '',
    place_of_service: '11',
    is_video: false,
    is_active: true,
    ...overrides,
  };
}

const LOCATIONS = [office(1), office(2, { name: 'Video office', is_video: true, place_of_service: '10' }), office(3)];

function base(overrides: Partial<AppointmentFormValues> = {}): AppointmentFormValues {
  return {
    ...newAppointmentValues({ startsAt: '2026-09-25T14:00:00Z', timeZone: NY, clinicianId: 1, client: ALEX, service: SERVICE }),
    ...overrides,
  };
}

const EXISTING: Appointment = testAppointment({
  memo: 'Bring worksheet',
  series_id: 5,
  location: { id: 2, name: 'Video office', place_of_service: '10' },
});

const COUPLE: Appointment = testAppointment({
  title_label: 'Alex Rivera & Sam Rivera',
  participants: [
    testParticipant(),
    testParticipant({ id: 302, client: { id: 4, name: 'Sam Rivera' }, billable: false, fee_cents: 0 }),
  ],
});

describe('new appointment values', () => {
  it('prefills date and time in the calendar zone, the clinician, the client and the service', () => {
    const values = base();
    expect(values).toMatchObject({ date: '2026-09-25', time: '10:00', duration: '45', fee: '', serviceId: 7, clinicianId: 1 });
    expect(values.participants).toEqual([{ clientId: 3, name: 'Alex Rivera', billable: true }]);
    expect(values.notifyClient).toBe(true);
  });

  it('fills the duration when a service is chosen; a group psychotherapy code makes it a group', () => {
    expect(withService(base(), INTAKE)).toMatchObject({ serviceId: 8, duration: '60', group: false });
    const group = withService(addParticipant(base(), SAM), GROUP_THERAPY);
    expect(group.group).toBe(true);
    expect(group.participants.every((participant) => participant.billable)).toBe(true);
  });

  it('switches to an event without email notification', () => {
    expect(withKind(base(), 'event')).toMatchObject({ kind: 'event', notifyClient: false });
  });
});

describe('participants', () => {
  it('bills only the identified patient of a couples or family session', () => {
    const couple = addParticipant(base(), SAM);
    expect(couple.participants.map((participant) => participant.billable)).toEqual([true, false]);
    const switched = withBilledClient(couple, SAM.id);
    expect(switched.participants.map((participant) => participant.billable)).toEqual([false, true]);
  });

  it('bills every member of a group, and one client again when it stops being a group', () => {
    const group = withGroup(addParticipant(addParticipant(base(), SAM), JO), true);
    expect(group.participants.map((participant) => participant.billable)).toEqual([true, true, true]);
    expect(addParticipant(group, { id: 6, name: 'Kim Lee' }).participants[3].billable).toBe(true);
    expect(withGroup(group, false).participants.map((participant) => participant.billable)).toEqual([true, false, false]);
  });

  it('keeps someone billed when the billed client is removed, and ignores duplicates', () => {
    const couple = withBilledClient(addParticipant(base(), SAM), SAM.id);
    expect(removeParticipant(couple, SAM.id).participants).toEqual([{ clientId: 3, name: 'Alex Rivera', billable: true }]);
    expect(addParticipant(couple, ALEX)).toBe(couple);
  });
});

describe('locations', () => {
  it.each([
    ['video', null, 2],
    ['in_person', null, 1],
    ['in_person', 3, 3],
    ['in_person', 2, 1],
    ['phone', 2, 2],
    ['phone', 1, null],
    ['video', 1, 2],
  ] as const)('%s from office %s picks %s', (type, current, expected) => {
    expect(locationFor(type, LOCATIONS, current)).toBe(expected);
  });

  it('skips offices no longer in use', () => {
    expect(locationFor('in_person', [office(1, { is_active: false }), office(4)], null)).toBe(4);
  });
});

describe('recurrence mapping', () => {
  const cases: [RepeatOption, 'weekly' | 'monthly', number][] = [
    ['weekly', 'weekly', 1],
    ['every2weeks', 'weekly', 2],
    ['every3weeks', 'weekly', 3],
    ['every4weeks', 'weekly', 4],
    ['monthly', 'monthly', 1],
  ];

  it.each(cases)('maps %s to %s every %i', (repeat, frequency, interval) => {
    expect(recurrenceFromValues(base({ repeat, repeatEnd: 'count', occurrences: '12' }))).toEqual({
      frequency,
      interval,
      count: 12,
    });
  });

  it('ends on a date instead of a count', () => {
    expect(recurrenceFromValues(base({ repeat: 'every2weeks', repeatEnd: 'until', until: '2026-12-31' }))).toEqual({
      frequency: 'weekly',
      interval: 2,
      until: '2026-12-31',
    });
  });

  it('has no rule for a one-off', () => {
    expect(recurrenceFromValues(base())).toBeUndefined();
  });
});

describe('validation', () => {
  it('accepts a complete appointment', () => {
    expect(validateValues(base(), 'create')).toEqual({});
  });

  it('requires a client and a clinician for appointments and a title for events', () => {
    expect(validateValues(base({ participants: [] }), 'create').participants).toBe('Choose a client');
    expect(validateValues(base({ clinicianId: null }), 'create').clinicianId).toBe('Choose a clinician');
    expect(validateValues(withKind(base({ participants: [] }), 'event'), 'create')).toEqual({ title: 'Give the event a title' });
  });

  it('needs someone billed and at most 15 clients', () => {
    const unbilled = base({ participants: [{ clientId: 3, name: 'Alex Rivera', billable: false }] });
    expect(validateValues(unbilled, 'create').participants).toBe('Choose who is billed for the session');
    const crowd = Array.from({ length: 16 }, (_, index) => ({ clientId: index + 1, name: `Client ${index}`, billable: true }));
    expect(validateValues(base({ participants: crowd }), 'create').participants).toBe('Up to 15 clients');
  });

  it('limits occurrences to 2..100 and needs an end date after the start', () => {
    expect(validateValues(base({ repeat: 'weekly', occurrences: '101' }), 'create').occurrences).toBeDefined();
    expect(validateValues(base({ repeat: 'weekly', occurrences: '1' }), 'create').occurrences).toBeDefined();
    expect(validateValues(base({ repeat: 'weekly', occurrences: '100' }), 'create')).toEqual({});
    expect(validateValues(base({ repeat: 'monthly', repeatEnd: 'until', until: '2026-09-25' }), 'create').until).toBeDefined();
    expect(validateValues(base({ repeat: 'monthly', repeatEnd: 'until', until: '' }), 'create').until).toBeDefined();
  });

  it('checks duration and fee', () => {
    expect(validateValues(base({ duration: '4' }), 'create').duration).toBeDefined();
    expect(validateValues(base({ duration: '50.5' }), 'create').duration).toBeDefined();
    expect(validateValues(base({ fee: 'abc' }), 'create').fee).toBeDefined();
    expect(validateValues(base({ fee: '' }), 'create')).toEqual({});
  });
});

describe('create payload', () => {
  it('converts local wall time to UTC and sends a fee override in cents', () => {
    expect(toCreatePayload(base({ fee: '$1,200.50', locationType: 'video', locationId: 2, memo: '  note  ' }), NY)).toEqual({
      kind: 'appointment',
      clinician_id: 1,
      participants: [{ client_id: 3 }],
      service_id: 7,
      starts_at: '2026-09-25T14:00:00.000Z',
      duration_minutes: 45,
      location_type: 'video',
      location_id: 2,
      location_details: '',
      memo: 'note',
      fee_cents: 120050,
      notify_client: true,
    });
  });

  it('leaves fees to each client’s rate when blank', () => {
    expect(toCreatePayload(base({ fee: '' }), NY)).not.toHaveProperty('fee_cents');
  });

  it('names who is billed in a couples session, and flags a group', () => {
    const couple = withBilledClient(addParticipant(base({ title: ' Rivera family ' }), SAM), SAM.id);
    expect(toCreatePayload(couple, NY)).toMatchObject({
      participants: [
        { client_id: 3, billable: false },
        { client_id: 4, billable: true },
      ],
      title: 'Rivera family',
    });
    expect(toCreatePayload(couple, NY)).not.toHaveProperty('group');
    const group = toCreatePayload(withGroup(couple, true), NY);
    expect(group).toMatchObject({ group: true, participants: [{ billable: true }, { billable: true }] });
  });

  it('uses the offset in effect on the chosen date (winter time)', () => {
    expect(toCreatePayload(base({ date: '2026-12-01' }), NY).starts_at).toBe('2026-12-01T15:00:00.000Z');
  });

  it('includes the recurrence rule', () => {
    const payload = toCreatePayload(base({ repeat: 'every3weeks', repeatEnd: 'count', occurrences: '6' }), NY);
    expect(payload.recurrence).toEqual({ frequency: 'weekly', interval: 3, count: 6 });
  });

  it('sends events with a title and without clients, service or fee', () => {
    const payload = toCreatePayload(withKind(base({ title: ' Supervision ', duration: '90' }), 'event'), NY);
    expect(payload).toEqual({
      kind: 'event',
      clinician_id: 1,
      title: 'Supervision',
      starts_at: '2026-09-25T14:00:00.000Z',
      duration_minutes: 90,
      location_type: 'in_person',
      location_details: '',
      memo: '',
    });
  });
});

describe('update payload', () => {
  it('round-trips an appointment without changes', () => {
    const payload = toUpdatePayload(valuesFromAppointment(EXISTING, NY), EXISTING, NY);
    expect(payload).toEqual({});
    expect(hasChanges(payload)).toBe(false);
    expect(toUpdatePayload(valuesFromAppointment(COUPLE, NY), COUPLE, NY)).toEqual({});
  });

  it('sends only the changed fields', () => {
    const values = { ...valuesFromAppointment(EXISTING, NY), time: '11:30', memo: 'Updated', clinicianId: 9, notifyClient: true };
    expect(toUpdatePayload(values, EXISTING, NY)).toEqual({
      starts_at: '2026-09-25T15:30:00.000Z',
      clinician_id: 9,
      memo: 'Updated',
      notify_client: true,
    });
  });

  it('sends a service change without repricing it here', () => {
    const values = withService(valuesFromAppointment(EXISTING, NY), INTAKE);
    expect(toUpdatePayload(values, EXISTING, NY)).toEqual({ service_id: 8, duration_minutes: 60 });
    expect(toUpdatePayload({ ...values, fee: '90' }, EXISTING, NY)).toMatchObject({ fee_cents: 9000 });
  });

  it('sends the whole client list when clients or billing change', () => {
    const added = addParticipant(valuesFromAppointment(COUPLE, NY), JO);
    expect(toUpdatePayload(added, COUPLE, NY)).toEqual({
      participants: [
        { client_id: 3, billable: true },
        { client_id: 4, billable: false },
        { client_id: 5, billable: false },
      ],
    });
    const rebilled = withBilledClient(valuesFromAppointment(COUPLE, NY), SAM.id);
    expect(toUpdatePayload(rebilled, COUPLE, NY).participants).toEqual([
      { client_id: 3, billable: false },
      { client_id: 4, billable: true },
    ]);
    const alone = removeParticipant(valuesFromAppointment(COUPLE, NY), SAM.id);
    expect(toUpdatePayload(alone, COUPLE, NY)).toEqual({ participants: [{ client_id: 3 }] });
  });

  it('moves the office with the location type', () => {
    const values = { ...valuesFromAppointment(EXISTING, NY), locationType: 'in_person' as const, locationId: 1 };
    expect(toUpdatePayload(values, EXISTING, NY)).toEqual({ location_type: 'in_person', location_id: 1 });
  });

  it('sends event title changes', () => {
    const event = testAppointment({ kind: 'event', participants: [], title: 'Lunch', title_label: 'Lunch', service_id: null });
    const values = { ...valuesFromAppointment(event, NY), title: 'Team lunch' };
    expect(toUpdatePayload(values, event, NY)).toEqual({ title: 'Team lunch' });
  });
});
