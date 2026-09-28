import type { AppointmentStatus } from '../../api/appointments';
import type { DashboardSummary, TodayAppointment } from '../../api/dashboard';

const MINUTE = 60_000;
/** The session room opens this long before the start and stays open this long after the end. */
export const HOST_EARLY_MINUTES = 60;
export const HOST_LATE_MINUTES = 60;

/** The parts of an appointment that decide when its video session can start. */
type SessionTimes = Pick<TodayAppointment, 'kind' | 'has_video' | 'status' | 'starts_at' | 'ends_at'>;

/** "Good morning" / "Good afternoon" / "Good evening" for the local hour in `timeZone`. */
export function greetingFor(now: Date, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export type SessionTiming = 'none' | 'upcoming' | 'open' | 'closed';

/** Whether a video session for this appointment can be started now, will open later, or is over. */
export function sessionTiming(appointment: SessionTimes, now: Date): SessionTiming {
  if (appointment.kind !== 'appointment' || !appointment.has_video || appointment.status !== 'scheduled') {
    return 'none';
  }
  const opens = new Date(appointment.starts_at).getTime() - HOST_EARLY_MINUTES * MINUTE;
  const closes = new Date(appointment.ends_at).getTime() + HOST_LATE_MINUTES * MINUTE;
  if (now.getTime() < opens) return 'upcoming';
  if (now.getTime() > closes) return 'closed';
  return 'open';
}

/** When the session room opens (an hour before the start). */
export function sessionOpensAt(appointment: Pick<TodayAppointment, 'starts_at'>): string {
  return new Date(new Date(appointment.starts_at).getTime() - HOST_EARLY_MINUTES * MINUTE).toISOString();
}

export function isInProgress(appointment: Pick<TodayAppointment, 'starts_at' | 'ends_at'>, now: Date): boolean {
  const time = now.getTime();
  return new Date(appointment.starts_at).getTime() <= time && time < new Date(appointment.ends_at).getTime();
}

export function hasEnded(appointment: Pick<TodayAppointment, 'ends_at'>, now: Date): boolean {
  return new Date(appointment.ends_at).getTime() <= now.getTime();
}

/**
 * Who is in a session, when the title doesn't already say: a group's members or the clients of a
 * couples or family session titled by its purpose. Empty for one client, events and busy time.
 */
export function participantNames(appointment: Pick<TodayAppointment, 'title_label' | 'participants'>): string {
  const names = appointment.participants.map((participant) => participant.client.name);
  if (names.length < 2 || appointment.title_label.includes(names[0])) return '';
  if (names.length > 3) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return names.join(', ');
}

export const APPOINTMENT_STATUS_TONES: Record<
  AppointmentStatus,
  'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
> = {
  requested: 'warning',
  scheduled: 'primary',
  attended: 'success',
  no_show: 'danger',
  late_canceled: 'warning',
  canceled: 'neutral',
  declined: 'neutral',
};

export type AttentionTone = 'default' | 'urgent' | 'live';

export interface AttentionItem {
  id: string;
  label: string;
  hint: string;
  count: number;
  to: string;
  tone: AttentionTone;
}

/** Which kinds of work the signed-in person does, so the list skips counters that can't apply. */
export interface AttentionRole {
  /** Opens clinical records: messages, notes and form results. */
  clinical: boolean;
  /** Holds their own sessions and writes notes (a clinician). */
  clinician: boolean;
  /** Answers appointment requests: for their own calendar, or everyone's (`schedule_all`). */
  schedules: boolean;
}

/** The "needs your attention" counters, each linking to where that work gets done. */
export function attentionItems(summary: DashboardSummary, role: AttentionRole): AttentionItem[] {
  const items: [show: boolean, item: AttentionItem][] = [
    [
      role.clinician,
      {
        id: 'waiting-room',
        label: 'In the waiting room',
        hint: 'Clients waiting to be admitted',
        count: summary.waiting_room,
        to: '/portal/telehealth',
        tone: summary.waiting_room > 0 ? 'live' : 'default',
      },
    ],
    [
      role.clinical,
      {
        id: 'flagged-forms',
        label: 'Flagged responses',
        hint: 'Completed forms with answers to review',
        count: summary.flagged_forms,
        to: '/portal/forms',
        tone: summary.flagged_forms > 0 ? 'urgent' : 'default',
      },
    ],
    [
      role.schedules,
      {
        id: 'requests',
        label: 'Appointment requests',
        hint: 'Waiting to be accepted or declined',
        count: summary.pending_requests,
        to: '/portal/calendar?requests=1',
        tone: 'default',
      },
    ],
    [
      role.clinical,
      {
        id: 'messages',
        label: 'Unread messages',
        hint: 'From clients',
        count: summary.unread_messages,
        to: '/portal/messaging',
        tone: 'default',
      },
    ],
    [
      role.clinician,
      {
        id: 'missing-notes',
        label: 'Appointments missing notes',
        hint: 'Attended in the last 30 days',
        count: summary.appointments_missing_notes,
        to: '/portal/notes',
        tone: 'default',
      },
    ],
    [
      role.clinician,
      {
        id: 'draft-notes',
        label: 'Draft notes',
        hint: 'Started but not signed',
        count: summary.draft_notes,
        to: '/portal/notes',
        tone: 'default',
      },
    ],
    [
      true,
      {
        id: 'pending-forms',
        label: 'Forms awaiting clients',
        hint: 'Shared but not completed yet',
        count: summary.pending_forms,
        to: '/portal/forms',
        tone: 'default',
      },
    ],
  ];
  return items.filter(([show]) => show).map(([, item]) => item);
}
