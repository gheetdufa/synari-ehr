import { Link } from 'react-router-dom';
import { CalendarDays, CalendarPlus, MapPin, Phone, Users, Video } from 'lucide-react';
import { LOCATION_LABELS } from '../../api/appointments';
import type { PortalAppointment } from '../../api/booking';
import { formatDate, formatTime } from '../../lib/format';
import { LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useNow } from '../../portal/dashboard/useNow';
import { JoinVideoButton } from '../appointments/JoinVideoButton';
import { sessionLabel } from '../appointments/sessionLabels';
import { canJoinVideo, nextAppointment } from './homeHelpers';

const LOCATION_ICONS = { video: Video, in_person: MapPin, phone: Phone } as const;

function zoneAbbreviation(iso: string, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(iso))
    .find((item) => item.type === 'timeZoneName');
  return part?.value ?? '';
}

function AppointmentDetails({
  appointment,
  timeZone,
  moreCount,
}: {
  appointment: PortalAppointment;
  timeZone: string;
  moreCount: number;
}) {
  const now = useNow();
  const LocationIcon = LOCATION_ICONS[appointment.location_type];
  const joinable = canJoinVideo(appointment, now);
  const requested = appointment.status === 'requested';
  const shared = sessionLabel(appointment);

  return (
    <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
      <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-primary-50 text-primary-800">
        <span className="text-xs font-semibold uppercase">{formatDate(appointment.starts_at, timeZone, { month: 'short', day: undefined, year: undefined })}</span>
        <span className="text-2xl font-semibold leading-none">{formatDate(appointment.starts_at, timeZone, { month: undefined, day: 'numeric', year: undefined })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-lg font-semibold text-sage-900">
            {formatDate(appointment.starts_at, timeZone, { weekday: 'long', month: 'long', year: undefined })}
          </p>
          {requested && <Badge tone="warning">Waiting for confirmation</Badge>}
        </div>
        <p className="text-sage-700">
          {formatTime(appointment.starts_at, timeZone)} – {formatTime(appointment.ends_at, timeZone)}{' '}
          <span className="text-sm text-sage-500">{zoneAbbreviation(appointment.starts_at, timeZone)}</span>
        </p>
        <ul className="mt-2 space-y-1 text-sm text-sage-600">
          <li>
            {appointment.service_description ? `${appointment.service_description} with ` : 'With '}
            {appointment.clinician_name}
            {appointment.other_participants.length > 0 && `, together with ${appointment.other_participants.join(' and ')}`}
            {appointment.is_group && ' (group session)'}
          </li>
          {shared && (
            <li className="flex items-center gap-1.5">
              <Users className="h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
              {shared}
            </li>
          )}
          <li className="flex items-start gap-1.5">
            <LocationIcon className="mt-0.5 h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
            <span>
              {LOCATION_LABELS[appointment.location_type]}
              {appointment.location_details && (
                <span className="block whitespace-pre-line text-sage-500">{appointment.location_details}</span>
              )}
            </span>
          </li>
        </ul>
        {appointment.has_video && appointment.status === 'scheduled' && !joinable && (
          <p className="mt-2 text-xs text-sage-500">The Join button appears here an hour before your appointment.</p>
        )}
        {moreCount > 0 && (
          <Link to="/client/appointments" className="mt-2 inline-block text-sm font-medium text-primary-700 hover:underline">
            {moreCount} more upcoming {moreCount === 1 ? 'appointment' : 'appointments'}
          </Link>
        )}
      </div>
      {joinable && (
        <div className="sm:shrink-0">
          <JoinVideoButton appointmentId={appointment.id} />
        </div>
      )}
    </div>
  );
}

/** The client's next appointment, with a Join button for video visits when it's time. */
export function NextAppointmentCard({
  upcoming,
  isPending,
  error,
  onRetry,
  timeZone,
  canBook,
  clinicianName,
}: {
  upcoming: PortalAppointment[] | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  timeZone: string;
  canBook: boolean;
  clinicianName: string;
}) {
  const next = upcoming ? nextAppointment(upcoming) : null;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-sage-100 px-5 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-sage-500">Next appointment</h2>
        <Link to="/client/appointments" className="text-sm font-medium text-primary-700 hover:underline">
          All appointments
        </Link>
      </div>
      {isPending && <SectionSpinner />}
      {Boolean(error) && <ErrorState error={error} onRetry={onRetry} />}
      {upcoming && next && (
        <AppointmentDetails appointment={next} timeZone={timeZone} moreCount={upcoming.length - 1} />
      )}
      {upcoming && !next && (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <CalendarDays className="mb-3 h-10 w-10 text-sage-300" aria-hidden="true" />
          <p className="font-semibold text-sage-900">No upcoming appointments</p>
          <p className="mt-1 max-w-sm text-sm text-sage-600">
            {canBook
              ? `Request a time that works for you and ${clinicianName} will confirm it.`
              : `${clinicianName} will schedule the next appointment with you.`}
          </p>
          {canBook && (
            <LinkButton to="/client/appointments/book" size="sm" className="mt-4" icon={<CalendarPlus className="h-4 w-4" />}>
              Request an appointment
            </LinkButton>
          )}
        </div>
      )}
    </Card>
  );
}
