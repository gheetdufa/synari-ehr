import type { PortalAppointment } from '../../api/booking';
import type { PortalFormSummary } from '../../api/portalHome';

const MINUTE = 60_000;
/** Clients can join from an hour before the start until the link expires 30 minutes after the end. */
export const JOIN_EARLY_MINUTES = 60;
export const JOIN_GRACE_MINUTES = 30;

export function canJoinVideo(appointment: PortalAppointment, now: Date): boolean {
  if (!appointment.has_video || appointment.status !== 'scheduled') return false;
  const opens = new Date(appointment.starts_at).getTime() - JOIN_EARLY_MINUTES * MINUTE;
  const closes = new Date(appointment.ends_at).getTime() + JOIN_GRACE_MINUTES * MINUTE;
  return now.getTime() >= opens && now.getTime() <= closes;
}

/** The soonest confirmed appointment, or the soonest pending request when nothing is confirmed. */
export function nextAppointment(upcoming: PortalAppointment[]): PortalAppointment | null {
  const sorted = [...upcoming].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return sorted.find((item) => item.status === 'scheduled') ?? sorted.find((item) => item.status === 'requested') ?? null;
}

export function pendingFormCount(forms: PortalFormSummary[]): number {
  return forms.filter((form) => form.status === 'pending').length;
}
