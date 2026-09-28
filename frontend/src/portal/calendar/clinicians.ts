/** Clinicians on the practice calendar: who is shown, their colors, and whose calendars you manage. */
import { useQuery } from '@tanstack/react-query';
import type { Session } from '../../api/auth';
import { teamApi, teamKeys, type TeamMember } from '../../api/team';

/** Swatch colors that tell clinicians apart when several calendars are shown together. */
export const CLINICIAN_COLORS = [
  'bg-teal-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-sky-500',
  'bg-rose-500',
  'bg-emerald-600',
  'bg-orange-500',
  'bg-indigo-500',
  'bg-lime-600',
  'bg-fuchsia-500',
  'bg-cyan-700',
  'bg-stone-500',
] as const;

export interface CalendarClinician {
  id: number;
  /** Name with credentials. */
  name: string;
  /** A CLINICIAN_COLORS class. */
  color: string;
}

/** Each shown clinician's color, by staff id, when several calendars are shown together. */
export type ClinicianColors = ReadonlyMap<number, string>;

/** Everyone's calendar, or only these clinicians'. */
export type ClinicianSelection = 'all' | number[];

/**
 * Active clinicians in the team's order, each with a color. Colors follow the order people joined
 * (by id), so a clinician keeps their color when someone new joins.
 */
export function calendarClinicians(team: TeamMember[]): CalendarClinician[] {
  const clinicians = team.filter((member) => member.is_clinician && member.status === 'active');
  const byJoinOrder = [...clinicians].sort((a, b) => a.id - b.id).map((member) => member.id);
  return clinicians.map((member) => ({
    id: member.id,
    name: member.display_name,
    color: CLINICIAN_COLORS[byJoinOrder.indexOf(member.id) % CLINICIAN_COLORS.length],
  }));
}

/** The team's active clinicians for pickers and the calendar filter (a stable list between renders). */
export function useClinicians() {
  const query = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list, staleTime: 5 * 60_000, select: calendarClinicians });
  return { ...query, clinicians: query.data };
}

/** Whether this person may book, change or cancel on `clinicianId`'s calendar. */
export function canManageCalendar(session: Session, clinicianId: number): boolean {
  return clinicianId === session.staff.id || session.capabilities.includes('schedule_all');
}

/** Whether this person may add anything to any calendar (their own as a clinician, or everyone's). */
export function canSchedule(session: Session): boolean {
  return session.staff.is_clinician || session.capabilities.includes('schedule_all');
}

/** Clinicians see their own calendar first; everyone else starts with the whole practice. */
export function defaultSelection(session: Session): ClinicianSelection {
  return session.staff.is_clinician ? [session.staff.id] : 'all';
}

function storageKey(staffId: number): string {
  return `synari.calendar.clinicians.${staffId}`;
}

function isSelection(value: unknown): value is ClinicianSelection {
  return value === 'all' || (Array.isArray(value) && value.every((item) => Number.isInteger(item)));
}

/** The calendar filter this person last used on this browser, else their default. */
export function readSelection(session: Session): ClinicianSelection {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(session.staff.id)) ?? 'null');
    if (isSelection(stored) && (stored === 'all' || stored.length > 0)) return stored;
  } catch {
    // Unreadable or unavailable storage: fall back to the default.
  }
  return defaultSelection(session);
}

export function saveSelection(staffId: number, selection: ClinicianSelection): void {
  try {
    localStorage.setItem(storageKey(staffId), JSON.stringify(selection));
  } catch {
    // The filter just won't persist (private browsing).
  }
}

/**
 * The selection limited to current clinicians; one that no longer matches anyone falls back to
 * the default. Unchanged until the clinicians have loaded.
 */
export function effectiveSelection(
  selection: ClinicianSelection,
  clinicians: CalendarClinician[] | undefined,
  session: Session,
): ClinicianSelection {
  if (selection === 'all' || !clinicians) return selection;
  const known = selection.filter((id) => clinicians.some((clinician) => clinician.id === id));
  if (known.length > 0) return known;
  const fallback = defaultSelection(session);
  return fallback === 'all' || clinicians.some((clinician) => clinician.id === session.staff.id) ? fallback : 'all';
}

/** The clinicians a selection shows. */
export function selectedClinicians(selection: ClinicianSelection, clinicians: CalendarClinician[]): CalendarClinician[] {
  return selection === 'all' ? clinicians : clinicians.filter((clinician) => selection.includes(clinician.id));
}
