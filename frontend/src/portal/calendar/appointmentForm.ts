/** The appointment form's values and their mapping to API payloads (pure; unit-tested). */
import {
  MAX_PARTICIPANTS,
  type Appointment,
  type AppointmentCreate,
  type AppointmentKind,
  type AppointmentUpdate,
  type LocationType,
  type ParticipantInput,
  type RecurrenceInput,
} from '../../api/appointments';
import type { Location, Service } from '../../api/practice';
import { parseMoneyToCents } from '../../lib/format';
import { dayKey, isDayKey, isTimeValue, timeValue, zonedDateTimeToIso } from './calendarMath';

export type RepeatOption = 'none' | 'weekly' | 'every2weeks' | 'every3weeks' | 'every4weeks' | 'monthly';
export type RepeatEnd = 'count' | 'until';

export const REPEAT_LABELS: Record<RepeatOption, string> = {
  none: 'Does not repeat',
  weekly: 'Every week',
  every2weeks: 'Every 2 weeks',
  every3weeks: 'Every 3 weeks',
  every4weeks: 'Every 4 weeks',
  monthly: 'Every month',
};

const REPEAT_RULES: Record<Exclude<RepeatOption, 'none'>, Pick<RecurrenceInput, 'frequency' | 'interval'>> = {
  weekly: { frequency: 'weekly', interval: 1 },
  every2weeks: { frequency: 'weekly', interval: 2 },
  every3weeks: { frequency: 'weekly', interval: 3 },
  every4weeks: { frequency: 'weekly', interval: 4 },
  monthly: { frequency: 'monthly', interval: 1 },
};

export const MAX_OCCURRENCES = 100;
export const DEFAULT_DURATION_MINUTES = 50;
const DEFAULT_EVENT_MINUTES = 60;

/** Group psychotherapy codes: sessions with them bill every member, as the API does. */
export const GROUP_SERVICE_CODES: readonly string[] = ['90853', '90849'];

/** A client in the appointment being edited. */
export interface ParticipantValue {
  clientId: number;
  /** Full name, for the chip. */
  name: string;
  /** Billed for the session. */
  billable: boolean;
}

export interface AppointmentFormValues {
  kind: AppointmentKind;
  /** Whose calendar. */
  clinicianId: number | null;
  participants: ParticipantValue[];
  /** A group session: every client is billed. */
  group: boolean;
  serviceId: number | null;
  /** An event's title, or a shared session's or group's name. */
  title: string;
  /** Local date in the calendar zone, yyyy-MM-dd. */
  date: string;
  /** Local wall-clock time, HH:mm. */
  time: string;
  duration: string;
  locationType: LocationType;
  /** The office or video office. */
  locationId: number | null;
  locationDetails: string;
  /** A fee for every billed client instead of their rate, in dollars as typed; blank uses rates. */
  fee: string;
  repeat: RepeatOption;
  repeatEnd: RepeatEnd;
  occurrences: string;
  until: string;
  memo: string;
  notifyClient: boolean;
}

export type FormErrors = Partial<Record<keyof AppointmentFormValues, string>>;

/** Whether a service bills every member (group psychotherapy). */
export function isGroupService(service: Pick<Service, 'code'> | null | undefined): boolean {
  return service ? GROUP_SERVICE_CODES.includes(service.code) : false;
}

/**
 * The office an appointment of this type defaults to: the video office for video, an office for
 * in-person visits, and for phone calls the video office if one was chosen (telehealth).
 */
export function locationFor(type: LocationType, locations: Location[], currentId: number | null): number | null {
  const active = locations.filter((location) => location.is_active);
  const current = active.find((location) => location.id === currentId);
  if (type === 'in_person') {
    return current && !current.is_video ? current.id : (active.find((location) => !location.is_video)?.id ?? null);
  }
  if (current?.is_video) return current.id;
  return type === 'video' ? (active.find((location) => location.is_video)?.id ?? null) : null;
}

/** Values for a new appointment starting at `startsAt`. */
export function newAppointmentValues(options: {
  startsAt: string;
  timeZone: string;
  clinicianId: number | null;
  client?: { id: number; name: string } | null;
  service?: Service | null;
  kind?: AppointmentKind;
  locationId?: number | null;
}): AppointmentFormValues {
  const { service, client } = options;
  return {
    kind: options.kind ?? 'appointment',
    clinicianId: options.clinicianId,
    participants: client ? [{ clientId: client.id, name: client.name, billable: true }] : [],
    group: isGroupService(service),
    serviceId: service?.id ?? null,
    title: '',
    date: dayKey(options.startsAt, options.timeZone),
    time: timeValue(options.startsAt, options.timeZone),
    duration: String(service?.duration_minutes ?? DEFAULT_DURATION_MINUTES),
    locationType: 'in_person',
    locationId: options.locationId ?? null,
    locationDetails: '',
    fee: '',
    repeat: 'none',
    repeatEnd: 'count',
    occurrences: '10',
    until: '',
    memo: '',
    notifyClient: true,
  };
}

