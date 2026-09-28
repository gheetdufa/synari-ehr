import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { clientKeys, clientsApi } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { AuditEventList } from '../settings/AuditEventList';

/**
 * Who viewed or changed this client's record, newest first (from the practice's tamper-evident
 * audit log). Opening it is itself recorded.
 */
export default function ClientAccessHistoryTab({ clientId }: { clientId: number }) {
  const { staff } = useSession();
  const history = useInfiniteQuery({
    queryKey: clientKeys.accessHistory(clientId),
    queryFn: ({ pageParam }) => clientsApi.accessHistory(clientId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchOnWindowFocus: false,
  });
  const events = history.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <Card>
      <CardHeader
        title="Access history"
        description="Everyone who viewed or changed this client's record, including the client in their portal. Times are in your time zone."
      />
      {history.isPending && <SectionSpinner />}
      {history.isError && <ErrorState error={history.error} onRetry={() => void history.refetch()} />}
      {history.data && events.length === 0 && <EmptyState icon={<History />} title="No access recorded yet" />}
      {events.length > 0 && (
        <>
          <AuditEventList
            events={events}
            timeZone={staff.time_zone}
            currentStaffId={staff.id}
            showClient={false}
            label="Access history"
          />
          <div className="flex justify-center border-t border-sage-100 px-5 py-3">
            {history.hasNextPage ? (
              <Button
                variant="secondary"
                size="sm"
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Load more
              </Button>
            ) : (
              <p className="text-xs text-sage-500">That&apos;s everything.</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
