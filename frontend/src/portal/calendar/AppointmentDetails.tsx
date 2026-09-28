import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  Check,
  Clock,
  DollarSign,
  FilePlus2,
  Inbox,
  MessageSquare,
  Repeat,
  StickyNote,
  Stethoscope,
  Tag,
  UserRound,
  Users,
  Video,
  XCircle,
} from 'lucide-react';
import {
  STATUS_LABELS,
  appointmentKeys,
  appointmentsApi,
  type Appointment,
  type AttendanceStatus,
  type BookingSource,
  type EditScope,
  type Participant,
  type ParticipantUpdate,
} from '../../api/appointments';
import { ApiError } from '../../api/client';
import { conflictFrom } from '../../api/booking';
import { useSession } from '../../auth/StaffAuth';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { staffClientMessagesPath } from '../../shared/messages/links';
import { Button, LinkButton } from '../../ui/Button';
import { Alert, Badge, ErrorState } from '../../ui/Display';
import { Checkbox, Field, Select, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { canOpenArea } from '../navigation';
import {
  OUTCOME_STATUSES,
  SESSION_TYPE_LABELS,
  entryTitle,
  isInactive,
  sessionType,
  statusLabel,
  statusTone,
  videoJoinState,
  type OutcomeStatus,
} from './appointmentStyles';
import { ConflictList, LocationIcon, ScopeChoice, locationText } from './CalendarParts';
import { useInvalidateCalendar, useNow, useRequestActions } from './calendarHooks';
import { dayKey, formatTimeRange } from './calendarMath';
import { canManageCalendar } from './clinicians';
import { DeclineRequestForm } from './DeclineRequestForm';

export interface DetailsTarget {
  id: number;
  initial?: Appointment;
}

type Panel = 'details' | 'cancel' | 'delete' | 'decline';

const OUTCOME_LABELS: Record<OutcomeStatus, string> = {
  scheduled: 'Scheduled',
  attended: 'Attended',
  no_show: 'No show',
  late_canceled: 'Late canceled',
};

const ATTENDANCE_OPTIONS: AttendanceStatus[] = ['attended', 'no_show', 'late_canceled', 'canceled'];

const SOURCE_LABELS: Record<BookingSource, string> = {
  staff: 'Added by the practice',
  portal: 'Requested in the client portal',
  public: 'Requested on the booking page',
};

const CANCELED_BY: Record<string, string> = { staff: 'the practice', client: 'the client' };

/** Details of one appointment with its actions. Renders nothing while `target` is null. */
export function AppointmentDetails({
  target,
  timeZone,
  onClose,
  onEdit,
  showCalendarLink = false,
}: {
  target: DetailsTarget | null;
  timeZone: string;
  onClose: () => void;
  onEdit: (appointment: Appointment) => void;
  showCalendarLink?: boolean;
}) {
  if (!target) return null;
  return (
    <DetailsContent
      key={target.id}
      target={target}
      timeZone={timeZone}
      onClose={onClose}
      onEdit={onEdit}
      showCalendarLink={showCalendarLink}
    />
  );
}

function DetailsContent({
  target,
  timeZone,
  onClose,
  onEdit,
  showCalendarLink,
}: {
  target: DetailsTarget;
  timeZone: string;
  onClose: () => void;
  onEdit: (appointment: Appointment) => void;
  showCalendarLink: boolean;
}) {
  const query = useQuery({
    queryKey: appointmentKeys.detail(target.id),
    queryFn: () => appointmentsApi.get(target.id),
    initialData: target.initial,
  });
  const [panel, setPanel] = useState<Panel>('details');

  if (!query.data) {
    return (
      <Modal open onClose={onClose} title="Appointment" size="md">
        {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <SectionSpinner />}
      </Modal>
    );
  }
  if (query.data.restricted) return <BusyDetails appointment={query.data} timeZone={timeZone} onClose={onClose} />;
  return (
    <DetailsBody
      appointment={query.data}
      timeZone={timeZone}
      panel={panel}
      setPanel={setPanel}
      onClose={onClose}
      onEdit={onEdit}
      showCalendarLink={showCalendarLink}
    />
  );
}

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5">
      <dt className="mt-0.5 shrink-0 text-sage-400 [&>svg]:h-4 [&>svg]:w-4">
        {icon}
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 flex-1 text-sm text-sage-800">{children}</dd>
    </div>
  );
}

