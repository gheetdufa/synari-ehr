import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { SECURITY_EVENTS_PAGE_SIZE, securityApi, securityKeys, type SecurityEvent } from '../../../api/security';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Badge, EmptyState, ErrorState, Tabs } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { SEVERITY_LABELS, SEVERITY_TONES } from './securityText';

type Filter = 'review' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'review', label: 'Needs review' },
  { id: 'all', label: 'All' },
];

function EventRow({
  event,
  timeZone,
  acknowledging,
  onAcknowledge,
}: {
  event: SecurityEvent;
  timeZone: string;
  acknowledging: boolean;
  onAcknowledge: () => void;
}) {
  const when = (
    <time dateTime={event.created_at} className="whitespace-nowrap">
      {formatDateTime(event.created_at, timeZone)}
    </time>
  );
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm sm:flex-nowrap">
      <Badge tone={SEVERITY_TONES[event.severity]}>{SEVERITY_LABELS[event.severity]}</Badge>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sage-900">{event.label}</p>
        <p className="text-xs text-sage-500">
          {event.staff_name ? (
            <>
              {event.staff_name} · {when}
            </>
          ) : (
            when
          )}
        </p>
        {event.acknowledged_at && (
          <p className="mt-0.5 text-xs text-sage-500">
            Reviewed by {event.acknowledged_by_name || 'a team member'} · {formatDateTime(event.acknowledged_at, timeZone)}
          </p>
        )}
      </div>
      {!event.acknowledged_at && (
        <Button
          variant="secondary"
          size="sm"
          loading={acknowledging}
          aria-label={`Acknowledge: ${event.label}`}
          onClick={onAcknowledge}
        >
          Acknowledge
        </Button>
      )}
    </li>
  );
}

/** Alerts such as repeated failed sign-ins or emergency chart access, newest first. */
export function SecurityEventsCard() {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('review');
  const needsReview = filter === 'review';
  const events = useInfiniteQuery({
    queryKey: securityKeys.eventList(needsReview),
    queryFn: ({ pageParam }) => securityApi.events(needsReview, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === SECURITY_EVENTS_PAGE_SIZE ? lastPage[lastPage.length - 1].id : undefined,
  });
  const list = events.data?.pages.flat() ?? [];

  const acknowledge = useMutation({
    mutationFn: (event: SecurityEvent) => securityApi.acknowledgeEvent(event.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: securityKeys.events });
      toast.success('Marked as reviewed');
    },
    onError: (error) => toast.error(error),
  });

  return (
    <Card>
      <CardHeader
        title="Security events"
        description="Sign-in and access alerts that may need a look, such as repeated failed sign-ins or emergency access to a chart."
      />
      <div className="px-5 pt-2">
        <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />
      </div>
      {events.isPending && <SectionSpinner />}
      {events.isError && <ErrorState error={events.error} onRetry={() => void events.refetch()} />}
      {events.data && list.length === 0 && (
        <EmptyState
          icon={needsReview ? <ShieldCheck /> : <ShieldAlert />}
          title={needsReview ? 'Nothing needs review' : 'No security events yet'}
          description={needsReview ? "You're all caught up. New alerts show up here." : 'Alerts about sign-ins and access show up here.'}
        />
      )}
      {list.length > 0 && (
        <>
          <ul className="divide-y divide-sage-100">
            {list.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                timeZone={staff.time_zone}
                acknowledging={acknowledge.isPending && acknowledge.variables?.id === event.id}
                onAcknowledge={() => acknowledge.mutate(event)}
              />
            ))}
          </ul>
          {events.hasNextPage && (
            <div className="flex justify-center border-t border-sage-100 px-5 py-3">
              <Button
                variant="secondary"
                size="sm"
                loading={events.isFetchingNextPage}
                onClick={() => void events.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
