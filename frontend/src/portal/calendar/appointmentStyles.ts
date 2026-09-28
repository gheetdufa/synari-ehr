import { STATUS_LABELS, type Appointment, type AppointmentStatus } from '../../api/appointments';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** Statuses that no longer occupy the calendar; drawn subdued and hidden by "Show canceled". */
export const INACTIVE_STATUSES: AppointmentStatus[] = ['canceled', 'declined'];

/** Statuses staff can switch a session between from the details view. */
export const OUTCOME_STATUSES = ['scheduled', 'attended', 'no_show', 'late_canceled'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export function isInactive(appointment: Pick<Appointment, 'status'>): boolean {
  return INACTIVE_STATUSES.includes(appointment.status);
}

/** Whether the appointment still holds its time (can be edited, canceled, joined). */
export function isActive(appointment: Pick<Appointment, 'status'>): boolean {
  return appointment.status === 'scheduled' || appointment.status === 'attended' || appointment.status === 'requested';
}

export function statusLabel(status: AppointmentStatus): string {
  return status === 'requested' ? 'Pending request' : STATUS_LABELS[status];
}

export function statusTone(status: AppointmentStatus): BadgeTone {
  switch (status) {
    case 'requested':
      return 'info';
    case 'scheduled':
      return 'primary';
    case 'attended':
      return 'success';
    case 'no_show':
      return 'warning';
    case 'late_canceled':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** What a calendar entry is called: the client's name, "A & B", a group's name, an event's
 * title, or "Busy" for a colleague's appointment you can't see. */
export function entryTitle(appointment: Appointment): string {
  return appointment.title_label || (appointment.kind === 'event' ? 'Event' : 'Appointment');
}

export type SessionType = 'individual' | 'shared' | 'group';

/** Individual session, couples or family session (several clients, one billed), or group. */
export function sessionType(appointment: Pick<Appointment, 'is_group' | 'participants'>): SessionType {
  if (appointment.is_group) return 'group';
  return appointment.participants.length > 1 ? 'shared' : 'individual';
}

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  individual: 'Individual',
  shared: 'Couple/family',
  group: 'Group',
};

const BUSY = 'border-l-4 border-sage-400 bg-sage-100 text-sage-700';

const HATCHED =
  'border-2 border-dashed border-primary-500 text-primary-900 bg-[repeating-linear-gradient(135deg,#f0fdfa_0px,#f0fdfa_6px,#ffffff_6px,#ffffff_12px)]';

/** Colors for a block on the time grid or a chip in the month view. */
export function blockClasses(appointment: Appointment): string {
  if (appointment.restricted) return BUSY;
  if (isInactive(appointment)) return 'border-l-4 border-sage-300 bg-sage-50 text-sage-500 line-through opacity-80';
  if (appointment.kind === 'event') return 'border-l-4 border-violet-400 bg-violet-50 text-violet-900';
  switch (appointment.status) {
    case 'requested':
      return HATCHED;
    case 'attended':
      return 'border-l-4 border-emerald-600 bg-emerald-50 text-emerald-900';
    case 'no_show':
      return 'border-l-4 border-amber-500 bg-amber-50 text-amber-900';
    case 'late_canceled':
      return 'border-l-4 border-red-400 bg-red-50 text-red-800';
    default:
      return 'border-l-4 border-primary-600 bg-primary-100 text-primary-900';
  }
}

/** The session room opens this long before the start and stays open this long after the end. */
export const JOIN_EARLY_MINUTES = 60;
export const JOIN_LATE_MINUTES = 60;

export type VideoJoinState = 'none' | 'early' | 'open' | 'ended';

/** Whether the appointment's clinician can start its video session right now. */
export function videoJoinState(appointment: Appointment, now: Date): VideoJoinState {
  if (!appointment.has_video || appointment.kind !== 'appointment' || appointment.restricted) return 'none';
  if (appointment.status !== 'scheduled' && appointment.status !== 'attended') return 'none';
  const opens = Date.parse(appointment.starts_at) - JOIN_EARLY_MINUTES * 60_000;
  const closes = Date.parse(appointment.ends_at) + JOIN_LATE_MINUTES * 60_000;
  if (now.getTime() < opens) return 'early';
  if (now.getTime() > closes) return 'ended';
  return 'open';
}

/** A small solid swatch matching the block color (agenda rows, phone month dots, legend). */
export function swatchClass(appointment: Appointment): string {
  if (appointment.restricted) return 'bg-sage-400';
  if (isInactive(appointment)) return 'bg-sage-300';
  if (appointment.kind === 'event') return 'bg-violet-400';
  switch (appointment.status) {
    case 'requested':
      return 'bg-white ring-2 ring-inset ring-primary-500';
    case 'attended':
      return 'bg-emerald-600';
    case 'no_show':
      return 'bg-amber-500';
    case 'late_canceled':
      return 'bg-red-400';
    default:
      return 'bg-primary-600';
  }
}