function WhenRow({ appointment, timeZone }: { appointment: Appointment; timeZone: string }) {
  return (
    <InfoRow icon={<Clock />} label="When">
      <p className="font-medium text-sage-900">{formatDate(appointment.starts_at, timeZone, { weekday: 'long', month: 'long' })}</p>
      <p className="text-sage-600">
        {formatTimeRange(appointment.starts_at, appointment.ends_at, timeZone)} · {appointment.duration_minutes} min
      </p>
    </InfoRow>
  );
}

/** A colleague's appointment with clients you can't reach: only when, whose and where. */
function BusyDetails({ appointment, timeZone, onClose }: { appointment: Appointment; timeZone: string; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Busy"
      size="sm"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <dl className="divide-y divide-sage-100">
        <WhenRow appointment={appointment} timeZone={timeZone} />
        <InfoRow icon={<Stethoscope />} label="Clinician">
          {appointment.clinician.name}
        </InfoRow>
        <InfoRow icon={<LocationIcon type={appointment.location_type} />} label="Location">
          {locationText(appointment.location_type, '', appointment.location)}
        </InfoRow>
      </dl>
      <p className="mt-3 text-sm text-sage-600">This time is booked with clients outside your access, so its details aren&apos;t shown.</p>
    </Modal>
  );
}

