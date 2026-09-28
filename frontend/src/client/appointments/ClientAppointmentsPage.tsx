import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, CalendarPlus, History, MapPin, Phone, Users, Video } from 'lucide-react';
import type { AppointmentStatus } from '../../api/appointments';
import {
  bookingKeys,
  portalAppointmentsApi,
  type PortalAppointment,
  type PortalAppointmentsWhen,
} from '../../api/booking';
import { usePortalClient } from '../../auth/ClientAuth';
import { useRealtimeEvent } from '../../lib/realtime';
import { Button, LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Alert, Badge, EmptyState, ErrorState, PageHeader, Tabs } from '../../ui/Display';
import { Field, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { JoinVideoButton } from './JoinVideoButton';
import { isSharedSession, sessionLabel } from './sessionLabels';
import { formatLongDay, formatTimeSpan, timeZoneLabel, timeZoneName } from './slots';

const JOIN_OPENS_BEFORE_MS = 60 * 60_000;
const JOIN_CLOSES_AFTER_MS = 30 * 60_000;
const NOW_TICK_MS = 30_000;
const REASON_LIMIT = 500;
const LATE_CANCEL_WARNING = "It's within the practice's cancellation window, so canceling now counts as a late cancellation and may be charged.";

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const STATUS_BADGES: Record<AppointmentStatus, { label: string; tone: BadgeTone } | null> = {
  requested: { label: 'Requested — awaiting confirmation', tone: 'warning' },
  scheduled: { label: 'Confirmed', tone: 'primary' },
  attended: { label: 'Attended', tone: 'success' },
  no_show: { label: 'Missed', tone: 'warning' },
  late_canceled: { label: 'Late canceled', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  declined: { label: 'Request declined', tone: 'neutral' },
};

/** Past entries read differently: a scheduled visit that has passed needs no badge. */
const PAST_BADGES: Partial<Record<AppointmentStatus, { label: string; tone: BadgeTone } | null>> = {
  requested: { label: 'Not confirmed', tone: 'neutral' },
  scheduled: null,
};

/** What canceling this appointment is called: withdrawing a request, canceling the client's own
 * place in a shared session, or canceling the appointment. */
function cancelAction(appointment: PortalAppointment): string {
  if (appointment.status === 'requested') return 'Withdraw request';
  return isSharedSession(appointment) ? 'Cancel my attendance' : 'Cancel appointment';
}

/** The current time, refreshed every 30 seconds so time-based buttons appear on their own. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function joinWindow(appointment: PortalAppointment, now: number): 'before' | 'open' | 'closed' {
  if (!appointment.has_video || appointment.status !== 'scheduled') return 'closed';
  if (now < Date.parse(appointment.starts_at) - JOIN_OPENS_BEFORE_MS) return 'before';
  if (now < Date.parse(appointment.ends_at) + JOIN_CLOSES_AFTER_MS) return 'open';
  return 'closed';
}

function Location({ appointment }: { appointment: PortalAppointment }) {
  if (appointment.location_type === 'video') {
    return (
      <span className="flex items-center gap-1.5">
        <Video className="h-4 w-4 shrink-0 text-sage-500" aria-hidden="true" />
        Video
      </span>
    );
  }
  if (appointment.location_type === 'phone') {
    return (
      <span className="flex items-start gap-1.5">
        <Phone className="mt-0.5 h-4 w-4 shrink-0 text-sage-500" aria-hidden="true" />
        <span>Phone{appointment.location_details ? ` · ${appointment.location_details}` : ''}</span>
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5">
      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-sage-500" aria-hidden="true" />
      <span>{appointment.location_details || 'In person'}</span>
    </span>
  );
}

function DateBlock({ iso, timeZone }: { iso: string; timeZone: string }) {
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(iso));
  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-primary-50 text-primary-800"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide">{part({ month: 'short' })}</span>
      <span className="text-xl font-semibold leading-none">{part({ day: 'numeric' })}</span>
      <span className="text-[11px] text-primary-700">{part({ weekday: 'short' })}</span>
    </div>
  );
}

function AppointmentCard({
  appointment,
  when,
  timeZone,
  now,
  onCancel,
}: {
  appointment: PortalAppointment;
  when: PortalAppointmentsWhen;
  timeZone: string;
  now: number;
  onCancel: (appointment: PortalAppointment) => void;
}) {
  const client = usePortalClient();
  const past = when === 'past';
  const pastBadge = PAST_BADGES[appointment.status];
  const badge = past && pastBadge !== undefined ? pastBadge : STATUS_BADGES[appointment.status];
  const join = joinWindow(appointment, now);
  // The API lets any pending request be withdrawn, even one whose time has passed; hide that here.
  const canCancel = appointment.can_cancel && !past;
  const lockedIn = !past && appointment.status === 'scheduled' && !appointment.can_cancel;
  const inactive = appointment.status === 'canceled' || appointment.status === 'declined';
  const shared = sessionLabel(appointment);

  return (
    <li>
      <Card className="p-4 sm:p-5">
        <div className="flex gap-4">
          <DateBlock iso={appointment.starts_at} timeZone={timeZone} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <h3 className={`font-semibold ${inactive ? 'text-sage-500 line-through' : 'text-sage-900'}`}>
                  {formatLongDay(appointment.starts_at, timeZone)}
                </h3>
                <p className="text-sm text-sage-700">
                  {formatTimeSpan(appointment.starts_at, appointment.ends_at, timeZone)}{' '}
                  <span className="text-sage-500">{timeZoneName(timeZone, new Date(appointment.starts_at))}</span>
                </p>
              </div>
              {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
            </div>
            <div className="mt-2 space-y-1 text-sm text-sage-700">
              <p>
                {appointment.service_description || 'Appointment'}
                <span className="text-sage-500"> with {appointment.clinician_name}</span>
              </p>
              {shared && (
                <p className="flex items-center gap-1.5">
                  <Users className="h-4 w-4 shrink-0 text-sage-500" aria-hidden="true" />
                  {shared}
                </p>
              )}
              <Location appointment={appointment} />
            </div>

            {(join !== 'closed' || canCancel || lockedIn) && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {join === 'open' && <JoinVideoButton appointmentId={appointment.id} size="sm" />}
                {join === 'before' && (
                  <p className="text-xs text-sage-500">The video link opens 60 minutes before your appointment.</p>
                )}
                {canCancel && (
                  <Button variant="secondary" size="sm" onClick={() => onCancel(appointment)}>
                    {cancelAction(appointment)}
                  </Button>
                )}
                {canCancel && appointment.cancel_is_late && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-800">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Canceling now counts as a late cancellation and may be charged.
                  </p>
                )}
                {lockedIn && (
                  <p className="text-xs text-sage-500">
                    To cancel or reschedule, please contact {appointment.clinician_name}.
                    {client.permissions.messaging && (
                      <>
                        {' '}
                        <Link to="/client/messages" className="font-medium text-primary-700 hover:text-primary-800">
                          Send a message
                        </Link>
                      </>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
    </li>
  );
}

function CancelDialog({
  appointment,
  timeZone,
  onClose,
}: {
  appointment: PortalAppointment | null;
  timeZone: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const isRequest = appointment?.status === 'requested';
  const shared = appointment !== null && !isRequest && isSharedSession(appointment);
  const title = isRequest ? 'Withdraw this request?' : shared ? 'Cancel your attendance?' : 'Cancel this appointment?';

  const close = () => {
    setReason('');
    onClose();
  };

  const cancel = useMutation({
    mutationFn: (input: { target: PortalAppointment; reason: string }) =>
      portalAppointmentsApi.cancel(input.target.id, input.reason),
    onSuccess: (_, { target }) => {
      toast.success(
        target.status === 'requested'
          ? 'Request withdrawn'
          : isSharedSession(target)
            ? 'Your attendance was canceled'
            : 'Appointment canceled',
      );
      close();
    },
    onError: (error) => {
      toast.error(error);
      close();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: bookingKeys.portalAppointments }),
  });

  return (
    <Modal
      open={appointment !== null}
      onClose={() => !cancel.isPending && close()}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={cancel.isPending}>
            {isRequest ? 'Keep request' : shared ? 'Keep my place' : 'Keep appointment'}
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending}
            onClick={() => appointment && cancel.mutate({ target: appointment, reason: reason.trim() })}
          >
            {appointment ? cancelAction(appointment) : 'Cancel appointment'}
          </Button>
        </>
      }
    >
      {appointment && (
        <div className="space-y-4">
          <p className="text-sm text-sage-700">
            <span className="font-medium text-sage-900">{formatLongDay(appointment.starts_at, timeZone)}</span>,{' '}
            {formatTimeSpan(appointment.starts_at, appointment.ends_at, timeZone)}
            {appointment.service_description ? ` · ${appointment.service_description}` : ''}
          </p>
          {shared && (
            <p className="text-sm text-sage-700">
              Only your place is canceled; the session goes ahead for the others.
            </p>
          )}
          {!isRequest && appointment.cancel_is_late && (
            <Alert tone="warning" title="Late cancellation">
              {LATE_CANCEL_WARNING}
            </Alert>
          )}
          {/* The API keeps a reason only when the whole appointment is canceled. */}
          {!shared && (
            <Field label="Reason (optional)" hint={`Shared with ${appointment.clinician_name}.`}>
              {(props) => (
                <Textarea
                  {...props}
                  rows={3}
                  maxLength={REASON_LIMIT}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}

function AppointmentList({
  when,
  timeZone,
  now,
  onCancel,
}: {
  when: PortalAppointmentsWhen;
  timeZone: string;
  now: number;
  onCancel: (appointment: PortalAppointment) => void;
}) {
  const client = usePortalClient();
  const list = useQuery({
    queryKey: bookingKeys.portalAppointmentList(when),
    queryFn: () => portalAppointmentsApi.list(when),
  });

  if (list.isPending) return <SectionSpinner />;
  if (list.isError) {
    return (
      <Card>
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      </Card>
    );
  }
  if (list.data.length === 0) {
    return (
      <Card>
        {when === 'upcoming' ? (
          <EmptyState
            icon={<CalendarDays />}
            title="No upcoming appointments"
            description={
              client.permissions.booking
                ? 'Request a time that works for you, and your clinician will confirm it.'
                : 'When your clinician schedules an appointment, it will show up here.'
            }
            action={
              client.permissions.booking && (
                <LinkButton to="/client/appointments/book" icon={<CalendarPlus className="h-4 w-4" />}>
                  Request an appointment
                </LinkButton>
              )
            }
          />
        ) : (
          <EmptyState icon={<History />} title="No past appointments" description="Appointments you've had will be listed here." />
        )}
      </Card>
    );
  }
  return (
    <ul className="space-y-3">
      {list.data.map((appointment) => (
        <AppointmentCard
          key={appointment.id}
          appointment={appointment}
          when={when}
          timeZone={timeZone}
          now={now}
          onCancel={onCancel}
        />
      ))}
    </ul>
  );
}

/** Client portal: upcoming and past appointments, joining video visits and canceling within policy. */
export default function ClientAppointmentsPage() {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const [tab, setTab] = useState<PortalAppointmentsWhen>('upcoming');
  const [canceling, setCanceling] = useState<PortalAppointment | null>(null);

  useRealtimeEvent('appointment.*', () => queryClient.invalidateQueries({ queryKey: bookingKeys.portalAppointments }));

  const upcoming = useQuery({
    queryKey: bookingKeys.portalAppointmentList('upcoming'),
    queryFn: () => portalAppointmentsApi.list('upcoming'),
  });

  return (
    <div>
      <PageHeader
        title="Appointments"
        description={`Times are shown in ${timeZoneLabel(client.time_zone)}.`}
        actions={
          client.permissions.booking && (
            <LinkButton to="/client/appointments/book" icon={<CalendarPlus className="h-4 w-4" />}>
              Request an appointment
            </LinkButton>
          )
        }
      />
      <div className="mb-4">
        <Tabs
          tabs={[
            { id: 'upcoming', label: 'Upcoming', count: upcoming.data?.length },
            { id: 'past', label: 'Past' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>
      <div role="tabpanel" aria-label={tab === 'upcoming' ? 'Upcoming appointments' : 'Past appointments'}>
        <AppointmentList when={tab} timeZone={client.time_zone} now={now} onCancel={setCanceling} />
      </div>
      <CancelDialog appointment={canceling} timeZone={client.time_zone} onClose={() => setCanceling(null)} />
    </div>
  );
}
