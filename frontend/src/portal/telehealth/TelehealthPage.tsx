import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Clock, Users, Video } from 'lucide-react';
import { appointmentKeys, appointmentsApi, STATUS_LABELS, type Appointment } from '../../api/appointments';
import { fetchPublicConfig } from '../../api/auth';
import { telehealthApi, telehealthKeys } from '../../api/telehealth';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatTime } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import { JoinLinkActions } from '../../telehealth/JoinLinkActions';
import { hostJoinWindow } from '../../telehealth/sessionWindow';
import { useNow } from '../../telehealth/useNow';
import { Button, LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge, EmptyState, ErrorState, PageHeader, Tabs } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { dayKey, groupByDay, scheduleRange, videoAppointments } from './schedule';
import { TelehealthSetup } from './TelehealthSetup';

type Scope = 'mine' | 'everyone';

const SCOPE_TABS: { id: Scope; label: string }[] = [
  { id: 'mine', label: 'My sessions' },
  { id: 'everyone', label: 'Everyone' },
];

/**
 * Video sessions today and over the next week. Clinicians start the sessions they host; staff who
 * manage every calendar can also share join links for everyone's sessions.
 */
export default function TelehealthPage() {
  const { staff } = useSession();
  const config = useQuery({ queryKey: ['config'], queryFn: fetchPublicConfig, staleTime: 5 * 60_000 });

  return (
    <>
      <PageHeader
        title="Telehealth"
        description={
          staff.is_clinician
            ? 'Start video sessions and share join links with your clients.'
            : "Share join links for the practice's video sessions."
        }
      />
      {config.isLoading ? (
        <SectionSpinner />
      ) : config.error ? (
        <Card>
          <ErrorState error={config.error} onRetry={() => void config.refetch()} />
        </Card>
      ) : config.data?.telehealth_enabled ? (
        <VideoSchedule />
      ) : (
        <TelehealthSetup />
      )}
    </>
  );
}

function VideoSchedule() {
  const { staff } = useSession();
  const managesCalendars = useCan('schedule_all');
  const timeZone = staff.time_zone;
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const today = dayKey(now, timeZone);
  const [range, setRange] = useState(() => scheduleRange(timeZone));
  const [scope, setScope] = useState<Scope>(staff.is_clinician ? 'mine' : 'everyone');
  // Roll the list over when the local day changes.
  useEffect(() => setRange(scheduleRange(timeZone)), [timeZone, today]);

  const appointmentsQuery = useQuery({
    queryKey: appointmentKeys.range(range.start, range.end),
    queryFn: () => appointmentsApi.list({ start: range.start, end: range.end, include_canceled: false }),
  });
  const appointments = useMemo(
    () => videoAppointments(appointmentsQuery.data ?? [], scope === 'mine' ? staff.id : null),
    [appointmentsQuery.data, scope, staff.id],
  );
  const groups = useMemo(() => groupByDay(appointments, timeZone, now), [appointments, timeZone, now]);
  // Only the host may look at a session's waiting room.
  const hostedToday = (groups.find((group) => group.isToday)?.appointments ?? []).filter(
    (appointment) => appointment.clinician.id === staff.id,
  );

  const waitingQueries = useQueries({
    queries: hostedToday.map((appointment) => ({
      queryKey: telehealthKeys.waitingRoom(appointment.id),
      queryFn: () => telehealthApi.waitingRoom(appointment.id),
    })),
  });
  const waitingCounts = new Map<number, number>();
  hostedToday.forEach((appointment, index) => {
    const entries = waitingQueries[index]?.data ?? [];
    waitingCounts.set(appointment.id, entries.filter((entry) => entry.status === 'waiting').length);
  });

  useRealtimeEvent('waiting_room.updated', (event) => {
    if (typeof event.data.appointment_id === 'number') {
      void queryClient.invalidateQueries({ queryKey: telehealthKeys.waitingRoom(event.data.appointment_id) });
    }
  });
  useRealtimeEvent('appointment.*', () => void queryClient.invalidateQueries({ queryKey: appointmentKeys.all }));

  const scopeChoice = staff.is_clinician && managesCalendars && (
    <Tabs tabs={SCOPE_TABS} active={scope} onChange={setScope} />
  );

  if (appointmentsQuery.isLoading) return <SectionSpinner />;
  if (appointmentsQuery.error) {
    return (
      <Card>
        <ErrorState error={appointmentsQuery.error} onRetry={() => void appointmentsQuery.refetch()} />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {scopeChoice}
      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Video />}
            title="No video sessions this week"
            description="Appointments with the Video location show up here, with a join link for each client."
            action={
              <LinkButton to="/portal/calendar" variant="secondary" icon={<CalendarPlus className="h-4 w-4" />}>
                Open calendar
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <>
          <p className="text-xs text-sage-500">Times shown in {timeZone.replace(/_/g, ' ')}.</p>
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`day-${group.key}`}>
              <h2 id={`day-${group.key}`} className="mb-2 text-sm font-semibold text-sage-700">
                {group.label}
              </h2>
              <Card className="divide-y divide-sage-100">
                {group.appointments.map((appointment) => (
                  <VideoAppointmentRow
                    key={appointment.id}
                    appointment={appointment}
                    isHost={appointment.clinician.id === staff.id}
                    timeZone={timeZone}
                    now={now}
                    waiting={waitingCounts.get(appointment.id) ?? 0}
                  />
                ))}
              </Card>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function VideoAppointmentRow({
  appointment,
  isHost,
  timeZone,
  now,
  waiting,
}: {
  appointment: Appointment;
  isHost: boolean;
  timeZone: string;
  now: number;
  waiting: number;
}) {
  const window = hostJoinWindow(appointment.starts_at, appointment.ends_at, now);
  const clientCount = appointment.participants.length;
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="w-20 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-sage-900">
          {formatTime(appointment.starts_at, timeZone)}
          <span className="block text-xs font-normal text-sage-500">to {formatTime(appointment.ends_at, timeZone)}</span>
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-sage-900">{appointment.title_label || 'Untitled appointment'}</p>
          {!isHost && <p className="truncate text-sm text-sage-600">Hosted by {appointment.clinician.name}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {appointment.service_description && (
              <span className="text-xs text-sage-500">{appointment.service_description}</span>
            )}
            {clientCount > 1 && (
              <Badge>
                <Users className="h-3 w-3" aria-hidden="true" />
                {clientCount} clients
              </Badge>
            )}
            {appointment.status !== 'scheduled' && <Badge>{STATUS_LABELS[appointment.status]}</Badge>}
            {waiting > 0 && (
              <Badge tone="warning">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
                {waiting} waiting
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <JoinLinkActions appointment={appointment} />
        {isHost &&
          (window.state === 'open' ? (
            <LinkButton to={`/session/${appointment.id}`} size="sm" icon={<Video className="h-4 w-4" />}>
              Start session
            </LinkButton>
          ) : (
            <Button
              size="sm"
              disabled
              icon={<Clock className="h-4 w-4" />}
              title={
                window.state === 'too_early'
                  ? 'Sessions open 60 minutes before they start'
                  : 'Sessions close 60 minutes after they end'
              }
            >
              {window.state === 'too_early' ? `Opens ${formatTime(window.opensAt.toISOString(), timeZone)}` : 'Closed'}
            </Button>
          ))}
      </div>
    </div>
  );
}