function DetailsBody({
  appointment,
  timeZone,
  panel,
  setPanel,
  onClose,
  onEdit,
  showCalendarLink,
}: {
  appointment: Appointment;
  timeZone: string;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  onClose: () => void;
  onEdit: (appointment: Appointment) => void;
  showCalendarLink: boolean;
}) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateCalendar();
  const now = useNow();
  const { accept, decline } = useRequestActions();
  const [scope, setScope] = useState<EditScope>('this');
  const [cancelReason, setCancelReason] = useState('');
  const [lateCancel, setLateCancel] = useState(false);
  const [notifyClient, setNotifyClient] = useState(true);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isAppointment = appointment.kind === 'appointment';
  const { participants } = appointment;
  const onlyClient = participants.length === 1 ? participants[0] : null;
  const type = sessionType(appointment);
  const isRequest = appointment.status === 'requested';
  const inSeries = appointment.series_id !== null;
  const canManage = canManageCalendar(session, appointment.clinician.id);
  const isMine = appointment.clinician.id === session.staff.id;
  const joinState = isMine ? videoJoinState(appointment, now) : 'none';
  const acceptConflict = conflictFrom(accept.error);
  const canWriteNotes = canOpenArea(session, '/portal/notes');
  const canMessage = canOpenArea(session, '/portal/messaging');
  const clientsNoun = participants.length > 1 ? 'the clients' : 'the client';

  const setStatus = useMutation({
    mutationFn: (status: OutcomeStatus) => appointmentsApi.update(appointment.id, { status }),
    onSuccess: async (_, status) => {
      toast.success(status === 'scheduled' ? 'Marked as scheduled' : `Marked as ${OUTCOME_LABELS[status].toLowerCase()}`);
      await invalidate();
    },
    onError: (error) => toast.error(error),
  });

  const updateParticipant = useMutation({
    mutationFn: ({ participant, changes }: { participant: Participant; changes: ParticipantUpdate }) =>
      appointmentsApi.updateParticipant(appointment.id, participant.id, changes),
    onSuccess: async (_, { participant, changes }) => {
      toast.success(
        changes.billable === undefined
          ? `Attendance updated for ${participant.client.name}`
          : `${participant.client.name} ${changes.billable ? 'will be billed' : "won't be billed"}`,
      );
      await invalidate();
    },
    onError: (error) => toast.error(error),
  });

  const cancel = useMutation({
    mutationFn: () =>
      appointmentsApi.cancel(
        appointment.id,
        { reason: cancelReason.trim(), late: lateCancel, notify_client: participants.length > 0 && notifyClient },
        inSeries ? scope : 'this',
      ),
    onSuccess: async (canceled) => {
      toast.success(canceled.length > 1 ? `${canceled.length} appointments canceled` : 'Appointment canceled');
      await invalidate();
      setPanel('details');
    },
    onError: (error) => toast.error(error),
  });

  const remove = useMutation({
    mutationFn: () => appointmentsApi.remove(appointment.id, inSeries ? scope : 'this'),
    onSuccess: async () => {
      toast.success(isAppointment ? 'Appointment deleted' : 'Event deleted');
      onClose();
      await invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setDeleteError(error.message);
      else toast.error(error);
    },
  });

  const noun = isAppointment ? 'appointment' : 'event';

  if (panel === 'cancel') {
    return (
      <Modal
        key="cancel"
        open
        onClose={onClose}
        title={`Cancel ${noun}`}
        description={`${entryTitle(appointment)} · ${formatDateTime(appointment.starts_at, timeZone)}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPanel('details')} disabled={cancel.isPending}>
              Back
            </Button>
            <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel {noun}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {inSeries && <ScopeChoice value={scope} onChange={setScope} action="Cancel" />}
          {participants.length > 1 && (
            <p className="text-sm text-sage-600">
              This cancels the session for everyone. To cancel for one client, set their attendance instead.
            </p>
          )}
          <Field label="Reason (optional)" hint="Kept on the appointment for your records.">
            {(props) => (
              <Textarea {...props} rows={3} maxLength={1000} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
            )}
          </Field>
          {isAppointment && (
            <Checkbox
              label="Late cancellation"
              description="Marks it late canceled so your cancellation policy fee can be billed."
              checked={lateCancel}
              onChange={(event) => setLateCancel(event.target.checked)}
            />
          )}
          {participants.length > 0 && isAppointment && (
            <Checkbox
              label={`Email ${clientsNoun}`}
              description="Let them know the appointment was canceled."
              checked={notifyClient}
              onChange={(event) => setNotifyClient(event.target.checked)}
            />
          )}
        </div>
      </Modal>
    );
  }

  if (panel === 'delete') {
    return (
      <Modal
        key="delete"
        open
        onClose={onClose}
        title={`Delete ${noun}`}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteError(null);
                setPanel('details');
              }}
              disabled={remove.isPending}
            >
              Back
            </Button>
            <Button variant="danger" loading={remove.isPending} disabled={deleteError !== null} onClick={() => remove.mutate()}>
              Delete
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm text-sage-700">
          <p>
            This removes the {noun} permanently. {isAppointment && 'Appointments with notes or invoices can’t be deleted — cancel them instead.'}
          </p>
          {inSeries && <ScopeChoice value={scope} onChange={setScope} action="Delete" />}
          {deleteError && (
            <Alert tone="danger" title="Can’t delete">
              {deleteError}
            </Alert>
          )}
        </div>
      </Modal>
    );
  }

  if (panel === 'decline') {
    return (
      <Modal key="decline" open onClose={onClose} title="Decline request" description={`${entryTitle(appointment)} · ${formatDateTime(appointment.starts_at, timeZone)}`}>
        <DeclineRequestForm
          loading={decline.isPending}
          onBack={() => setPanel('details')}
          onSubmit={(reason, includeReason) =>
            decline.mutate({ id: appointment.id, reason, includeReason }, { onSuccess: () => onClose() })
          }
        />
      </Modal>
    );
  }

  const canEdit = canManage && !isRequest && !isInactive(appointment);
  const canCancel = canManage && appointment.status === 'scheduled';
  const showOutcomes = isAppointment && (OUTCOME_STATUSES as readonly string[]).includes(appointment.status);
  const perClient = participants.length > 1 && canManage && !isRequest && appointment.status !== 'declined';

  const footer = !canManage ? (
    <Button variant="secondary" onClick={onClose}>
      Close
    </Button>
  ) : isRequest ? (
    <>
      <Button variant="secondary" onClick={() => setPanel('decline')} disabled={accept.isPending}>
        Decline
      </Button>
      <Button
        icon={<Check className="h-4 w-4" />}
        loading={accept.isPending}
        onClick={() =>
          accept.mutate({ id: appointment.id }, {
            onError: (error) => {
              if (!conflictFrom(error)) toast.error(error);
            },
          })
        }
      >
        Accept request
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" className="mr-auto text-red-700 hover:bg-red-50" onClick={() => setPanel('delete')}>
        Delete
      </Button>
      {canCancel && (
        <Button variant="secondary" icon={<XCircle className="h-4 w-4" />} onClick={() => setPanel('cancel')}>
          Cancel {noun}
        </Button>
      )}
      {canEdit ? (
        <Button onClick={() => onEdit(appointment)}>Edit</Button>
      ) : (
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      )}
    </>
  );

  return (
    <Modal
      key="details"
      open
      onClose={onClose}
      title={entryTitle(appointment)}
      description={
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {isAppointment ? (
            <Badge tone={statusTone(appointment.status)}>{statusLabel(appointment.status)}</Badge>
          ) : (
            <Badge tone="neutral">{isInactive(appointment) ? 'Canceled event' : 'Event'}</Badge>
          )}
          {type !== 'individual' && (
            <Badge tone="info">
              <Users className="h-3 w-3" aria-hidden="true" /> {SESSION_TYPE_LABELS[type]}
            </Badge>
          )}
          {inSeries && (
            <Badge tone="neutral">
              <Repeat className="h-3 w-3" aria-hidden="true" /> Recurring
            </Badge>
          )}
        </span>
      }
      footer={footer}
    >
      <div className="space-y-4">
        {acceptConflict && (
          <ConflictList
            detail={acceptConflict}
            timeZone={timeZone}
            footer={
              <div className="flex flex-wrap items-center gap-2">
                <span>Move or cancel the overlapping appointment, decline this request, or book it anyway.</span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={accept.isPending}
                  onClick={() =>
                    accept.mutate({ id: appointment.id, allowConflicts: true }, { onError: (error) => toast.error(error) })
                  }
                >
                  Accept anyway
                </Button>
              </div>
            }
          />
        )}

        <dl className="divide-y divide-sage-100">
          <WhenRow appointment={appointment} timeZone={timeZone} />
          <InfoRow icon={<Stethoscope />} label="Clinician">
            {appointment.clinician.name}
            {isMine && <span className="text-sage-500"> (you)</span>}
          </InfoRow>
          {onlyClient && (
            <InfoRow icon={<UserRound />} label="Client">
              <Link to={`/portal/clients/${onlyClient.client.id}`} className="font-medium text-primary-700 hover:underline">
                {onlyClient.client.name}
              </Link>
            </InfoRow>
          )}
          {isAppointment && (appointment.service_code || appointment.service_description) && (
            <InfoRow icon={<Tag />} label="Service">
              {appointment.service_code && <span className="font-medium">{appointment.service_code}</span>}
              {appointment.service_code && appointment.service_description && ' — '}
              {appointment.service_description}
            </InfoRow>
          )}
          {onlyClient && (
            <InfoRow icon={<DollarSign />} label="Fee">
              {formatMoney(onlyClient.fee_cents)}
            </InfoRow>
          )}
          <InfoRow icon={<LocationIcon type={appointment.location_type} />} label="Location">
            {locationText(appointment.location_type, appointment.location_details, appointment.location)}
          </InfoRow>
          {appointment.memo && (
            <InfoRow icon={<StickyNote />} label="Memo">
              <p className="whitespace-pre-wrap">{appointment.memo}</p>
              <p className="mt-0.5 text-xs text-sage-500">Internal memo</p>
            </InfoRow>
          )}
          {(isRequest || appointment.request_message) && (
            <InfoRow icon={<Inbox />} label="Request">
              <p className="text-sage-600">{SOURCE_LABELS[appointment.source]}</p>
              {appointment.request_message && (
                <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-primary-200 pl-3 text-sage-800">
                  {appointment.request_message}
                </blockquote>
              )}
            </InfoRow>
          )}
          {appointment.canceled_at && ['canceled', 'late_canceled', 'declined'].includes(appointment.status) && (
            <InfoRow icon={<XCircle />} label="Canceled">
              <p>
                {appointment.status === 'declined' ? 'Declined' : 'Canceled'}
                {appointment.canceled_by ? ` by ${CANCELED_BY[appointment.canceled_by] ?? appointment.canceled_by}` : ''} on{' '}
                {formatDate(appointment.canceled_at, timeZone)}
              </p>
              {appointment.cancel_reason && <p className="text-sage-600">“{appointment.cancel_reason}”</p>}
            </InfoRow>
          )}
        </dl>

        {participants.length > 1 && (
          <section aria-labelledby={`clients-${appointment.id}`}>
            <h3 id={`clients-${appointment.id}`} className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-sage-500">
              Clients ({participants.length})
            </h3>
            <ul className="divide-y divide-sage-100 rounded-lg border border-sage-100">
              {participants.map((participant) => (
                <ParticipantRow
                  key={participant.id}
                  appointment={appointment}
                  participant={participant}
                  editable={perClient}
                  busy={updateParticipant.isPending}
                  canWriteNotes={canWriteNotes && isAppointment && !isRequest}
                  canMessage={canMessage}
                  onChange={(changes) => updateParticipant.mutate({ participant, changes })}
                />
              ))}
            </ul>
          </section>
        )}

        {showOutcomes && canManage && (
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-sage-500">
              {participants.length > 1 ? 'Session status' : 'Attendance'}
            </p>
            <div role="group" aria-label={participants.length > 1 ? 'Session status' : 'Attendance'} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {OUTCOME_STATUSES.map((status) => {
                const current = appointment.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={current}
                    disabled={setStatus.isPending}
                    onClick={() => !current && setStatus.mutate(status)}
                    className={`rounded-lg border px-2 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-60 ${
                      current ? 'border-primary-500 bg-primary-50 text-primary-800' : 'border-sage-200 text-sage-700 hover:bg-sage-50'
                    }`}
                  >
                    {OUTCOME_LABELS[status]}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {(joinState !== 'none' || onlyClient || showCalendarLink) && (
          <div className="flex flex-wrap gap-2">
            {joinState === 'open' && (
              <LinkButton to={`/session/${appointment.id}`} size="sm" icon={<Video className="h-4 w-4" />}>
                Start video session
              </LinkButton>
            )}
            {joinState === 'early' && (
              <Button size="sm" variant="secondary" disabled icon={<Video className="h-4 w-4" />} title="Opens 60 minutes before the start">
                Video opens 60 min before
              </Button>
            )}
            {onlyClient && canWriteNotes && isAppointment && !isRequest && (
              <LinkButton
                to={`/portal/notes?new=1&client=${onlyClient.client.id}&appointment=${appointment.id}`}
                size="sm"
                variant="secondary"
                icon={<FilePlus2 className="h-4 w-4" />}
              >
                New note
              </LinkButton>
            )}
            {onlyClient && canMessage && (
              <LinkButton
                to={staffClientMessagesPath(onlyClient.client.id)}
                size="sm"
                variant="secondary"
                icon={<MessageSquare className="h-4 w-4" />}
              >
                Message
              </LinkButton>
            )}
            {showCalendarLink && (
              <LinkButton
                to={`/portal/calendar?view=day&date=${dayKey(appointment.starts_at, timeZone)}`}
                size="sm"
                variant="ghost"
                icon={<CalendarDays className="h-4 w-4" />}
              >
                Open in calendar
              </LinkButton>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** One client in a shared session: billing and fee, their own attendance, and their chart links. */
function ParticipantRow({
  appointment,
  participant,
  editable,
  busy,
  canWriteNotes,
  canMessage,
  onChange,
}: {
  appointment: Appointment;
  participant: Participant;
  editable: boolean;
  busy: boolean;
  canWriteNotes: boolean;
  canMessage: boolean;
  onChange: (changes: ParticipantUpdate) => void;
}) {
  const { client } = participant;
  const followsLabel = `Same as session (${STATUS_LABELS[appointment.status]})`;
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Link to={`/portal/clients/${client.id}`} className="min-w-0 truncate text-sm font-medium text-primary-700 hover:underline">
          {client.name}
        </Link>
        <span className="flex items-center gap-2 text-xs text-sage-600">
          {participant.billable ? (
            <>
              <Badge tone="primary">Billed</Badge>
              <span className="tabular-nums">{formatMoney(participant.fee_cents)}</span>
            </>
          ) : (
            <Badge tone="neutral">Not billed</Badge>
          )}
          {!editable && participant.attendance && (
            <Badge tone={statusTone(participant.effective_status)}>{STATUS_LABELS[participant.effective_status]}</Badge>
          )}
        </span>
      </div>
      {(editable || canWriteNotes || canMessage) && (
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <>
              <Select
                aria-label={`Attendance for ${client.name}`}
                className="h-8 max-w-[15rem] text-xs"
                value={participant.attendance ?? ''}
                disabled={busy}
                onChange={(event) => onChange({ attendance: (event.target.value || null) as AttendanceStatus | null })}
              >
                <option value="">{followsLabel}</option>
                {ATTENDANCE_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-1.5 text-xs text-sage-700">
                <input
                  type="checkbox"
                  checked={participant.billable}
                  disabled={busy}
                  onChange={(event) => onChange({ billable: event.target.checked })}
                  className="h-3.5 w-3.5 rounded border-sage-300 text-primary-600 accent-primary-600 focus:ring-primary-400"
                />
                Bill {client.name.split(' ')[0]}
              </label>
            </>
          )}
          <span className="ml-auto flex gap-1">
            {canWriteNotes && (
              <LinkButton
                to={`/portal/notes?new=1&client=${client.id}&appointment=${appointment.id}`}
                size="sm"
                variant="ghost"
                icon={<FilePlus2 className="h-4 w-4" />}
                aria-label={`New note for ${client.name}`}
              >
                Note
              </LinkButton>
            )}
            {canMessage && (
              <LinkButton
                to={`/portal/messaging?client=${client.id}`}
                size="sm"
                variant="ghost"
                icon={<MessageSquare className="h-4 w-4" />}
                aria-label={`Message ${client.name}`}
              >
                Message
              </LinkButton>
            )}
          </span>
        </div>
      )}
    </li>
  );
}
