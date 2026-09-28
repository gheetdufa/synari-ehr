import type { Appointment, Participant } from '../api/appointments';

/** A client in a test appointment: Alex Rivera (client 3), billed $150. */
export function testParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: 301,
    client: { id: 3, name: 'Alex Rivera' },
    billable: true,
    fee_cents: 15000,
    attendance: null,
    effective_status: 'scheduled',
    ...overrides,
  };
}

/**
 * An individual video appointment for tests: Alex Rivera with Dana Lee (staff 1, the default
 * `testSession()` clinician), scheduled, unless overridden.
 */
export function testAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 42,
    kind: 'appointment',
    title: '',
    title_label: 'Alex Rivera',
    clinician: { id: 1, name: 'Dana Lee, LCSW' },
    participants: [testParticipant()],
    is_group: false,
    service_id: 7,
    service_code: '90834',
    service_description: 'Psychotherapy, 45 min',
    starts_at: '2026-09-25T14:00:00Z',
    ends_at: '2026-09-25T14:45:00Z',
    duration_minutes: 45,
    location_type: 'video',
    location: null,
    location_details: '',
    status: 'scheduled',
    source: 'staff',
    memo: '',
    request_message: '',
    series_id: null,
    has_video: true,
    canceled_at: null,
    canceled_by: null,
    cancel_reason: '',
    created_at: '2026-09-01T00:00:00Z',
    restricted: false,
    external_conflicts: [],
    ...overrides,
  };
}
