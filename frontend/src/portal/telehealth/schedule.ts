import { TZDate } from '@date-fns/tz';
import { addDays, startOfDay } from 'date-fns';
import type { Appointment, AppointmentStatus } from '../../api/appointments';

/** Today plus the next seven days. */
export const SCHEDULE_DAYS = 8;

const CANCELED: ReadonlySet<AppointmentStatus> = new Set(['canceled', 'late_canceled', 'declined']);

/** From the start of today in the practice's time zone to the end of the seventh day after it. */
export function scheduleRange(timeZone: string, now: number = Date.now()): { start: string; end: string } {
  const today = startOfDay(TZDate.tz(timeZone, now));
  return { start: today.toISOString(), end: addDays(today, SCHEDULE_DAYS).toISOString() };
}

/** "2026-10-05" for a moment, in the given time zone. */
export function dayKey(moment: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(moment),
  );
}

/**
 * Video appointments that can still happen, soonest first: one clinician's (`clinicianId`), or
 * everyone's with null. Appointments whose clients you can't see are left out.
 */
export function videoAppointments(appointments: Appointment[], clinicianId: number | null): Appointment[] {
  return appointments
    .filter(
      (appointment) =>
        appointment.kind === 'appointment' &&
        appointment.has_video &&
        !appointment.restricted &&
        !CANCELED.has(appointment.status) &&
        (clinicianId === null || appointment.clinician.id === clinicianId),
    )
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export interface DayGroup {
  key: string;
  label: string;
  isToday: boolean;
  appointments: Appointment[];
}

/** Group appointments by local day: "Today", "Tomorrow", then "Wednesday, Sep 30". */
export function groupByDay(appointments: Appointment[], timeZone: string, now: number = Date.now()): DayGroup[] {
  const today = dayKey(now, timeZone);
  const tomorrow = dayKey(addDays(TZDate.tz(timeZone, now), 1).getTime(), timeZone);
  const groups = new Map<string, DayGroup>();
  for (const appointment of appointments) {
    const key = dayKey(appointment.starts_at, timeZone);
    let group = groups.get(key);
    if (!group) {
      const label =
        key === today
          ? 'Today'
          : key === tomorrow
            ? 'Tomorrow'
            : new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(
                new Date(appointment.starts_at),
              );
      group = { key, label, isToday: key === today, appointments: [] };
      groups.set(key, group);
    }
    group.appointments.push(appointment);
  }
  return [...groups.values()];
}
