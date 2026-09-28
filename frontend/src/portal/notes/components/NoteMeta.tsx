import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarDays, User, Users } from 'lucide-react';
import { appointmentKeys, appointmentsApi } from '../../../api/appointments';
import type { ClientRef } from '../../../api/clients';
import type { NoteSummary } from '../../../api/notes';
import { formatDateTime, fullName } from '../../../lib/format';

/** Client link and linked session shown under a note's title. */
export function NoteMeta({
  client,
  appointmentId,
  timeZone,
  children,
}: {
  client: ClientRef;
  appointmentId: number | null;
  timeZone: string;
  children?: ReactNode;
}) {
  const appointment = useQuery({
    queryKey: appointmentKeys.detail(appointmentId ?? 0),
    queryFn: () => appointmentsApi.get(appointmentId!),
    enabled: appointmentId !== null,
  });
  const service = appointment.data ? appointment.data.service_description || appointment.data.service_code : '';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-sage-600">
      <Link
        to={`/portal/clients/${client.id}`}
        className="inline-flex items-center gap-1.5 font-medium text-primary-700 hover:text-primary-900 hover:underline"
      >
        <User className="h-4 w-4" aria-hidden="true" />
        {fullName(client)}
      </Link>
      {appointmentId !== null && (
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {appointment.data
            ? `${formatDateTime(appointment.data.starts_at, timeZone)}${service ? ` · ${service}` : ''}`
            : appointment.isError
              ? 'Linked appointment'
              : 'Loading session…'}
        </span>
      )}
      {children}
    </div>
  );
}

/** For a note from a couples, family or group session: a link to every note from that session. */
export function SessionNotesLink({ note }: { note: NoteSummary }) {
  if (note.appointment_id === null || note.appointment_participant_count < 2) return null;
  return (
    <Link
      to={`/portal/notes?session=${note.appointment_id}`}
      className="inline-flex items-center gap-1.5 font-medium text-primary-700 hover:text-primary-900 hover:underline"
    >
      <Users className="h-4 w-4" aria-hidden="true" />
      Session notes ({note.appointment_participant_count} clients)
    </Link>
  );
}

/** Safety concerns the AI noticed in the session material, shown prominently for review. */
export function RiskFlagsAlert({ flags, title = 'AI noticed possible safety concerns — review' }: { flags: string[]; title?: string }) {
  if (flags.length === 0) return null;
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
        {title}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        {flags.map((flag) => (
          <li key={flag}>{flag}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-red-800">
        These are automated observations, not a risk assessment. Use your clinical judgment and document any assessment
        you make.
      </p>
    </div>
  );
}