/** Values for editing an existing appointment (the fee stays blank: each client keeps theirs). */
export function valuesFromAppointment(appointment: Appointment, timeZone: string): AppointmentFormValues {
  return {
    kind: appointment.kind,
    clinicianId: appointment.clinician.id,
    participants: appointment.participants.map((participant) => ({
      clientId: participant.client.id,
      name: participant.client.name,
      billable: participant.billable,
    })),
    group: appointment.is_group,
    serviceId: appointment.service_id,
    title: appointment.title,
    date: dayKey(appointment.starts_at, timeZone),
    time: timeValue(appointment.starts_at, timeZone),
    duration: String(appointment.duration_minutes),
    locationType: appointment.location_type,
    locationId: appointment.location?.id ?? null,
    locationDetails: appointment.location_details,
    fee: '',
    repeat: 'none',
    repeatEnd: 'count',
    occurrences: '10',
    until: '',
    memo: appointment.memo,
    notifyClient: false,
  };
}

/** Switching between Appointment and Event keeps the time but resets kind-specific fields. */
export function withKind(values: AppointmentFormValues, kind: AppointmentKind): AppointmentFormValues {
  if (kind === values.kind) return values;
  if (kind === 'event') {
    return { ...values, kind, duration: values.duration || String(DEFAULT_EVENT_MINUTES), notifyClient: false };
  }
  return { ...values, kind, notifyClient: true };
}

/** Bill everyone in a group; otherwise only the identified patient (the billed client, else the first). */
function billing(participants: ParticipantValue[], group: boolean): ParticipantValue[] {
  if (group) return participants.map((participant) => ({ ...participant, billable: true }));
  const billed = participants.find((participant) => participant.billable) ?? participants[0];
  return participants.map((participant) => ({ ...participant, billable: participant === billed }));
}

/** Turn a group session on or off; a couples or family session bills one identified patient. */
export function withGroup(values: AppointmentFormValues, group: boolean): AppointmentFormValues {
  return { ...values, group, participants: billing(values.participants, group) };
}

/** Choosing a service fills its default duration; a group psychotherapy code makes it a group. */
export function withService(values: AppointmentFormValues, service: Service | null): AppointmentFormValues {
  if (!service) return { ...values, serviceId: null };
  const next = { ...values, serviceId: service.id, duration: String(service.duration_minutes) };
  return isGroupService(service) ? withGroup(next, true) : next;
}

/** Add a client (billed in a group, or when they're the first). */
export function addParticipant(values: AppointmentFormValues, client: { id: number; name: string }): AppointmentFormValues {
  if (values.participants.some((participant) => participant.clientId === client.id)) return values;
  const billable = values.group || values.participants.length === 0;
  return { ...values, participants: [...values.participants, { clientId: client.id, name: client.name, billable }] };
}

export function removeParticipant(values: AppointmentFormValues, clientId: number): AppointmentFormValues {
  const remaining = values.participants.filter((participant) => participant.clientId !== clientId);
  return { ...values, participants: billing(remaining, values.group) };
}

/** Make this client the one billed (the identified patient of a couples or family session). */
export function withBilledClient(values: AppointmentFormValues, clientId: number): AppointmentFormValues {
  return {
    ...values,
    participants: values.participants.map((participant) => ({ ...participant, billable: participant.clientId === clientId })),
  };
}

