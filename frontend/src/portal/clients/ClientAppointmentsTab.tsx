import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Repeat, Users } from 'lucide-react';
import { appointmentKeys, appointmentsApi, type Appointment, type AppointmentStatus } from '../../api/appointments';
import { useSession } from '../../auth/StaffAuth';
import { formatDate, formatMoney } from '../../lib/format';
import { Button, LinkButton } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { SESSION_TYPE_LABELS, isInactive, sessionType, statusLabel, statusTone } from '../calendar/appointmentStyles';
import { LocationIcon } from '../calendar/CalendarParts';
import { useCalendarRealtime } from '../calendar/calendarHooks';
import { formatTimeRange } from '../calendar/calendarMath';
import { canSchedule } from '../calendar/clinicians';
import { useAppointmentDialogs } from '../calendar/useAppointmentDialogs';

/** Each request covers one year; the API caps a list at 400 days, so past and future are fetched separately. */
const WINDOW_DAYS = 365;
const PAST_PREVIEW = 10;
const DAY_MS = 86_400_000;

/** This client's own status in an appointment (their attendance in a shared session). */
function clientStatus(appointment: Appointment, clientId: number): AppointmentStatus {
  return appointment.participants.find((participant) => participant.client.id === clientId)?.effective_status ?? appointment.status;
}

interface Windows {
  pastStart: string;
  today: string;
  futureEnd: string;
}

/** A year back and a year ahead of today, fixed for the life of the tab so query keys stay stable. */
function useWindows(): Windows {
  const [windows] = useState(() => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return {
      pastStart: new Date(today.getTime() - WINDOW_DAYS * DAY_MS).toISOString(),
      today: today.toISOString(),
      futureEnd: new Date(today.getTime() + (WINDOW_DAYS + 1) * DAY_MS).toISOString(),
    };
  });
  return windows;
}

function useClientRange(clientId: number, start: string, end: string) {
  return useQuery({
    queryKey: appointmentKeys.range(start, end, clientId),
    queryFn: () => appointmentsApi.list({ start, end, client_id: clientId, include_canceled: true }),
  });
}

