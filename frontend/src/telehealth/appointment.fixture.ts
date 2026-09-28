import type { Appointment } from '../api/appointments';

type Participant = Appointment['participants'][number];

/** A client in a test session. */
export function participant(clientId: number, name: string, changes: Partial<Participant> = {}): Participant {
  return {
    id: clientId * 10,
    client: { id: clientId, name },
    billable: true,
    fee_cents: 15000,
    attendance: null,
    effective_status: 'scheduled',
    ...changes,
  };
}

/** A video appointment for tests, with the fields the telehealth screens read (Dana Lee hosts). */
export function videoAppointment(id: number, startsAt: string, changes: Partial<Appointment> = {}): Appointment {
  const endsAt = new Date(new Date(startsAt).getTime() + 50 * 60_000).toISOString();
  return {
    id,
    kind: 'appointment',
    title: '',
    title_label: 'Alex Rivera',
    clinician: { id: 1, name: 'Dana Lee, LCSW' },
    participants: [participant(7, 'Alex Rivera')],
    is_group: false,
    service_id: null,
    service_code: '90834',
    service_description: 'Psychotherapy',
    starts_at: startsAt,
    ends_at: endsAt,
    duration_minutes: 50,
    location_type: 'video',
    location_details: '',
    status: 'scheduled',
    memo: '',
    request_message: '',
    series_id: null,
    has_video: true,
    canceled_at: null,
    canceled_by: null,
    cancel_reason: '',
    created_at: startsAt,
    restricted: false,
    external_conflicts: [],
    ...changes,
  } as Appointment;
}