function parseWhole(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

/** The recurrence rule the form describes, or undefined for a one-off. */
export function recurrenceFromValues(values: AppointmentFormValues): RecurrenceInput | undefined {
  if (values.repeat === 'none') return undefined;
  const rule = REPEAT_RULES[values.repeat];
  if (values.repeatEnd === 'until') return { ...rule, until: values.until };
  return { ...rule, count: parseWhole(values.occurrences) ?? 0 };
}

/** Field errors; an empty object means the form can be submitted. */
export function validateValues(values: AppointmentFormValues, mode: 'create' | 'edit'): FormErrors {
  const errors: FormErrors = {};
  if (values.clinicianId === null) errors.clinicianId = 'Choose a clinician';
  if (values.kind === 'appointment') {
    if (values.participants.length === 0) errors.participants = 'Choose a client';
    else if (values.participants.length > MAX_PARTICIPANTS) errors.participants = `Up to ${MAX_PARTICIPANTS} clients`;
    else if (!values.participants.some((participant) => participant.billable)) {
      errors.participants = 'Choose who is billed for the session';
    }
  }
  if (values.kind === 'event' && !values.title.trim()) errors.title = 'Give the event a title';
  if (!isDayKey(values.date)) errors.date = 'Choose a date';
  if (!isTimeValue(values.time)) errors.time = 'Choose a start time';
  const duration = parseWhole(values.duration);
  if (duration === null || duration < 5 || duration > 1440) errors.duration = 'Between 5 and 1440 minutes';
  if (values.kind === 'appointment' && values.fee.trim() !== '' && parseMoneyToCents(values.fee) === null) {
    errors.fee = 'Enter an amount like 150 or 150.00';
  }
  if (values.locationDetails.length > 300) errors.locationDetails = 'Keep this under 300 characters';
  if (mode === 'create' && values.repeat !== 'none') {
    if (values.repeatEnd === 'count') {
      const count = parseWhole(values.occurrences);
      if (count === null || count < 2 || count > MAX_OCCURRENCES) {
        errors.occurrences = `Between 2 and ${MAX_OCCURRENCES} occurrences`;
      }
    } else if (!isDayKey(values.until)) {
      errors.until = 'Choose an end date';
    } else if (isDayKey(values.date) && values.until <= values.date) {
      errors.until = 'End date must be after the first appointment';
    }
  }
  return errors;
}

function feeCents(values: AppointmentFormValues): number | undefined {
  if (values.fee.trim() === '') return undefined;
  return parseMoneyToCents(values.fee) ?? undefined;
}

/** The clients to send: an individual session bills its client; shared sessions say who is billed. */
function participantInputs(values: AppointmentFormValues): ParticipantInput[] {
  if (values.participants.length === 1) return [{ client_id: values.participants[0].clientId }];
  return values.participants.map((participant) => ({ client_id: participant.clientId, billable: participant.billable }));
}

/** Whether the form names the session (only shared sessions and groups have a name). */
function hasSessionName(values: AppointmentFormValues): boolean {
  return values.group || values.participants.length > 1;
}

/** Body for POST /appointments. Call only after validateValues returns no errors. */
export function toCreatePayload(values: AppointmentFormValues, timeZone: string): AppointmentCreate {
  const payload: AppointmentCreate = {
    kind: values.kind,
    starts_at: zonedDateTimeToIso(values.date, values.time, timeZone),
    duration_minutes: Number(values.duration),
    location_type: values.locationType,
    location_details: values.locationDetails.trim(),
    memo: values.memo.trim(),
  };
  if (values.clinicianId !== null) payload.clinician_id = values.clinicianId;
  if (values.locationId !== null) payload.location_id = values.locationId;
  if (values.kind === 'appointment') {
    payload.participants = participantInputs(values);
    if (values.group) payload.group = true;
    payload.service_id = values.serviceId;
    payload.notify_client = values.notifyClient;
    const fee = feeCents(values);
    if (fee !== undefined) payload.fee_cents = fee;
    if (hasSessionName(values) && values.title.trim()) payload.title = values.title.trim();
  } else {
    payload.title = values.title.trim();
  }
  const recurrence = recurrenceFromValues(values);
  if (recurrence) payload.recurrence = recurrence;
  return payload;
}

function participantsChanged(values: AppointmentFormValues, original: Appointment): boolean {
  const before = original.participants.map((participant) => `${participant.client.id}:${participant.billable}`);
  const after = values.participants.map((participant) => `${participant.clientId}:${participant.billable}`);
  return before.length !== after.length || before.some((entry) => !after.includes(entry));
}

/**
 * Body for PATCH /appointments/:id with only what changed. The start time is sent as a new
 * instant; for "this and following" the server shifts each later occurrence by the same
 * wall-clock amount.
 */
export function toUpdatePayload(
  values: AppointmentFormValues,
  original: Appointment,
  timeZone: string,
): AppointmentUpdate {
  const payload: AppointmentUpdate = {};
  const startsAt = zonedDateTimeToIso(values.date, values.time, timeZone);
  if (Date.parse(startsAt) !== Date.parse(original.starts_at)) payload.starts_at = startsAt;
  const duration = Number(values.duration);
  if (duration !== original.duration_minutes) payload.duration_minutes = duration;
  if (values.clinicianId !== null && values.clinicianId !== original.clinician.id) payload.clinician_id = values.clinicianId;
  if (values.locationType !== original.location_type) payload.location_type = values.locationType;
  if (values.locationId !== (original.location?.id ?? null)) payload.location_id = values.locationId;
  if (values.locationDetails.trim() !== original.location_details) payload.location_details = values.locationDetails.trim();
  if (values.memo.trim() !== original.memo) payload.memo = values.memo.trim();
  if (values.title.trim() !== original.title && (original.kind === 'event' || hasSessionName(values))) {
    payload.title = values.title.trim();
  }
  if (original.kind === 'appointment') {
    if (values.serviceId !== original.service_id) payload.service_id = values.serviceId;
    const fee = feeCents(values);
    if (fee !== undefined) payload.fee_cents = fee;
    if (participantsChanged(values, original)) payload.participants = participantInputs(values);
    if (values.notifyClient) payload.notify_client = true;
  }
  return payload;
}

/** Whether an update payload changes anything besides flags. */
export function hasChanges(payload: AppointmentUpdate): boolean {
  return Object.keys(payload).some((key) => key !== 'notify_client' && key !== 'allow_conflicts');
}
