import { Link } from 'react-router-dom';
import { CalendarDays, MapPin, Phone, Users, Video } from 'lucide-react';
import { LOCATION_LABELS, STATUS_LABELS, type LocationType } from '../../api/appointments';
import type { DashboardScope, TodayAppointment } from '../../api/dashboard';
import { formatTime } from '../../lib/format';
import { LinkButton } from '../../ui/Button';
import { Badge, EmptyState } from '../../ui/Display';
import {
  APPOINTMENT_STATUS_TONES,
  hasEnded,
  isInProgress,
  participantNames,
  sessionOpensAt,
  sessionTiming,
} from './dashboardHelpers';

const LOCATION_ICONS: Record<LocationType, typeof Video> = {
  video: Video,
  in_person: MapPin,
  phone: Phone,
};

function TodayRow({
  appointment,
  timeZone,
  now,
  staffId,
  showClinician,
}: {
  appointment: TodayAppointment;
  timeZone: string;
  now: Date;
  staffId: number;
  showClinician: boolean;
}) {
  const LocationIcon = LOCATION_ICONS[appointment.location_type];
  const mine = appointment.clinician.id === staffId;
  const timing = mine ? sessionTiming(appointment, now) : 'none';
  const current = isInProgress(appointment, now);
  const ended = hasEnded(appointment, now);
  const isEvent = appointment.kind === 'event';
  const name = appointment.title_label || (isEvent ? 'Untitled event' : 'Session');
  const members = participantNames(appointment);
  const details = [
    showClinician ? appointment.clinician.name : '',
    !isEvent && !appointment.restricted ? appointment.service_description : '',
  ].filter(Boolean);

  return (
    <li
      className={`relative flex flex-wrap items-center gap-3 px-5 py-3 transition-colors hover:bg-sage-50 sm:flex-nowrap ${
        ended && !current ? 'opacity-70' : ''
      }`}
    >
      {current && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-1 rounded-r bg-primary-500" />}
      <Link
        to="/portal/calendar"
        className="flex min-w-0 flex-1 items-start gap-4 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        aria-label={`${formatTime(appointment.starts_at, timeZone)} ${name}${showClinician ? ` with ${appointment.clinician.name}` : ''}, open calendar`}
      >
        <div className="w-20 shrink-0 pt-0.5">
          <p className="text-sm font-semibold text-sage-900">{formatTime(appointment.starts_at, timeZone)}</p>
          <p className="text-xs text-sage-500">{appointment.duration_minutes} min</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sage-900">
            {name}
            {current && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-primary-700">Now</span>}
          </p>
          {members && (
            <p className="flex items-center gap-1 truncate text-sm text-sage-600">
              <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{members}</span>
            </p>
          )}
          {details.length > 0 && <p className="truncate text-sm text-sage-600">{details.join(' · ')}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {isEvent ? (
              <Badge>Event</Badge>
            ) : (
              <>
                <Badge tone={appointment.location_type === 'video' ? 'info' : 'neutral'}>
                  <LocationIcon className="h-3 w-3" aria-hidden="true" />
                  {LOCATION_LABELS[appointment.location_type]}
                </Badge>
                <Badge tone={APPOINTMENT_STATUS_TONES[appointment.status]}>{STATUS_LABELS[appointment.status]}</Badge>
              </>
            )}
            {timing === 'upcoming' && (
              <span className="text-xs text-sage-500">Room opens {formatTime(sessionOpensAt(appointment), timeZone)}</span>
            )}
          </div>
        </div>
      </Link>
      {timing === 'open' && (
        <LinkButton
          to={`/session/${appointment.id}`}
          size="sm"
          icon={<Video className="h-4 w-4" />}
          className="ml-24 sm:ml-0"
          aria-label={`Start session with ${name}`}
        >
          Start session
        </LinkButton>
      )}
    </li>
  );
}

/**
 * Today's appointments and events. On the practice schedule each entry names its clinician, and
 * only your own video sessions can be started from here.
 */
export function TodaySchedule({
  appointments,
  timeZone,
  now,
  staffId,
  scope,
}: {
  appointments: TodayAppointment[];
  timeZone: string;
  now: Date;
  staffId: number;
  scope: DashboardScope;
}) {
  if (appointments.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays />}
        title={scope === 'practice' ? 'Nothing on the practice calendar today' : 'Nothing on your calendar today'}
        description={
          scope === 'practice' ? 'No one has appointments scheduled today.' : 'Enjoy the breathing room, or schedule something new.'
        }
        action={
          <LinkButton to="/portal/calendar" variant="secondary" size="sm">
            Open calendar
          </LinkButton>
        }
      />
    );
  }
  return (
    <ul className="divide-y divide-sage-100" aria-label="Today's schedule">
      {appointments.map((appointment) => (
        <TodayRow
          key={appointment.id}
          appointment={appointment}
          timeZone={timeZone}
          now={now}
          staffId={staffId}
          showClinician={scope === 'practice'}
        />
      ))}
    </ul>
  );
}
