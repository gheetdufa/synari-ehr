import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { appointmentKeys, appointmentsApi, STATUS_LABELS, type Appointment } from '../../api/appointments';
import { noteKeys, notesApi, type NoteFormat } from '../../api/notes';
import { teamApi, teamKeys, type TeamMember } from '../../api/team';
import { useSession } from '../../auth/StaffAuth';
import { formatDateTime } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Appointments offered when linking a note: the last 30 days and the next 7. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 7;

/** Refresh note lists when the worker turns a session recording into a draft note. */
export function useNotesRealtime(): void {
  const queryClient = useQueryClient();
  useRealtimeEvent('recording.processed', () => {
    void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
    void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
  });
}

/** The note formats (they never change while the app runs). */
export function useNoteFormats() {
  return useQuery({ queryKey: noteKeys.formats, queryFn: notesApi.formats, staleTime: Infinity });
}

export function findFormat(formats: NoteFormat[] | undefined, id: string): NoteFormat | undefined {
  return formats?.find((format) => format.id === id);
}

function appointmentWindow(): { start: string; end: string } {
  // Rounded to the hour so every picker opened within the hour shares one cached query.
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return {
    start: new Date(hour - PAST_DAYS * DAY_MS).toISOString(),
    end: new Date(hour + (FUTURE_DAYS + 1) * DAY_MS).toISOString(),
  };
}

/**
 * A client's appointments from the last 30 days and the next 7, newest first, plus `includeId`
 * (an appointment already linked to a note) when it falls outside that window.
 */
export function useClientAppointments(clientId: number | null, includeId: number | null = null) {
  const [range] = useState(appointmentWindow);
  const query = useQuery({
    queryKey: appointmentKeys.range(range.start, range.end, clientId ?? undefined),
    queryFn: () =>
      appointmentsApi.list({ start: range.start, end: range.end, client_id: clientId!, include_canceled: false }),
    enabled: clientId !== null,
  });
  const recent = (query.data ?? []).filter((appointment) => appointment.kind === 'appointment');
  const missing = includeId !== null && query.isSuccess && !recent.some((appointment) => appointment.id === includeId);
  const linked = useQuery({
    queryKey: appointmentKeys.detail(includeId ?? 0),
    queryFn: () => appointmentsApi.get(includeId!),
    enabled: missing,
  });
  const appointments = [...recent, ...(missing && linked.data ? [linked.data] : [])].sort((a, b) =>
    b.starts_at.localeCompare(a.starts_at),
  );
  return {
    appointments,
    isLoading: clientId !== null && (query.isLoading || (missing && linked.isLoading)),
    error: query.error,
  };
}

/** "Tue, Oct 5, 2:00 PM · Psychotherapy, 53 min (Attended)", plus "· 3 clients" for multi-client sessions. */
export function appointmentLabel(appointment: Appointment, timeZone: string): string {
  const service = appointment.service_description || appointment.service_code || appointment.title;
  const status = appointment.status === 'scheduled' ? '' : ` (${STATUS_LABELS[appointment.status]})`;
  const clients = appointment.participants.length > 1 ? ` · ${appointment.participants.length} clients` : '';
  return `${formatDateTime(appointment.starts_at, timeZone)}${service ? ` · ${service}` : ''}${clients}${status}`;
}

/** Everyone in the practice (names and supervision), shared with the team settings screen. */
export function useTeam() {
  return useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list, staleTime: 5 * 60_000 });
}

export interface Supervision {
  /** Active clinicians the signed-in staff member supervises. */
  supervisees: TeamMember[];
  /** The signed-in staff member's own supervisor while they're active, if any. */
  supervisor: TeamMember | undefined;
}

/** Who the signed-in staff member supervises, and who supervises them. */
export function useSupervision(): Supervision {
  const { staff } = useSession();
  const team = useTeam().data ?? [];
  const active = team.filter((member) => member.status === 'active');
  return {
    supervisees: active.filter((member) => member.supervisor_id === staff.id),
    supervisor: active.find((member) => member.id === staff.supervisor_id),
  };
}
