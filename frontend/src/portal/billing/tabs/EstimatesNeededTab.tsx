import { useQuery } from '@tanstack/react-query';
import { FileCheck2 } from 'lucide-react';
import { estimateKeys, estimatesApi, type EstimateNeed } from '../../../api/estimates';
import { formatDateTime, formatPlainDate, fullName } from '../../../lib/format';
import { LinkButton } from '../../../ui/Button';
import { Badge, EmptyState, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { ESTIMATE_REASON_LABELS } from '../../estimates/estimateHelpers';
import { usePracticeDay } from '../hooks';

function estimatesLink(need: EstimateNeed): string {
  return `/portal/clients/${need.client.id}?tab=estimates`;
}

function DueDate({ need }: { need: EstimateNeed }) {
  if (!need.due_on) return <span className="text-sage-500">No due date</span>;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${need.overdue ? 'font-medium text-red-700' : ''}`}>
      {formatPlainDate(need.due_on)}
      {need.overdue && <Badge tone="danger">Overdue</Badge>}
    </span>
  );
}

function sessionsText(need: EstimateNeed): string {
  if (need.uncovered_sessions === 0) return 'None scheduled';
  return `${need.uncovered_sessions} ${need.uncovered_sessions === 1 ? 'session' : 'sessions'} not covered`;
}

/** The work queue: self-pay clients who need a (new) good faith estimate, soonest due first. */
export function EstimatesNeededTab() {
  const { timeZone } = usePracticeDay();
  const needed = useQuery({ queryKey: estimateKeys.needed, queryFn: estimatesApi.needed });

  if (needed.isLoading) return <SectionSpinner />;
  if (needed.isError) return <ErrorState error={needed.error} onRetry={() => needed.refetch()} />;
  const rows = needed.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<FileCheck2 />}
        title="No estimates needed"
        description="Self-pay clients with scheduled care, and clients who ask for an estimate, show up here with a due date."
      />
    );
  }
  const overdue = rows.filter((row) => row.overdue).length;

  return (
    <div>
      <p className="border-b border-sage-100 px-4 py-3 text-sm text-sage-600 sm:px-5">
        Good faith estimates are due 1 business day after scheduling care 3 or more business days out (3 business days when
        it's 10 or more out, or when a client asks), and updates are due 1 business day before the next session.
        {overdue > 0 && (
          <span className="ml-1 font-medium text-red-700">
            {overdue} {overdue === 1 ? 'is' : 'are'} overdue.
          </span>
        )}
      </p>
      <div className="hidden md:block">
        <Table>
          <thead>
            <tr>
              <Th>Client</Th>
              <Th>Clinician</Th>
              <Th>Why</Th>
              <Th>Due</Th>
              <Th>Upcoming sessions</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sage-100">
            {rows.map((need) => (
              <tr key={`${need.client.id}-${need.clinician_id}`} className={need.overdue ? 'bg-red-50/40' : undefined}>
                <Td className="font-medium text-sage-900">{fullName(need.client)}</Td>
                <Td>{need.clinician_name}</Td>
                <Td>{ESTIMATE_REASON_LABELS[need.reason]}</Td>
                <Td className="whitespace-nowrap">
                  <DueDate need={need} />
                </Td>
                <Td>
                  {sessionsText(need)}
                  {need.next_session_at && (
                    <span className="block text-xs text-sage-500">Next {formatDateTime(need.next_session_at, timeZone)}</span>
                  )}
                </Td>
                <Td className="text-right">
                  <LinkButton
                    to={estimatesLink(need)}
                    size="sm"
                    variant={need.estimate_id !== null ? 'secondary' : 'primary'}
                    aria-label={`${need.estimate_id !== null ? 'Open draft' : 'Start estimate'} for ${fullName(need.client)}`}
                  >
                    {need.estimate_id !== null ? 'Open draft' : 'Start estimate'}
                  </LinkButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y divide-sage-100 md:hidden">
        {rows.map((need) => (
          <li key={`${need.client.id}-${need.clinician_id}`} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sage-900">{fullName(need.client)}</span>
              <DueDate need={need} />
            </div>
            <p className="text-sage-600">
              {need.clinician_name} · {ESTIMATE_REASON_LABELS[need.reason]} · {sessionsText(need)}
            </p>
            <LinkButton to={estimatesLink(need)} size="sm" variant="secondary">
              {need.estimate_id !== null ? 'Open draft' : 'Start estimate'}
            </LinkButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
