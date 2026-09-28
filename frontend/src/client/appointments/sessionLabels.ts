import type { PortalAppointment } from '../../api/booking';

type SessionShape = Pick<PortalAppointment, 'is_group' | 'other_participants'>;

/** "Sam", "Sam & Jo" or "Sam, Jo & Ali". */
export function joinNames(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Whether the client shares this session with others (a group, couples or family session). */
export function isSharedSession(appointment: SessionShape): boolean {
  return appointment.is_group || appointment.other_participants.length > 0;
}

/** "Group session", "Joint session with Sam & Jo", or null for an individual session. */
export function sessionLabel(appointment: SessionShape): string | null {
  if (appointment.is_group) return 'Group session';
  if (appointment.other_participants.length > 0) return `Joint session with ${joinNames(appointment.other_participants)}`;
  return null;
}