/** Upcoming and past appointments for one client, with quick scheduling. */
export default function ClientAppointmentsTab({ clientId }: { clientId: number }) {
  const session = useSession();
  const timeZone = session.staff.time_zone;
  const scheduler = canSchedule(session);
  const windows = useWindows();
  const [showAllPast, setShowAllPast] = useState(false);
  const dialogs = useAppointmentDialogs({ timeZone, showCalendarLink: true });
  useCalendarRealtime();

  const earlier = useClientRange(clientId, windows.pastStart, windows.today);
  const later = useClientRange(clientId, windows.today, windows.futureEnd);
  const query = earlier.isError ? earlier : later;
  const data = useMemo(() => {
    if (!earlier.data || !later.data) return undefined;
    const byId = new Map<number, Appointment>();
    for (const appointment of [...earlier.data, ...later.data]) byId.set(appointment.id, appointment);
    return [...byId.values()];
  }, [earlier.data, later.data]);

  const { upcoming, past, stats } = useMemo(() => {
    const now = Date.now();
    const all = (data ?? []).filter((appointment) => appointment.kind === 'appointment');
    const statusOf = (appointment: Appointment) => clientStatus(appointment, clientId);
    const isUpcoming = (appointment: Appointment) =>
      Date.parse(appointment.ends_at) > now && !isInactive({ status: statusOf(appointment) });
    return {
      upcoming: all.filter(isUpcoming).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)),
      past: all.filter((appointment) => !isUpcoming(appointment)).sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at)),
      stats: {
        attended: all.filter((appointment) => statusOf(appointment) === 'attended').length,
        noShow: all.filter((appointment) => statusOf(appointment) === 'no_show').length,
        canceled: all.filter((appointment) => ['canceled', 'late_canceled'].includes(statusOf(appointment))).length,
      },
    };
  }, [data, clientId]);

  const scheduleLink = `/portal/calendar?new=1&client=${clientId}`;
  const shownPast = showAllPast ? past : past.slice(0, PAST_PREVIEW);

  if (earlier.isError || later.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void earlier.refetch();
          void later.refetch();
        }}
      />
    );
  }
  if (!data) return <SectionSpinner />;

  if (upcoming.length === 0 && past.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CalendarDays />}
          title="No appointments yet"
          description="Schedule this client's first appointment, or set up a recurring series."
          action={
            scheduler && (
              <LinkButton to={scheduleLink} icon={<CalendarPlus className="h-4 w-4" />}>
                Schedule
              </LinkButton>
            )
          }
        />
        {dialogs.element}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Upcoming"
          description={upcoming.length === 0 ? 'Nothing scheduled' : `${upcoming.length} scheduled in the next year`}
          actions={
            scheduler && (
              <LinkButton to={scheduleLink} size="sm" icon={<CalendarPlus className="h-4 w-4" />}>
                Schedule
              </LinkButton>
            )
          }
        />
        {upcoming.length === 0 ? (
          <p className="px-5 py-4 text-sm text-sage-500">No upcoming appointments.</p>
        ) : (
          <AppointmentList appointments={upcoming} clientId={clientId} timeZone={timeZone} onOpen={dialogs.openDetails} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Past and canceled"
          description={
            <span className="flex flex-wrap gap-x-3">
              <span>{stats.attended} attended</span>
              <span>{stats.noShow} no show</span>
              <span>{stats.canceled} canceled</span>
            </span>
          }
        />
        {past.length === 0 ? (
          <p className="px-5 py-4 text-sm text-sage-500">No past appointments in the last year.</p>
        ) : (
          <>
            <AppointmentList appointments={shownPast} clientId={clientId} timeZone={timeZone} onOpen={dialogs.openDetails} />
            {past.length > PAST_PREVIEW && (
              <div className="border-t border-sage-100 px-5 py-3">
                <Button variant="ghost" size="sm" onClick={() => setShowAllPast((value) => !value)}>
                  {showAllPast ? 'Show fewer' : `Show all ${past.length}`}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
      {dialogs.element}
    </div>
  );
}

function AppointmentList({
  appointments,
  clientId,
  timeZone,
  onOpen,
}: {
  appointments: Appointment[];
  clientId: number;
  timeZone: string;
  onOpen: (appointment: Appointment) => void;
}) {
  return (
    <ul className="divide-y divide-sage-100">
      {appointments.map((appointment) => {
        const participant = appointment.participants.find((item) => item.client.id === clientId);
        const status = participant?.effective_status ?? appointment.status;
        const inactive = isInactive({ status });
        const type = sessionType(appointment);
        return (
          <li key={appointment.id}>
            <button
              type="button"
              onClick={() => onOpen(appointment)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-primary-50"
            >
              <span className="w-full min-w-0 sm:w-56">
                <span className={`block text-sm font-medium ${inactive ? 'text-sage-400 line-through' : 'text-sage-900'}`}>
                  {formatDate(appointment.starts_at, timeZone, { weekday: 'short' })}
                </span>
                <span className="block text-xs text-sage-500">{formatTimeRange(appointment.starts_at, appointment.ends_at, timeZone)}</span>
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-sage-700">
                <LocationIcon type={appointment.location_type} className="h-4 w-4 shrink-0 text-sage-400" />
                <span className="truncate">
                  {[appointment.service_code, appointment.service_description].filter(Boolean).join(' — ') || 'Appointment'}
                </span>
                {appointment.series_id !== null && <Repeat className="h-3.5 w-3.5 shrink-0 text-sage-400" aria-label="Recurring" />}
              </span>
              <span className="flex items-center gap-3">
                {type !== 'individual' && (
                  <Badge tone="info">
                    <Users className="h-3 w-3" aria-hidden="true" />
                    {type === 'group' ? appointment.title_label : SESSION_TYPE_LABELS[type]}
                  </Badge>
                )}
                <span className="text-sm text-sage-600">
                  {participant && !participant.billable ? 'Not billed' : formatMoney(participant?.fee_cents ?? 0)}
                </span>
                <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
