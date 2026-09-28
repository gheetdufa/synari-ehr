import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Cake, Check, Clock, Inbox, Mail, Phone, Stethoscope, Tag } from 'lucide-react';
import { conflictFrom, type AppointmentRequest } from '../../api/booking';
import { LOCATION_LABELS } from '../../api/appointments';
import { practiceApi, practiceKeys, type Location } from '../../api/practice';
import { useCan, useSession } from '../../auth/StaffAuth';
import { formatDate, formatPlainDate, fullName, initials, timeAgo } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Avatar, Badge, EmptyState, ErrorState } from '../../ui/Display';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { ConflictList, LocationIcon } from './CalendarParts';
import { usePendingRequests, useRequestActions } from './calendarHooks';
import { dayKey, formatTimeRange } from './calendarMath';
import { DeclineRequestForm } from './DeclineRequestForm';

/** Pending online requests with accept / decline. */
export function RequestsPanel({
  open,
  timeZone,
  bookingSlug,
  onClose,
  onShowDay,
}: {
  open: boolean;
  timeZone: string;
  bookingSlug: string | null;
  onClose: () => void;
  onShowDay: (day: string) => void;
}) {
  const { staff } = useSession();
  const handlesEveryone = useCan('schedule_all');
  const requests = usePendingRequests();
  const locations = useQuery({ queryKey: practiceKeys.locations, queryFn: practiceApi.locations, staleTime: 5 * 60_000 });
  const count = requests.data?.length ?? 0;
  const ownLink = bookingSlug && staff.is_clinician ? `${window.location.origin}/book/${bookingSlug}?clinician_id=${staff.id}` : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Appointment requests"
      description={
        requests.data
          ? count === 0
            ? 'Nothing waiting for you'
            : `${count} waiting for a response · pending times are held on the clinician's calendar`
          : undefined
      }
    >
      {requests.isLoading ? (
        <SectionSpinner />
      ) : requests.isError ? (
        <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
      ) : count === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No pending requests"
          description={
            bookingSlug
              ? `New requests from the booking page (${ownLink ?? `${window.location.origin}/book/${bookingSlug}`}) and the client portal appear here.`
              : 'Requests from the booking page and the client portal appear here. Turn on online booking in Settings.'
          }
        />
      ) : (
        <ul className="-mx-1 space-y-3">
          {requests.data?.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              timeZone={timeZone}
              showClinician={handlesEveryone}
              locations={locations.data ?? []}
              onShowDay={() => {
                onClose();
                onShowDay(dayKey(request.starts_at, timeZone));
              }}
            />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function RequestCard({
  request,
  timeZone,
  showClinician,
  locations,
  onShowDay,
}: {
  request: AppointmentRequest;
  timeZone: string;
  /** Name whose calendar it's for (for staff who handle everyone's requests). */
  showClinician: boolean;
  locations: Location[];
  onShowDay: () => void;
}) {
  const toast = useToast();
  const { accept, decline } = useRequestActions();
  const [declining, setDeclining] = useState(false);
  const conflict = conflictFrom(accept.error);
  const { client } = request;
  const office = locations.find((location) => location.id === request.location_id);
  const isNew = client.status === 'prospective';

  return (
    <li className="rounded-xl border border-sage-100 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Avatar label={initials(client)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-semibold text-sage-900">{fullName(client)}</p>
            {isNew ? <Badge tone="info">New client</Badge> : <Badge tone="neutral">Existing client</Badge>}
            <span className="text-xs text-sage-500">
              {request.source === 'public' ? 'Booking page' : 'Client portal'} · {timeAgo(request.created_at)}
            </span>
          </div>

          <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm text-sage-700 sm:grid-cols-2">
            <div className="flex items-center gap-2 sm:col-span-2">
              <dt>
                <Clock className="h-4 w-4 text-sage-400" aria-hidden="true" />
                <span className="sr-only">Requested time</span>
              </dt>
              <dd className="font-medium text-sage-900">
                {formatDate(request.starts_at, timeZone, { weekday: 'short' })} ·{' '}
                {formatTimeRange(request.starts_at, request.ends_at, timeZone)}
              </dd>
            </div>
            {showClinician && (
              <div className="flex items-center gap-2 sm:col-span-2">
                <dt>
                  <Stethoscope className="h-4 w-4 text-sage-400" aria-hidden="true" />
                  <span className="sr-only">Clinician</span>
                </dt>
                <dd>With {request.clinician.name}</dd>
              </div>
            )}
            {request.service_description && (
              <div className="flex items-center gap-2">
                <dt>
                  <Tag className="h-4 w-4 text-sage-400" aria-hidden="true" />
                  <span className="sr-only">Service</span>
                </dt>
                <dd className="truncate">
                  {request.service_description} ({request.duration_minutes} min)
                </dd>
              </div>
            )}
            <div className="flex items-center gap-2">
              <dt>
                <LocationIcon type={request.location_type} className="h-4 w-4 text-sage-400" />
                <span className="sr-only">Location</span>
              </dt>
              <dd>
                {LOCATION_LABELS[request.location_type]}
                {office && !office.is_video ? ` · ${office.name}` : ''}
              </dd>
            </div>
            {client.email && (
              <div className="flex min-w-0 items-center gap-2">
                <dt>
                  <Mail className="h-4 w-4 text-sage-400" aria-hidden="true" />
                  <span className="sr-only">Email</span>
                </dt>
                <dd className="min-w-0 truncate">
                  <a href={`mailto:${client.email}`} className="text-primary-700 hover:underline">
                    {client.email}
                  </a>
                </dd>
              </div>
            )}
            {client.phone && (
              <div className="flex items-center gap-2">
                <dt>
                  <Phone className="h-4 w-4 text-sage-400" aria-hidden="true" />
                  <span className="sr-only">Phone</span>
                </dt>
                <dd>
                  <a href={`tel:${client.phone}`} className="text-primary-700 hover:underline">
                    {client.phone}
                  </a>
                </dd>
              </div>
            )}
            {client.date_of_birth && (
              <div className="flex items-center gap-2">
                <dt>
                  <Cake className="h-4 w-4 text-sage-400" aria-hidden="true" />
                  <span className="sr-only">Date of birth</span>
                </dt>
                <dd>{formatPlainDate(client.date_of_birth)}</dd>
              </div>
            )}
          </dl>

          {request.request_message && (
            <blockquote className="mt-3 whitespace-pre-wrap rounded-lg bg-sage-50 px-3 py-2 text-sm text-sage-800">
              {request.request_message}
            </blockquote>
          )}

          {conflict && (
            <div className="mt-3">
              <ConflictList
                detail={conflict}
                timeZone={timeZone}
                footer={
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Move or cancel the overlapping appointment, decline this request, or book it anyway.</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={accept.isPending}
                      onClick={() =>
                        accept.mutate({ id: request.id, allowConflicts: true }, { onError: (error) => toast.error(error) })
                      }
                    >
                      Accept anyway
                    </Button>
                  </div>
                }
              />
            </div>
          )}

          {declining ? (
            <div className="mt-3 rounded-lg border border-sage-100 p-3">
              <DeclineRequestForm
                loading={decline.isPending}
                onBack={() => setDeclining(false)}
                onSubmit={(reason, includeReason) => decline.mutate({ id: request.id, reason, includeReason })}
              />
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={<Check className="h-4 w-4" />}
                loading={accept.isPending}
                onClick={() =>
                  accept.mutate({ id: request.id }, {
                    onError: (error) => {
                      if (!conflictFrom(error)) toast.error(error);
                    },
                  })
                }
              >
                Accept
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDeclining(true)} disabled={accept.isPending}>
                Decline
              </Button>
              <Button size="sm" variant="ghost" icon={<CalendarDays className="h-4 w-4" />} onClick={onShowDay}>
                See that day
              </Button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
