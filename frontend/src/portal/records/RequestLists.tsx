import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileClock, FilePen, Plus } from 'lucide-react';
import {
  recordKeys,
  recordsApi,
  type AmendmentFilters,
  type AmendmentStatus,
  type RecordRequestFilters,
  type RecordRequestStatus,
} from '../../api/records';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState } from '../../ui/Display';
import { Select } from '../../ui/Form';
import { SectionSpinner } from '../../ui/Spinner';
import { AmendmentItem } from './AmendmentItem';
import { NewAmendmentModal, NewRecordRequestModal } from './NewRequestModals';
import { RecordRequestItem } from './RecordRequestItem';
import { AMENDMENT_STATUS_LABELS, RECORD_STATUS_LABELS, byDeadline } from './recordHelpers';

type StatusChoice<T extends string> = T | 'all';

function StatusFilter<T extends string>({
  value,
  labels,
  label,
  onChange,
}: {
  value: StatusChoice<T>;
  labels: Record<T, string>;
  label: string;
  onChange: (value: StatusChoice<T>) => void;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      className="h-8 w-40 text-sm"
      onChange={(event) => onChange(event.target.value as StatusChoice<T>)}
    >
      <option value="all">All</option>
      {(Object.keys(labels) as T[]).map((status) => (
        <option key={status} value={status}>
          {labels[status]}
        </option>
      ))}
    </Select>
  );
}

function ListCard({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} actions={<div className="flex flex-wrap gap-2">{actions}</div>} />
      {children}
    </Card>
  );
}

/**
 * Which requests a list starts with: open ones in the practice queue, everything on a client's
 * chart, and everything when a notification linked to one (it may be closed by now).
 */
function initialStatus(clientId: number | undefined, highlightId: number | undefined): 'open' | 'all' {
  return clientId === undefined && highlightId === undefined ? 'open' : 'all';
}

/**
 * Requests for copies of records, open ones first by deadline. With `clientId`, only that
 * client's requests, and staff can record one on the client's behalf. `highlightId` marks the
 * request a notification linked to.
 */
export function RecordRequestList({ clientId, highlightId }: { clientId?: number; highlightId?: number }) {
  const [status, setStatus] = useState<StatusChoice<RecordRequestStatus>>(initialStatus(clientId, highlightId));
  const [creating, setCreating] = useState(false);
  const filters: RecordRequestFilters = {
    ...(status === 'all' ? {} : { status }),
    ...(clientId === undefined ? {} : { client_id: clientId }),
  };
  const requests = useQuery({ queryKey: recordKeys.requestList(filters), queryFn: () => recordsApi.requests(filters) });
  const items = byDeadline(requests.data ?? []);
  return (
    <ListCard
      title="Copies of records"
      description="Clients may ask for a copy of their record. Respond within 30 days; you can extend once by 30 days."
      actions={
        <>
          <StatusFilter value={status} labels={RECORD_STATUS_LABELS} label="Show requests" onChange={setStatus} />
          {clientId !== undefined && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Record request
            </Button>
          )}
        </>
      }
    >
      {requests.isPending && <SectionSpinner />}
      {requests.isError && <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />}
      {requests.data && items.length === 0 && (
        <EmptyState icon={<FileClock />} title={status === 'open' ? 'No open requests' : 'No requests'} />
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-sage-100" aria-label="Record requests">
          {items.map((request) => (
            <RecordRequestItem
              key={request.id}
              request={request}
              showClient={clientId === undefined}
              highlighted={request.id === highlightId}
            />
          ))}
        </ul>
      )}
      {creating && clientId !== undefined && <NewRecordRequestModal clientId={clientId} onClose={() => setCreating(false)} />}
    </ListCard>
  );
}

/**
 * Amendment requests, open ones first by deadline. With `clientId`, only that client's, and
 * staff can record one on the client's behalf. `highlightId` marks the request a notification
 * linked to.
 */
export function AmendmentList({ clientId, highlightId }: { clientId?: number; highlightId?: number }) {
  const [status, setStatus] = useState<StatusChoice<AmendmentStatus>>(initialStatus(clientId, highlightId));
  const [creating, setCreating] = useState(false);
  const filters: AmendmentFilters = {
    ...(status === 'all' ? {} : { status }),
    ...(clientId === undefined ? {} : { client_id: clientId }),
  };
  const amendments = useQuery({ queryKey: recordKeys.amendmentList(filters), queryFn: () => recordsApi.amendments(filters) });
  const items = byDeadline(amendments.data ?? []);
  return (
    <ListCard
      title="Amendment requests"
      description="Clients may ask to amend their record. Decide within 60 days: accepting adds an addendum to the note."
      actions={
        <>
          <StatusFilter value={status} labels={AMENDMENT_STATUS_LABELS} label="Show amendments" onChange={setStatus} />
          {clientId !== undefined && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Record amendment request
            </Button>
          )}
        </>
      }
    >
      {amendments.isPending && <SectionSpinner />}
      {amendments.isError && <ErrorState error={amendments.error} onRetry={() => void amendments.refetch()} />}
      {amendments.data && items.length === 0 && (
        <EmptyState icon={<FilePen />} title={status === 'open' ? 'No open amendment requests' : 'No amendment requests'} />
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-sage-100" aria-label="Amendment requests">
          {items.map((amendment) => (
            <AmendmentItem
              key={amendment.id}
              amendment={amendment}
              showClient={clientId === undefined}
              highlighted={amendment.id === highlightId}
            />
          ))}
        </ul>
      )}
      {creating && clientId !== undefined && <NewAmendmentModal clientId={clientId} onClose={() => setCreating(false)} />}
    </ListCard>
  );
}
