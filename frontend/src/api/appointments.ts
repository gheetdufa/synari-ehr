import type { ExternalBusyTime } from './calendarSync';
import { api } from './client';

export type AppointmentKind = 'appointment' | 'event';
export type AppointmentStatus =
  | 'requested'
  | 'scheduled'
  | 'attended'
  | 'no_show'
  | 'late_canceled'
  | 'canceled'
  | 'declined';
export type LocationType = 'video' | 'in_person' | 'phone';
export type EditScope = 'this' | 'following';
/** Who booked an appointment: someone on the team, or a client online. */
export type BookingSource = 'staff' | 'portal' | 'public';
/** What one client's attendance can be set to; null follows the session's status. */
export type AttendanceStatus = 'attended' | 'no_show' | 'late_canceled' | 'canceled';

/** Most clients one appointment can have (a group session). */
export const MAX_PARTICIPANTS = 15;

/** A staff member as other resources name them ("Jordan Lee, LCSW"). */
export interface StaffRef {
  id: number;
  name: string;
}

/** The office or video office an appointment takes place in. */
export interface LocationRef {
  id: number;
  name: string;
  place_of_service: string;
}

/** One client in an appointment, with their own fee and attendance. */
export interface Participant {
  id: number;
  client: { id: number; name: string };
  /** Billed for the session: the client of an individual session, every member of a group, the
   * identified patient of a couples or family session. */
  billable: boolean;
  fee_cents: number;
  /** Set when this client's attendance differs from the session (e.g. a group member no-show). */
  attendance: AttendanceStatus | null;
  /** The client's own attendance, else the session's status. */
  effective_status: AppointmentStatus;
}

export interface Appointment {
  id: number;
  kind: AppointmentKind;
  title: string;
  /** What calendars show: the client's name, "A & B", a group's name or "Group (n)", an event's
   * title, or "Busy". */
  title_label: string;
  clinician: StaffRef;
  /** The clients you can see; empty for events and busy time. */
  participants: Participant[];
  /** A group session: every member is billed. */
  is_group: boolean;
  service_id: number | null;
  service_code: string;
  service_description: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  location_type: LocationType;
  location: LocationRef | null;
  location_details: string;
  status: AppointmentStatus;
  source: BookingSource;
  memo: string;
  request_message: string;
  series_id: number | null;
  has_video: boolean;
  canceled_at: string | null;
  canceled_by: string | null;
  cancel_reason: string;
  created_at: string;
  /** A colleague's appointment with clients you can't see: only the time, clinician and room. */
  restricted: boolean;
  /**
   * A warning in create and update responses only: busy times in the clinician's connected Google
   * or Outlook calendar that this entry overlaps. The save went through regardless.
   */
  external_conflicts: ExternalBusyTime[];
}

export interface RecurrenceInput {
  frequency: 'weekly' | 'monthly';
  interval: number;
  count?: number;
  until?: string;
}

/** A client in a new or edited appointment. Leave `billable` unset for the default billing. */
export interface ParticipantInput {
  client_id: number;
  billable?: boolean;
}

export interface AppointmentCreate {
  kind?: AppointmentKind;
  /** Whose calendar; defaults to you when you're a clinician. */
  clinician_id?: number;
  participants?: ParticipantInput[];
  /** A group session: every participant is billed. */
  group?: boolean;
  service_id?: number | null;
  location_id?: number | null;
  title?: string;
  starts_at: string;
  duration_minutes?: number;
  location_type?: LocationType;
  location_details?: string;
  memo?: string;
  /** Charge each billed participant this instead of their rate. */
  fee_cents?: number;
  recurrence?: RecurrenceInput;
  allow_conflicts?: boolean;
  notify_client?: boolean;
}

export interface AppointmentUpdate {
  clinician_id?: number;
  /** The complete list of clients. */
  participants?: ParticipantInput[];
  starts_at?: string;
  duration_minutes?: number;
  service_id?: number | null;
  location_id?: number | null;
  title?: string;
  location_type?: LocationType;
  location_details?: string;
  memo?: string;
  fee_cents?: number;
  status?: 'scheduled' | 'attended' | 'no_show' | 'late_canceled' | 'canceled';
  allow_conflicts?: boolean;
  notify_client?: boolean;
}

/** One client's attendance (null follows the session) or whether they're billed. */
export interface ParticipantUpdate {
  attendance?: AttendanceStatus | null;
  billable?: boolean;
}

/** Body of a 409 when a time overlaps other appointments. */
export interface ConflictDetail {
  message: string;
  /** The clinician's overlapping calendar entries. */
  conflicts: Appointment[];
  /** Other appointments the clients attend at the same time (a warning only). */
  client_conflicts: Appointment[];
}

export interface AppointmentListParams {
  start: string;
  end: string;
  /** Only these clinicians' calendars (default: everyone's). */
  clinician_ids?: number[];
  client_id?: number;
  include_canceled?: boolean;
}

export const LOCATION_LABELS: Record<LocationType, string> = {
  video: 'Video',
  in_person: 'In person',
  phone: 'Phone',
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  attended: 'Attended',
  no_show: 'No show',
  late_canceled: 'Late canceled',
  canceled: 'Canceled',
  declined: 'Declined',
};

export const appointmentsApi = {
  list: (params: AppointmentListParams) => api<Appointment[]>('/appointments', { query: { ...params } }),
  get: (id: number) => api<Appointment>(`/appointments/${id}`),
  create: (input: AppointmentCreate) => api<Appointment[]>('/appointments', { body: input }),
  update: (id: number, changes: AppointmentUpdate, scope: EditScope = 'this') =>
    api<Appointment[]>(`/appointments/${id}`, { method: 'PATCH', body: changes, query: { scope } }),
  updateParticipant: (id: number, participantId: number, changes: ParticipantUpdate) =>
    api<Appointment>(`/appointments/${id}/participants/${participantId}`, { method: 'PUT', body: changes }),
  cancel: (id: number, body: { reason?: string; late?: boolean; notify_client?: boolean }, scope: EditScope = 'this') =>
    api<Appointment[]>(`/appointments/${id}/cancel`, { body, query: { scope } }),
  remove: (id: number, scope: EditScope = 'this') =>
    api<void>(`/appointments/${id}`, { method: 'DELETE', query: { scope } }),
};

export const appointmentKeys = {
  all: ['appointments'] as const,
  range: (start: string, end: string, clientId?: number) => ['appointments', 'range', start, end, clientId ?? null] as const,
  /** Calendar entries for some clinicians (null: everyone's). */
  calendar: (start: string, end: string, clinicianIds: number[] | null) =>
    ['appointments', 'calendar', start, end, clinicianIds] as const,
  detail: (id: number) => ['appointments', 'detail', id] as const,
};
